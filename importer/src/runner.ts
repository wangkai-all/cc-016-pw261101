import path from 'node:path';
import fs from 'node:fs';
import { SiteDriver, DriverConfig } from './driver.js';
import { db, logEvent, setRecord } from './db.js';
import { validatePayload, AppointmentPayload } from './csv.js';

interface RunnerState { paused: boolean; running: boolean }
const runners = new Map<number, RunnerState>();

const SHOT_DIR = path.resolve(process.cwd(), 'data', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

export function batchState(batchId: number): RunnerState {
  return runners.get(batchId) ?? { paused: false, running: false };
}

export function pauseBatch(batchId: number) {
  const s = runners.get(batchId);
  if (s) s.paused = true;
}

export function isRunning(batchId: number) {
  return runners.get(batchId)?.running ?? false;
}

export function startBatch(batchId: number, cfg: DriverConfig) {
  const state = runners.get(batchId) ?? { paused: false, running: false };
  runners.set(batchId, state);
  if (state.running) return false;
  state.running = true;
  state.paused = false;
  db.prepare(`UPDATE batches SET status='running' WHERE id=?`).run(batchId);
  // 后台跑，不阻塞 HTTP 响应
  void runLoop(batchId, cfg, state).finally(() => { state.running = false; });
  return true;
}

async function runLoop(batchId: number, cfg: DriverConfig, state: RunnerState) {
  const driver = new SiteDriver(cfg);
  const pending = () => db.prepare(
    `SELECT * FROM records WHERE batch_id=? AND status='pending' ORDER BY seq`).all(batchId) as any[];

  logEvent(batchId, null, 'batch', `批次 #${batchId} 开始执行`);
  try {
    await driver.init();
    while (true) {
      if (state.paused) {
        logEvent(batchId, null, 'batch', '批次已暂停（可在操作页继续）');
        db.prepare(`UPDATE batches SET status='paused' WHERE id=?`).run(batchId);
        return;
      }
      const recs = pending();
      if (recs.length === 0) break;
      for (const rec of recs) {
        if (state.paused) break;
        await processOne(driver, batchId, rec);
      }
    }
    db.prepare(`UPDATE batches SET status='done' WHERE id=?`).run(batchId);
    logEvent(batchId, null, 'batch', `批次 #${batchId} 执行完毕`);
  } catch (e: any) {
    logEvent(batchId, null, 'error', `批次异常中断：${e?.message ?? e}`);
    db.prepare(`UPDATE batches SET status='paused' WHERE id=?`).run(batchId);
  } finally {
    await driver.close();
  }
}

async function processOne(driver: SiteDriver, batchId: number, rec: any) {
  const ev = (kind: string, message: string) => logEvent(batchId, rec.id, kind, message);
  const p: AppointmentPayload = JSON.parse(rec.payload_json);
  setRecord(rec.id, { status: 'running', error: null });
  ev('batch', `—— 开始录入第 ${rec.seq} 条（流水号 ${p.serial}）——`);

  // 1) 本地校验
  const errs = validatePayload(p);
  if (errs.length > 0) {
    for (const e of errs) ev('validate', `校验失败：${e}`);
    setRecord(rec.id, { status: 'error', error: `本地校验未通过：${errs.join('；')}` });
    ev('error', '本条字段不合规，按规则跳过，继续后续预约');
    return;
  }
  ev('validate', '本地校验通过');

  // 2) 提交前查重：进程中断恢复（verify_before_submit）或本系统已有成功记录（重复导入）
  const seenDone = db.prepare(
    `SELECT id, batch_id FROM records WHERE serial=? AND status='done' AND batch_id != ? LIMIT 1`,
  ).get(p.serial, batchId) as any;
  if (rec.verify_before_submit === 1 || seenDone) {
    const why = rec.verify_before_submit === 1 ? '进程中断恢复' : `流水号已在批次 #${seenDone.batch_id} 成功录入`;
    ev('dedupe', `${why}，提交前先按流水号查列表确认`);
    const found = await driver.lookupBySerial(p.serial, ev);
    if (found) {
      const receipt = await driver.openReceipt(found.url);
      setRecord(rec.id, {
        status: 'duplicate', appointment_id: found.id, receipt_url: found.url,
        receipt_json: JSON.stringify(receipt), verify_before_submit: 0,
        error: '网站已存在该流水号，未重复提交',
      });
      ev('dedupe', `列表查到预约 #${found.id}，本条标记为重复，不重复提交`);
      return;
    }
    ev('dedupe', '列表未查到该流水号，确认未创建，继续正常录入');
    setRecord(rec.id, { verify_before_submit: 0 });
  }

  // 3) 页面录入
  try {
    const result = await driver.fillAndSubmit(p, ev);
    if (result.outcome === 'done') {
      setRecord(rec.id, {
        status: 'done', appointment_id: result.appointmentId,
        receipt_url: result.receiptUrl, receipt_json: JSON.stringify(result.receipt),
        attempts: rec.attempts + 1,
      });
      ev('receipt', `录入成功，回执：${result.receiptUrl}${result.recovered ? '（连接中断后经列表查询确认）' : ''}`);
    } else if (result.outcome === 'duplicate') {
      setRecord(rec.id, {
        status: 'duplicate', appointment_id: result.appointmentId,
        receipt_url: result.receiptUrl,
        receipt_json: result.receipt ? JSON.stringify(result.receipt) : null,
        error: '网站已存在该流水号，未重复提交',
      });
    } else {
      const shot = path.join(SHOT_DIR, `rec-${rec.id}-${Date.now()}.png`);
      await driver.screenshot(shot);
      setRecord(rec.id, { status: 'error', error: result.error, attempts: rec.attempts + 1 });
      ev('error', `本条录入失败：${result.error}（截图 ${path.basename(shot)}），继续后续预约`);
    }
  } catch (e: any) {
    const shot = path.join(SHOT_DIR, `rec-${rec.id}-${Date.now()}.png`);
    await driver.screenshot(shot);
    setRecord(rec.id, { status: 'error', error: `未预期错误：${e?.message ?? e}`, attempts: rec.attempts + 1 });
    ev('error', `本条发生未预期错误：${e?.message ?? e}（截图 ${path.basename(shot)}），继续后续预约`);
  }
}
