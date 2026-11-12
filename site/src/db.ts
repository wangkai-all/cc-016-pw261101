import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'site.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  date TEXT NOT NULL,
  time_range TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  UNIQUE(route_id, date, time_range)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT UNIQUE NOT NULL,
  route_id INTEGER NOT NULL REFERENCES routes(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  date TEXT NOT NULL,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  plate TEXT NOT NULL,
  driver TEXT NOT NULL,
  phone TEXT NOT NULL,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS appointment_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('装','卸')),
  address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function getSetting(key: string, fallback = 'off'): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** 读取开关；mode 为 once 时消费掉（自动回到 off）。返回本次是否触发。 */
export function consumeSwitch(key: string): boolean {
  const v = getSetting(key, 'off');
  if (v === 'off') return false;
  if (v === 'once') setSetting(key, 'off');
  return true; // 'once' 或 'on' 都触发
}

export function seed() {
  const hasUser = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (hasUser.c > 0) return;

  db.prepare('INSERT INTO users(username, password) VALUES (?, ?)').run('demo', 'demo123');

  const routes = ['华东干线', '华南干线', '西北干线'];
  const warehouses: Record<string, string[]> = {
    华东干线: ['上海青浦仓', '苏州工业园仓', '杭州萧山仓'],
    华南干线: ['广州黄埔仓', '深圳龙华仓'],
    西北干线: ['西安国际港仓', '兰州安宁仓'],
  };
  const timeRanges = ['08:00-10:00', '10:00-12:00', '13:00-15:00', '15:00-17:00'];
  // 演示日期窗口：今天起 7 天
  const dates: string[] = [];
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const insRoute = db.prepare('INSERT INTO routes(name) VALUES (?)');
  const insWh = db.prepare('INSERT INTO warehouses(route_id, name) VALUES (?, ?)');
  const insSlot = db.prepare('INSERT INTO slots(route_id, date, time_range, capacity) VALUES (?, ?, ?, ?)');

  for (const r of routes) {
    const { lastInsertRowid: rid } = insRoute.run(r);
    for (const w of warehouses[r]) insWh.run(Number(rid), w);
    for (const date of dates) {
      for (const tr of timeRanges) {
        // 默认容量 5；故意留几个特殊容量用于演示：
        //  - 华东干线 第1天 08:00-10:00 容量 0（永远约满 → 录入时报"时段已满"）
        //  - 华东干线 第1天 10:00-12:00 容量 1（配合"提交前容量变化"开关）
        let cap = 5;
        if (r === '华东干线' && date === dates[0] && tr === '08:00-10:00') cap = 0;
        if (r === '华东干线' && date === dates[0] && tr === '10:00-12:00') cap = 1;
        insSlot.run(Number(rid), date, tr, cap);
      }
    }
  }
  console.log('[site] seeded. demo/demo123, dates:', dates.join(', '));
}

export function slotRemaining(slotId: number): number {
  const slot = db.prepare('SELECT capacity FROM slots WHERE id = ?').get(slotId) as { capacity: number } | undefined;
  if (!slot) return 0;
  const used = db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE slot_id = ?').get(slotId) as { c: number };
  return slot.capacity - used.c;
}
