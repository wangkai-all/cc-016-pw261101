import './env.js'; // 必须最先导入（设置 PLAYWRIGHT_BROWSERS_PATH）
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';

import { db, logEvent, recoverInterrupted } from './db.js';
import { parseAppointmentsCsv } from './csv.js';
import { startBatch, pauseBatch, isRunning } from './runner.js';

const PORT = Number(process.env.IMPORTER_PORT || 4301);
const SITE_URL = process.env.SITE_URL || 'http://localhost:4300';
const SITE_USER = process.env.SITE_USER || 'demo';
const SITE_PASS = process.env.SITE_PASS || 'demo123';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 进程重启：把中断的记录恢复为待处理
const recovered = recoverInterrupted();
if (recovered > 0) console.log(`[importer] 恢复 ${recovered} 条中断记录`);

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const driverCfg = {
  siteUrl: SITE_URL,
  username: SITE_USER,
  password: SITE_PASS,
  headless: process.env.HEADLESS !== '0',
  slowMo: Number(process.env.SLOW_MO || 30),
};

// ---------- 批次 ----------
app.get('/api/meta', (_req, res) => {
  res.json({ siteUrl: SITE_URL, demoUrl: `${SITE_URL}/demo` });
});

app.get('/api/batches', (_req, res) => {
  const batches = db.prepare(`
    SELECT b.*,
      SUM(CASE WHEN r.status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) AS error,
      SUM(CASE WHEN r.status='duplicate' THEN 1 ELSE 0 END) AS duplicate,
      SUM(CASE WHEN r.status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN r.status='running' THEN 1 ELSE 0 END) AS running,
      COUNT(r.id) AS total
    FROM batches b LEFT JOIN records r ON r.batch_id = b.id
    GROUP BY b.id ORDER BY b.id DESC`).all() as any[];
  for (const b of batches) b.live_running = isRunning(b.id);
  res.json(batches);
});

app.post('/api/batches', upload.single('file'), (req, res) => {
  try {
    let csvText: string;
    let csvPath: string;
    let name = String(req.body?.name ?? '').trim();

    if (req.file) {
      csvText = req.file.buffer.toString('utf8');
      csvPath = path.join(UPLOAD_DIR, `${Date.now()}-${req.file.originalname}`);
      fs.writeFileSync(csvPath, csvText);
      if (!name) name = req.file.originalname;
    } else if (req.body?.csv_path) {
      csvPath = path.resolve(String(req.body.csv_path));
      csvText = fs.readFileSync(csvPath, 'utf8');
      if (!name) name = path.basename(csvPath);
    } else {
      res.status(400).json({ error: '请上传 CSV 文件或提供 csv_path' });
      return;
    }

    const rows = parseAppointmentsCsv(csvText);
    if (rows.length === 0) { res.status(400).json({ error: 'CSV 没有数据行' }); return; }

    db.exec('BEGIN');
    const r = db.prepare('INSERT INTO batches(name, csv_path) VALUES (?, ?)').run(name, csvPath);
    const batchId = Number(r.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO records(batch_id, seq, serial, payload_json, status, error)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      if (row.parseError) {
        ins.run(batchId, row.seq, row.serial || `(第${row.seq}行)`, JSON.stringify(row.raw), 'error', `CSV 解析失败：${row.parseError}`);
        logEvent(batchId, null, 'validate', `第 ${row.seq} 行 CSV 解析失败：${row.parseError}`);
      } else {
        ins.run(batchId, row.seq, row.serial, JSON.stringify(row.payload), 'pending', null);
      }
    }
    db.exec('COMMIT');
    logEvent(batchId, null, 'batch', `导入 CSV：${rows.length} 条记录（${rows.filter(x => x.parseError).length} 条解析失败）`);
    res.json({ id: batchId, total: rows.length });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

app.get('/api/batches/:id', (req, res) => {
  const id = Number(req.params.id);
  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(id);
  if (!batch) { res.status(404).json({ error: '批次不存在' }); return; }
  const records = db.prepare('SELECT * FROM records WHERE batch_id=? ORDER BY seq').all(id) as any[];
  res.json({ batch, records, live_running: isRunning(id) });
});

app.get('/api/batches/:id/events', (req, res) => {
  const id = Number(req.params.id);
  const afterId = Number(req.query.after_id ?? 0);
  const recordId = req.query.record_id ? Number(req.query.record_id) : null;
  const rows = (recordId
    ? db.prepare('SELECT * FROM events WHERE batch_id=? AND record_id=? AND id>? ORDER BY id LIMIT 500').all(id, recordId, afterId)
    : db.prepare('SELECT * FROM events WHERE batch_id=? AND id>? ORDER BY id LIMIT 500').all(id, afterId)) as any[];
  res.json(rows);
});

app.post('/api/batches/:id/start', (req, res) => {
  const id = Number(req.params.id);
  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(id) as any;
  if (!batch) { res.status(404).json({ error: '批次不存在' }); return; }
  const started = startBatch(id, driverCfg);
  res.json({ started });
});

app.post('/api/batches/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  pauseBatch(id);
  res.json({ paused: true });
});

// 重新跑失败/跳过的记录（重置为 pending）
app.post('/api/batches/:id/retry-errors', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare(`UPDATE records SET status='pending', error=NULL WHERE batch_id=? AND status='error'`).run(id);
  res.json({ reset: r.changes });
});

// ---------- 静态资源（React 操作台） ----------
const distDir = path.resolve(process.cwd(), 'web/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('web/dist 未构建，请先运行 npm run build:web'));
}

app.listen(PORT, () => {
  console.log(`[importer] 录入服务 http://localhost:${PORT}  (目标网站 ${SITE_URL})`);
});
