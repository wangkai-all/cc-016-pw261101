import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, seed, getSetting, setSetting, consumeSwitch, slotRemaining } from './db.js';
import * as v from './views.js';

const PORT = Number(process.env.SITE_PORT || 4300);
seed();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.resolve(process.cwd(), 'site/public')));

// ---------- 会话 ----------
const SESSION_TTL = 2 * 3600 * 1000;

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req: Request): string | null {
  const token = parseCookies(req)['sid'];
  if (!token) return null;
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token = ?').get(token) as
    | { username: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row.username;
}

function destroySession(req: Request) {
  const token = parseCookies(req)['sid'];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthorized' });
    } else {
      res.redirect('/login?expired=1');
    }
    return;
  }
  (req as any).user = user;
  next();
}

// ---------- 认证页 ----------
app.get('/login', (req, res) => {
  res.send(v.loginPage('', req.query.expired === '1'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const row = db.prepare('SELECT password FROM users WHERE username = ?').get(String(username ?? '')) as
    | { password: string } | undefined;
  if (!row || row.password !== String(password ?? '')) {
    res.status(401).send(v.loginPage('用户名或密码错误'));
    return;
  }
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions(token, username, expires_at) VALUES (?, ?, ?)').run(token, String(username), Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect('/appointments');
});

app.post('/logout', (req, res) => {
  destroySession(req);
  res.redirect('/login');
});

// ---------- 页面 ----------
app.get('/', requireAuth, (_req, res) => res.redirect('/appointments'));

app.get('/appointments', requireAuth, (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = (q
    ? db.prepare(`
        SELECT a.id, a.serial, r.name AS route, w.name AS warehouse, a.date, s.time_range,
               a.driver, a.plate, a.created_at
        FROM appointments a
        JOIN routes r ON r.id = a.route_id
        JOIN warehouses w ON w.id = a.warehouse_id
        JOIN slots s ON s.id = a.slot_id
        WHERE a.serial LIKE ? ORDER BY a.id DESC LIMIT 200`).all(`%${q}%`)
    : db.prepare(`
        SELECT a.id, a.serial, r.name AS route, w.name AS warehouse, a.date, s.time_range,
               a.driver, a.plate, a.created_at
        FROM appointments a
        JOIN routes r ON r.id = a.route_id
        JOIN warehouses w ON w.id = a.warehouse_id
        JOIN slots s ON s.id = a.slot_id
        ORDER BY a.id DESC LIMIT 200`).all()) as unknown as v.AppointmentRow[];
  res.send(v.listPage(rows, q, (req as any).user));
});

app.get('/appointments/new', requireAuth, (req, res) => {
  const routes = db.prepare('SELECT id, name FROM routes ORDER BY id').all() as unknown as v.RouteOpt[];
  res.send(v.newPage(routes, (req as any).user));
});

function loadDetail(id: number): v.DetailData | null {
  const a = db.prepare(`
    SELECT a.id, a.serial, a.date, a.plate, a.driver, a.phone, a.remark, a.created_at,
           r.name AS route, w.name AS warehouse, s.time_range
    FROM appointments a
    JOIN routes r ON r.id = a.route_id
    JOIN warehouses w ON w.id = a.warehouse_id
    JOIN slots s ON s.id = a.slot_id
    WHERE a.id = ?`).get(id) as any;
  if (!a) return null;
  const stops = db.prepare('SELECT seq, kind, address FROM appointment_stops WHERE appointment_id = ? ORDER BY seq').all(id) as unknown as v.StopRow[];
  return { ...a, stops };
}

app.get('/appointments/:id/confirm', requireAuth, (req, res) => {
  const d = loadDetail(Number(req.params.id));
  if (!d) { res.status(404).send(v.errorPage('未找到预约', `ID ${req.params.id} 不存在`, (req as any).user, 404)); return; }
  res.send(v.confirmPage(d, (req as any).user));
});

app.get('/appointments/:id', requireAuth, (req, res) => {
  const d = loadDetail(Number(req.params.id));
  if (!d) { res.status(404).send(v.errorPage('未找到预约', `ID ${req.params.id} 不存在`, (req as any).user, 404)); return; }
  res.send(v.detailPage(d, (req as any).user));
});

// ---------- 线路联动数据（仅供本站表单页面使用） ----------
app.get('/api/options', requireAuth, (req, res) => {
  // 演示开关：填到一半登录失效 —— 表单加载联动数据时会话被注销
  if (consumeSwitch('sw_session_kill')) {
    destroySession(req);
    res.status(401).json({ error: 'session_killed', message: '登录已过期' });
    return;
  }
  const routeId = Number(req.query.route_id);
  const date = String(req.query.date ?? '');
  const warehouses = db.prepare('SELECT id, name FROM warehouses WHERE route_id = ? ORDER BY id').all(routeId);
  let slots: unknown[] = [];
  if (date) {
    slots = (db.prepare('SELECT id, time_range, capacity FROM slots WHERE route_id = ? AND date = ? ORDER BY id').all(routeId, date) as any[])
      .map(s => ({ id: s.id, time_range: s.time_range, remaining: slotRemaining(s.id) }));
  }
  res.json({ warehouses, slots });
});

// ---------- 创建预约 ----------
const PLATE_RE = /^[一-龥][A-Z][A-Z0-9]{5,6}$/;
const PHONE_RE = /^1\d{10}$/;

app.post('/appointments', requireAuth, (req, res) => {
  const user = (req as any).user;
  const b = req.body ?? {};
  const serial = String(b.serial ?? '').trim();
  const routeId = Number(b.route_id);
  const warehouseId = Number(b.warehouse_id);
  const date = String(b.date ?? '').trim();
  const slotId = Number(b.slot_id);
  const plate = String(b.plate ?? '').trim();
  const driver = String(b.driver ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const remark = String(b.remark ?? '').trim();

  let stops: { seq: number; kind: string; address: string }[] = [];
  try {
    stops = JSON.parse(String(b.stops_json ?? '[]'));
    if (!Array.isArray(stops)) stops = [];
  } catch { stops = []; }

  // ---- 服务端校验 ----
  const errors: string[] = [];
  if (!serial) errors.push('业务流水号必填');
  if (serial.length > 64) errors.push('业务流水号过长');
  const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(routeId);
  if (!route) errors.push('线路不存在');
  const wh = db.prepare('SELECT id FROM warehouses WHERE id = ? AND route_id = ?').get(warehouseId, routeId);
  if (!wh) errors.push('仓库不存在或不属于所选线路');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('预约日期格式不正确');
  const slot = db.prepare('SELECT id FROM slots WHERE id = ? AND route_id = ? AND date = ?').get(slotId, routeId, date);
  if (!slot) errors.push('时段不存在或不属于所选线路与日期');
  if (!PLATE_RE.test(plate)) errors.push('车牌号格式不正确（如 沪A12345）');
  if (!driver) errors.push('司机姓名必填');
  if (!PHONE_RE.test(phone)) errors.push('司机电话须为 11 位手机号');
  if (stops.length === 0) errors.push('至少需要一个装卸点');
  stops.forEach((s, i) => {
    if (s.kind !== '装' && s.kind !== '卸') errors.push(`第 ${i + 1} 个装卸点类型不正确`);
    if (!String(s.address ?? '').trim()) errors.push(`第 ${i + 1} 个装卸点地址为空`);
  });

  if (errors.length > 0) {
    const routes = db.prepare('SELECT id, name FROM routes ORDER BY id').all() as unknown as v.RouteOpt[];
    res.status(400).send(v.newPage(routes, user, errors, { serial, date, plate, driver, phone, remark }));
    return;
  }

  // ---- 演示开关：提交前容量变化 ----
  if (consumeSwitch('sw_capacity_shrink')) {
    res.status(409).send(v.errorPage('时段已满', '提交前容量发生变化：所选时段刚刚被约满，本次提交未生效。', user, 409));
    return;
  }

  // ---- 容量检查 ----
  if (slotRemaining(slotId) <= 0) {
    res.status(409).send(v.errorPage('时段已满', '所选时段已约满，请选择其他时段。', user, 409));
    return;
  }

  // ---- 写入（流水号唯一约束兜底防重复） ----
  let appointmentId: number;
  try {
    db.exec('BEGIN');
    const r = db.prepare(`
      INSERT INTO appointments(serial, route_id, warehouse_id, date, slot_id, plate, driver, phone, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(serial, routeId, warehouseId, date, slotId, plate, driver, phone, remark);
    appointmentId = Number(r.lastInsertRowid);
    const insStop = db.prepare('INSERT INTO appointment_stops(appointment_id, seq, kind, address) VALUES (?, ?, ?, ?)');
    stops.forEach((s, i) => insStop.run(appointmentId, i + 1, s.kind, String(s.address).trim()));
    db.exec('COMMIT');
  } catch (e: any) {
    db.exec('ROLLBACK');
    if (String(e?.message ?? '').includes('UNIQUE')) {
      res.status(409).send(v.errorPage('业务流水号已存在', `流水号 ${serial} 已存在，请勿重复提交。`, user, 409));
      return;
    }
    throw e;
  }

  // ---- 演示开关：创建成功却没打开确认页（预约已提交，响应在半路坏掉） ----
  if (consumeSwitch('sw_confirm_drop')) {
    // 返回一个不完整的 502 后掐断连接：浏览器不会自动重试，只能看到错误页
    res.socket?.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    res.socket?.destroy();
    return;
  }

  res.redirect(`/appointments/${appointmentId}/confirm`);
});

// ---------- 演示开关 ----------
const SWITCH_KEYS = ['sw_capacity_shrink', 'sw_session_kill', 'sw_confirm_drop'];

app.get('/demo', (req, res) => {
  const state: Record<string, string> = {};
  for (const k of SWITCH_KEYS) state[k] = getSetting(k, 'off');
  res.send(v.demoPage(state, currentUser(req) ?? undefined));
});

app.post('/demo', (req, res) => {
  for (const k of SWITCH_KEYS) {
    const val = String(req.body?.[k] ?? 'off');
    if (['off', 'once', 'on'].includes(val)) setSetting(k, val);
  }
  res.redirect('/demo');
});

app.listen(PORT, () => {
  console.log(`[site] 运输预约平台 http://localhost:${PORT}  (演示开关: http://localhost:${PORT}/demo)`);
});
