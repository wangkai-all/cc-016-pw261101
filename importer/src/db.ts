import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'importer.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  csv_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',      -- idle | running | paused | done
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,                     -- CSV 行序
  serial TEXT NOT NULL,
  payload_json TEXT NOT NULL,               -- 解析后的预约内容
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error | duplicate
  error TEXT,
  appointment_id INTEGER,                   -- 网站侧预约 ID
  receipt_url TEXT,                         -- 回执（详情页）URL
  receipt_json TEXT,                        -- 从确认页/详情页抓回的实际值快照
  attempts INTEGER NOT NULL DEFAULT 0,
  verify_before_submit INTEGER NOT NULL DEFAULT 0,  -- 提交前先按流水号查列表
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(batch_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_records_serial ON records(serial);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  record_id INTEGER,
  ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  kind TEXT NOT NULL,        -- validate|navigate|login|fill|select|wait|submit|dedupe|recover|receipt|error|batch
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_batch ON events(batch_id, id);
`);

export function logEvent(batchId: number, recordId: number | null, kind: string, message: string) {
  db.prepare('INSERT INTO events(batch_id, record_id, kind, message) VALUES (?, ?, ?, ?)')
    .run(batchId, recordId, kind, message);
}

export type RecordStatus = 'pending' | 'running' | 'done' | 'error' | 'duplicate';

export function setRecord(id: number, patch: Partial<{
  status: RecordStatus; error: string | null; appointment_id: number | null;
  receipt_url: string | null; receipt_json: string | null;
  attempts: number; verify_before_submit: number;
}>) {
  const cur = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as any;
  const next = { ...cur, ...patch };
  db.prepare(`UPDATE records SET status=?, error=?, appointment_id=?, receipt_url=?, receipt_json=?,
              attempts=?, verify_before_submit=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(next.status, next.error ?? null, next.appointment_id ?? null, next.receipt_url ?? null,
         next.receipt_json ?? null, next.attempts, next.verify_before_submit, id);
}

/** 进程重启恢复：上一进程可能死在录入中途，标回待处理并要求提交前先查列表 */
export function recoverInterrupted() {
  const stuck = db.prepare(`SELECT id, batch_id, serial FROM records WHERE status = 'running'`).all() as any[];
  for (const r of stuck) {
    db.prepare(`UPDATE records SET status='pending', verify_before_submit=1, updated_at=datetime('now','localtime') WHERE id=?`).run(r.id);
    logEvent(r.batch_id, r.id, 'recover', `检测到进程中断（流水号 ${r.serial}），恢复为待处理；重新提交前将先按流水号查列表确认`);
  }
  db.prepare(`UPDATE batches SET status='idle' WHERE status='running'`).run();
  return stuck.length;
}
