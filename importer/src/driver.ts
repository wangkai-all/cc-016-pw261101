import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { AppointmentPayload } from './csv.js';

export interface DriverConfig {
  siteUrl: string;
  username: string;
  password: string;
  headless?: boolean;
  slowMo?: number;
}

export type EventFn = (kind: string, message: string) => void;

export interface ReceiptSnapshot {
  id: number; serial: string; route: string; warehouse: string; date: string;
  time_range: string; plate: string; driver: string; phone: string; remark: string;
  stops: { seq: number; kind: string; address: string }[];
}

export type FillResult =
  | { outcome: 'done'; appointmentId: number; receiptUrl: string; receipt: ReceiptSnapshot; recovered: boolean }
  | { outcome: 'duplicate'; appointmentId: number | null; receiptUrl: string | null; receipt: ReceiptSnapshot | null }
  | { outcome: 'error'; error: string };

class SessionExpiredError extends Error {
  constructor() { super('会话已过期'); this.name = 'SessionExpiredError'; }
}

const MAX_SUBMIT_ATTEMPTS = 3;
const MAX_AUTH_RETRIES = 4;

export class SiteDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private cfg: DriverConfig) {}

  async init() {
    this.browser = await chromium.launch({
      headless: this.cfg.headless ?? true,
      slowMo: this.cfg.slowMo ?? 30,
    });
    this.context = await this.browser.newContext({ locale: 'zh-CN' });
    this.page = await this.context.newPage();
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null; this.context = null; this.page = null;
  }

  private get p(): Page {
    if (!this.page) throw new Error('driver 未初始化');
    return this.page;
  }

  async screenshot(path: string) {
    await this.p.screenshot({ path, fullPage: true }).catch(() => {});
  }

  // ---------- 登录 ----------
  async login(ev: EventFn) {
    await this.p.goto(`${this.cfg.siteUrl}/login`, { waitUntil: 'domcontentloaded' });
    await this.p.fill('#username', this.cfg.username);
    await this.p.fill('#password', this.cfg.password);
    await Promise.all([
      this.p.waitForURL(/\/appointments/, { timeout: 10000 }),
      this.p.click('#login-submit'),
    ]);
    ev('login', `登录成功（用户 ${this.cfg.username}），继续原批次`);
  }

  /** 当前不在登录态则登录 */
  private async ensureLoggedIn(ev: EventFn) {
    const url = this.p.url();
    if (url.includes('/login')) { await this.login(ev); return; }
    await this.p.goto(`${this.cfg.siteUrl}/appointments`, { waitUntil: 'domcontentloaded' });
    if (this.p.url().includes('/login')) await this.login(ev);
  }

  private throwIfLoginPage() {
    if (this.p.url().includes('/login')) throw new SessionExpiredError();
  }

  // ---------- 按流水号查列表 ----------
  /** 返回 {id, url}；未找到返回 null。会话失效时自动重登一次。 */
  async lookupBySerial(serial: string, ev: EventFn): Promise<{ id: number; url: string } | null> {
    for (let i = 0; i < 2; i++) {
      await this.p.goto(`${this.cfg.siteUrl}/appointments?q=${encodeURIComponent(serial)}`, { waitUntil: 'domcontentloaded' });
      if (this.p.url().includes('/login')) {
        ev('login', '查询列表时发现登录已过期，重新登录');
        await this.login(ev);
        continue;
      }
      break;
    }
    this.throwIfLoginPage();
    const row = this.p.locator(`tr[data-serial="${serial}"]`);
    if ((await row.count()) === 0) return null;
    const href = await row.locator('a.serial-link').getAttribute('href');
    if (!href) return null;
    const m = href.match(/\/appointments\/(\d+)/);
    if (!m) return null;
    return { id: Number(m[1]), url: new URL(href, this.cfg.siteUrl).toString() };
  }

  /** 打开详情页并抓取回执快照 */
  async openReceipt(url: string): Promise<ReceiptSnapshot> {
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });
    this.throwIfLoginPage();
    return this.parseReceiptFromPage();
  }

  private async parseReceiptFromPage(): Promise<ReceiptSnapshot> {
    const detail = this.p.locator('#appointment-detail');
    await detail.waitFor({ timeout: 8000 });
    const id = Number(await detail.getAttribute('data-appointment-id'));
    const field = async (n: string) =>
      ((await this.p.locator(`#appointment-detail dd[data-field="${n}"]`).textContent()) ?? '').trim();
    const stops = await this.p.locator('#stops-table tbody tr').evaluateAll(rows =>
      rows.map(r => ({
        seq: Number(r.getAttribute('data-seq') ?? r.children[0].textContent),
        kind: (r.children[1].textContent ?? '').trim(),
        address: (r.children[2].textContent ?? '').trim(),
      })));
    return {
      id,
      serial: await field('serial'),
      route: await field('route'),
      warehouse: await field('warehouse'),
      date: await field('date'),
      time_range: await field('time_range'),
      plate: await field('plate'),
      driver: await field('driver'),
      phone: await field('phone'),
      remark: await field('remark'),
      stops,
    };
  }

  // ---------- 主流程：填表 + 提交 ----------
  async fillAndSubmit(p: AppointmentPayload, ev: EventFn): Promise<FillResult> {
    for (let authAttempt = 1; authAttempt <= MAX_AUTH_RETRIES; authAttempt++) {
      try {
        await this.ensureLoggedIn(ev);
        await this.gotoNewForm(ev);
        const fillErr = await this.fillForm(p, ev);
        if (fillErr) return fillErr; // 字段级问题（线路/仓库/时段不合规）：记错并跳过本条
        return await this.submitWithRecovery(p, ev);
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          ev('login', `填到一半登录失效（第 ${authAttempt} 次），暂停本条，重新登录后继续`);
          await this.login(ev);
          continue; // 重填当前这条，批次不断
        }
        throw e;
      }
    }
    return { outcome: 'error', error: `重新登录 ${MAX_AUTH_RETRIES} 次后仍被踢出，放弃本条` };
  }

  private async gotoNewForm(ev: EventFn) {
    await this.p.goto(`${this.cfg.siteUrl}/appointments/new`, { waitUntil: 'domcontentloaded' });
    this.throwIfLoginPage();
    await this.p.waitForSelector('#appointment-form', { timeout: 8000 });
    ev('navigate', '打开「新建预约」页面');
  }

  /** 返回 null = 填写完成；返回 FillResult = 字段级错误，不应提交 */
  private async fillForm(p: AppointmentPayload, ev: EventFn): Promise<FillResult | null> {
    // 业务流水号
    await this.p.fill('#f-serial', p.serial);
    ev('fill', `填写业务流水号 = ${p.serial}`);

    // 线路（选择后才加载仓库与时段）
    const routeResp = this.p.waitForResponse(r => r.url().includes('/api/options'), { timeout: 8000 });
    try {
      await this.p.selectOption('#f-route', { label: p.route });
    } catch {
      routeResp.catch(() => {});
      return this.fieldError(`线路「${p.route}」不在可选项中`);
    }
    const rResp = await routeResp.catch(e => { this.throwIfLoginPage(); throw e; });
    if (rResp.status() === 401) throw new SessionExpiredError(); // 演示开关：填到一半登录失效
    ev('select', `选择线路 = ${p.route}（仓库与时段开始联动加载）`);
    await this.p.waitForFunction(
      () => document.querySelectorAll('#f-warehouse option').length > 1,
      { timeout: 8000 },
    );

    // 仓库
    try {
      await this.p.selectOption('#f-warehouse', { label: p.warehouse });
    } catch {
      return this.fieldError(`仓库「${p.warehouse}」不在线路「${p.route}」下`);
    }
    ev('select', `选择仓库 = ${p.warehouse}`);

    // 日期 → 触发时段加载
    await this.p.fill('#f-date', p.date);
    const dateResp = this.p.waitForResponse(r => r.url().includes('/api/options'), { timeout: 8000 });
    await this.p.locator('#f-date').evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
    ev('fill', `填写预约日期 = ${p.date}，等待时段加载`);
    const dResp = await dateResp.catch(e => { this.throwIfLoginPage(); throw e; });
    if (dResp.status() === 401) throw new SessionExpiredError();
    await this.p.waitForFunction(
      () => {
        const box = document.querySelector('#slot-list');
        return box && !box.textContent?.includes('加载中');
      },
      { timeout: 8000 },
    );

    // 时段
    const slotLoc = this.p.locator(`input[name="slot_id"][data-time-range="${p.slot}"]`);
    if ((await slotLoc.count()) === 0) {
      return this.fieldError(`线路该日期下不存在时段「${p.slot}」`);
    }
    if (await slotLoc.isDisabled()) {
      return this.fieldError(`时段「${p.slot}」已满（剩余 0），按规则不替换日期或仓库，本条记为错误`);
    }
    await slotLoc.check();
    ev('select', `选择时段 = ${p.slot}`);

    // 车辆与司机
    await this.p.fill('#f-plate', p.plate);
    await this.p.fill('#f-driver', p.driver);
    await this.p.fill('#f-phone', p.phone);
    if (p.remark) await this.p.fill('#f-remark', p.remark);
    ev('fill', `填写车牌=${p.plate} 司机=${p.driver} 电话=${p.phone}${p.remark ? ` 备注=${p.remark}` : ''}`);

    // 装卸点（严格按 CSV 顺序逐行添加）
    for (let i = 0; i < p.stops.length; i++) {
      if (i > 0) await this.p.click('#add-stop');
      const row = this.p.locator('.stop-row').nth(i);
      await row.locator('.stop-kind').selectOption({ label: p.stops[i].kind });
      await row.locator('.stop-address').fill(p.stops[i].address);
      ev('fill', `装卸点 ${i + 1}：${p.stops[i].kind} · ${p.stops[i].address}`);
    }
    return null; // null = 表单填写完成
  }

  private fieldError(message: string): FillResult {
    return { outcome: 'error', error: message };
  }

  private async submitWithRecovery(p: AppointmentPayload, ev: EventFn): Promise<FillResult> {
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      ev('submit', `点击「提交预约」（第 ${attempt}/${MAX_SUBMIT_ATTEMPTS} 次）`);
      let navError: unknown = null;
      try {
        await Promise.all([
          this.p.waitForURL(url => !url.pathname.endsWith('/new'), { timeout: 12000 }),
          this.p.click('#submit-btn'),
        ]);
      } catch (e) {
        navError = e; // 连接被掐断（演示开关）或超时都会落到这里
      }

      const url = this.p.url();

      // 1) 到达确认页
      if (/\/appointments\/\d+\/confirm/.test(url)) {
        const receipt = await this.parseReceiptFromPage();
        ev('receipt', `确认页打开成功，预约 #${receipt.id} 已创建`);
        return {
          outcome: 'done',
          appointmentId: receipt.id,
          receiptUrl: `${this.cfg.siteUrl}/appointments/${receipt.id}`,
          receipt,
          recovered: false,
        };
      }

      // 2) 被踢回登录页
      if (url.includes('/login')) throw new SessionExpiredError();

      // 3) 服务端错误页（时段已满 / 流水号已存在 等）
      if (await this.p.locator('#error-banner').count()) {
        const title = ((await this.p.locator('#error-banner').textContent()) ?? '').trim();
        const msg = ((await this.p.locator('#error-message').textContent()) ?? '').trim();
        if (title.includes('流水号已存在')) {
          const found = await this.lookupBySerial(p.serial, ev);
          ev('dedupe', `网站提示流水号已存在，列表查到预约 ${found ? `#${found.id}` : '(未找到)'}，本条标记为重复，不再提交`);
          return {
            outcome: 'duplicate',
            appointmentId: found?.id ?? null,
            receiptUrl: found?.url ?? null,
            receipt: found ? await this.openReceipt(found.url) : null,
          };
        }
        ev('error', `网站拒绝提交：${title} — ${msg}`);
        return { outcome: 'error', error: `${title}：${msg}` };
      }

      // 4) 服务端/前端校验把表单打回
      const serverErrs = await this.p.locator('#form-errors .field-error').allTextContents();
      if (serverErrs.length > 0) {
        ev('error', `服务端校验未通过：${serverErrs.join('；')}`);
        return { outcome: 'error', error: `服务端校验未通过：${serverErrs.join('；')}` };
      }
      const clientErrs = await this.p.locator('#client-errors .field-error').allTextContents();
      if (clientErrs.length > 0) {
        ev('error', `页面校验未通过：${clientErrs.join('；')}`);
        return { outcome: 'error', error: `页面校验未通过：${clientErrs.join('；')}` };
      }

      // 5) 没到达确认页（连接断开 / 确认页未打开）→ 先查列表再决定是否重提
      ev('recover', `提交后未到达确认页（${navError ? '连接中断' : '无跳转'}），先到预约列表按流水号 ${p.serial} 查结果`);
      const found = await this.lookupBySerial(p.serial, ev);
      if (found) {
        ev('dedupe', `列表查到流水号 ${p.serial}（预约 #${found.id}）：创建其实已成功，不重复提交`);
        const receipt = await this.openReceipt(found.url);
        return { outcome: 'done', appointmentId: found.id, receiptUrl: found.url, receipt, recovered: true };
      }
      ev('recover', `列表未查到流水号 ${p.serial}，确认未创建，重新填写并提交`);
      // 重新打开空白表单重填（页面状态已不可信）
      await this.gotoNewForm(ev);
      const fillErr = await this.fillForm(p, ev);
      if (fillErr) return fillErr;
    }
    return { outcome: 'error', error: `提交 ${MAX_SUBMIT_ATTEMPTS} 次均未确认成功` };
  }
}
