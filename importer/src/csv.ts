// CSV 解析：每行一条预约，装卸点写在 stops 列，用 | 分隔，顺序即 CSV 中的书写顺序
// 列：serial,route,warehouse,date,slot,plate,driver,phone,stops,remark
// stops 例： 装:上海市青浦区1号库|卸:苏州市工业园区2号门

export interface StopPayload { kind: '装' | '卸'; address: string }
export interface AppointmentPayload {
  serial: string; route: string; warehouse: string; date: string; slot: string;
  plate: string; driver: string; phone: string; remark: string; stops: StopPayload[];
}

export interface ParsedRow {
  seq: number;
  serial: string;
  payload: AppointmentPayload | null;
  parseError: string | null;
  raw: Record<string, string>;
}

/** 极简 RFC4180 解析（支持引号包裹与转义） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^﻿/, ''); // 去 BOM
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const EXPECTED = ['serial', 'route', 'warehouse', 'date', 'slot', 'plate', 'driver', 'phone', 'stops', 'remark'];

export function parseAppointmentsCsv(text: string): ParsedRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV 为空');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const missing = EXPECTED.filter(n => col(n) === -1);
  if (missing.length > 0) throw new Error(`CSV 缺少列: ${missing.join(', ')}（需要: ${EXPECTED.join(', ')}）`);

  const out: ParsedRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (name: string) => (cells[col(name)] ?? '').trim();
    const raw: Record<string, string> = {};
    for (const n of EXPECTED) raw[n] = get(n);
    const seq = r; // CSV 数据行号（表头为 1）
    const serial = get('serial');

    // 解析装卸点，保持书写顺序
    const stopsRaw = get('stops');
    const stops: StopPayload[] = [];
    let parseError: string | null = null;
    if (!stopsRaw) {
      parseError = 'stops 列为空：至少需要一个装卸点';
    } else {
      const parts = stopsRaw.split('|');
      for (let k = 0; k < parts.length; k++) {
        const m = parts[k].match(/^\s*(装|卸)\s*[:：]\s*(.+?)\s*$/);
        if (!m) { parseError = `第 ${k + 1} 个装卸点格式错误（应为 “装:地址” 或 “卸:地址”）：「${parts[k]}」`; break; }
        stops.push({ kind: m[1] as '装' | '卸', address: m[2] });
      }
    }

    const payload: AppointmentPayload = {
      serial,
      route: get('route'),
      warehouse: get('warehouse'),
      date: get('date'),
      slot: get('slot'),
      plate: get('plate'),
      driver: get('driver'),
      phone: get('phone'),
      remark: get('remark'),
      stops,
    };
    out.push({ seq, serial, payload, parseError, raw });
  }
  return out;
}

const PLATE_RE = /^[一-龥][A-Z][A-Z0-9]{5,6}$/;
const PHONE_RE = /^1\d{10}$/;

/** 录入前本地校验，返回错误列表（空数组 = 通过） */
export function validatePayload(p: AppointmentPayload): string[] {
  const errs: string[] = [];
  if (!p.serial) errs.push('业务流水号为空');
  if (!p.route) errs.push('线路为空');
  if (!p.warehouse) errs.push('仓库为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errs.push(`日期格式不正确：「${p.date}」（应为 YYYY-MM-DD）`);
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(p.slot)) errs.push(`时段格式不正确：「${p.slot}」（如 08:00-10:00）`);
  if (!PLATE_RE.test(p.plate)) errs.push(`车牌号格式不正确：「${p.plate}」`);
  if (!p.driver) errs.push('司机姓名为空');
  if (!PHONE_RE.test(p.phone)) errs.push(`司机电话须为 11 位手机号：「${p.phone}」`);
  if (p.stops.length === 0) errs.push('至少需要一个装卸点');
  p.stops.forEach((s, i) => { if (!s.address) errs.push(`第 ${i + 1} 个装卸点地址为空`); });
  return errs;
}
