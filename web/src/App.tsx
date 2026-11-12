import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Batch, Rec, Ev, Meta } from './api';

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理', running: '录入中', done: '成功', error: '失败', duplicate: '重复跳过',
};
const KIND_LABEL: Record<string, string> = {
  validate: '校验', navigate: '导航', login: '登录', fill: '填写', select: '选择',
  submit: '提交', dedupe: '查重', recover: '恢复', receipt: '回执', error: '错误', batch: '批次',
};

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ batch: Batch; records: Rec[]; live_running: boolean } | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const lastEventId = useRef(0);
  const [toast, setToast] = useState('');

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000); };

  useEffect(() => { api.meta().then(setMeta).catch(() => {}); }, []);

  const refreshBatches = useCallback(() => {
    api.batches().then(setBatches).catch(() => {});
  }, []);
  useEffect(() => {
    refreshBatches();
    const t = setInterval(refreshBatches, 2000);
    return () => clearInterval(t);
  }, [refreshBatches]);

  useEffect(() => {
    if (selected == null) return;
    let stop = false;
    const tick = () => {
      api.batch(selected).then(d => { if (!stop) setDetail(d); }).catch(() => {});
      api.events(selected, lastEventId.current).then(evs => {
        if (stop || evs.length === 0) return;
        lastEventId.current = evs[evs.length - 1].id;
        setEvents(prev => [...prev, ...evs].slice(-800));
      }).catch(() => {});
    };
    lastEventId.current = 0;
    setEvents([]);
    tick();
    const t = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [selected]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); showToast(msg); refreshBatches(); }
    catch (e: any) { showToast(`操作失败：${e.message}`); }
  };

  return (
    <div className="app">
      <header className="top">
        <h1>运输预约录入操作台</h1>
        {meta && (
          <nav>
            <a href={meta.siteUrl} target="_blank" rel="noreferrer">预约网站 ↗</a>
            <a href={meta.demoUrl} target="_blank" rel="noreferrer">演示开关 ↗</a>
          </nav>
        )}
      </header>
      {toast && <div className="toast">{toast}</div>}
      <div className="layout">
        <aside>
          <CreateForm onCreated={id => { setSelected(id); refreshBatches(); }} onError={m => showToast(m)} />
          <h3>批次</h3>
          <ul className="batch-list">
            {batches.map(b => (
              <li key={b.id} className={b.id === selected ? 'sel' : ''} onClick={() => setSelected(b.id)}>
                <div className="bname">#{b.id} {b.name}</div>
                <div className="bstats">
                  <span className="st done">{b.done ?? 0}</span>/
                  <span className="st error">{b.error ?? 0}</span>/
                  <span className="st duplicate">{b.duplicate ?? 0}</span>/
                  <span className="st pending">{(b.pending ?? 0) + (b.running ?? 0)}</span>
                  <em>共{b.total ?? 0}</em>
                  {b.live_running && <span className="dot" title="运行中" />}
                </div>
              </li>
            ))}
            {batches.length === 0 && <li className="muted">还没有批次，先导入 CSV</li>}
          </ul>
        </aside>
        <main>
          {detail ? (
            <BatchView
              detail={detail}
              events={events}
              expanded={expanded}
              onToggle={id => setExpanded(e => (e === id ? null : id))}
              onStart={() => act(() => api.start(detail.batch.id), '批次已开始/继续')}
              onPause={() => act(() => api.pause(detail.batch.id), '已请求暂停（当前条录完后停）')}
              onRetry={() => act(async () => { await api.retryErrors(detail.batch.id); await api.start(detail.batch.id); }, '失败记录已重置并重新开始')}
            />
          ) : (
            <div className="empty">选择左侧批次查看录入进度</div>
          )}
        </main>
      </div>
    </div>
  );
}

function CreateForm({ onCreated, onError }: { onCreated: (id: number) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState('samples/appointments.csv');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="create" onSubmit={async e => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        const r = await api.createBatch(file, path, name);
        onCreated(r.id);
      } catch (err: any) { onError(err.message); }
      finally { setBusy(false); }
    }}>
      <h3>导入 CSV</h3>
      <input type="file" accept=".csv" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      <div className="or">或使用服务器路径</div>
      <input value={path} onChange={e => setPath(e.target.value)} placeholder="samples/appointments.csv" disabled={!!file} />
      <input value={name} onChange={e => setName(e.target.value)} placeholder="批次名（可选）" />
      <button type="submit" disabled={busy}>{busy ? '导入中…' : '创建批次'}</button>
    </form>
  );
}

function BatchView({ detail, events, expanded, onToggle, onStart, onPause, onRetry }: {
  detail: { batch: Batch; records: Rec[]; live_running: boolean };
  events: Ev[];
  expanded: number | null;
  onToggle: (id: number) => void;
  onStart: () => void; onPause: () => void; onRetry: () => void;
}) {
  const { batch, records } = detail;
  const cnt = (s: string) => records.filter(r => r.status === s).length;
  const done = cnt('done'), error = cnt('error'), dup = cnt('duplicate');
  const finished = done + error + dup;
  const pct = records.length ? Math.round((finished / records.length) * 100) : 0;
  const runningRec = records.find(r => r.status === 'running');

  return (
    <div>
      <div className="batch-head">
        <h2>批次 #{batch.id} · {batch.name}</h2>
        <div className="controls">
          <button className="primary" onClick={onStart} disabled={detail.live_running}>开始 / 继续</button>
          <button onClick={onPause} disabled={!detail.live_running}>暂停</button>
          <button onClick={onRetry} disabled={detail.live_running || error === 0}>重试失败（{error}）</button>
          <span className={`runstate ${detail.live_running ? 'on' : ''}`}>
            {detail.live_running ? '● 运行中' : `○ ${batch.status}`}
          </span>
        </div>
      </div>
      <div className="progress">
        <div className="bar">
          <span className="seg done" style={{ width: `${(done / records.length) * 100}%` }} />
          <span className="seg duplicate" style={{ width: `${(dup / records.length) * 100}%` }} />
          <span className="seg error" style={{ width: `${(error / records.length) * 100}%` }} />
        </div>
        <div className="legend">
          进度 {finished}/{records.length}（{pct}%） ·
          <b className="st done"> 成功 {done}</b> ·
          <b className="st duplicate"> 重复 {dup}</b> ·
          <b className="st error"> 失败 {error}</b> ·
          <b className="st pending"> 待处理 {records.length - finished}</b>
        </div>
        {runningRec && <div className="now">▶ 正在录入：第 {runningRec.seq} 条 · 流水号 {runningRec.serial}</div>}
      </div>
      <table className="records">
        <thead>
          <tr><th>#</th><th>流水号</th><th>线路 / 仓库</th><th>日期 / 时段</th><th>状态</th><th>说明</th><th>回执</th><th></th></tr>
        </thead>
        <tbody>
          {records.map(r => (
            <RecordRow key={r.id} rec={r} events={events.filter(e => e.record_id === r.id)}
              expanded={expanded === r.id} onToggle={() => onToggle(r.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordRow({ rec, events, expanded, onToggle }: { rec: Rec; events: Ev[]; expanded: boolean; onToggle: () => void }) {
  const p = safeParse(rec.payload_json);
  return (
    <>
      <tr className={`rec ${rec.status}`} onClick={onToggle}>
        <td>{rec.seq}</td>
        <td className="mono">{rec.serial}</td>
        <td>{p?.route ?? '—'} / {p?.warehouse ?? '—'}</td>
        <td>{p?.date ?? '—'} {p?.slot ?? ''}</td>
        <td><span className={`badge ${rec.status}`}>{STATUS_LABEL[rec.status]}</span></td>
        <td className="err" title={rec.error ?? ''}>{rec.error ?? (rec.status === 'done' ? `预约 #${rec.appointment_id}` : '')}</td>
        <td onClick={e => e.stopPropagation()}>
          {rec.receipt_url
            ? <a href={rec.receipt_url} target="_blank" rel="noreferrer">打开回执 ↗</a>
            : <span className="muted">—</span>}
        </td>
        <td>{expanded ? '▾' : '▸'}</td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={8}>
            <div className="detail-panels">
              <div className="panel">
                <h4>页面操作时间线</h4>
                <ul className="timeline">
                  {events.map(e => (
                    <li key={e.id} className={`k-${e.kind}`}>
                      <span className="ts">{e.ts.split(' ')[1]}</span>
                      <span className="kind">[{KIND_LABEL[e.kind] ?? e.kind}]</span> {e.message}
                    </li>
                  ))}
                  {events.length === 0 && <li className="muted">暂无事件</li>}
                </ul>
              </div>
              <div className="panel">
                <h4>回执核对（CSV 期望值 vs 网站实际值）</h4>
                <Compare rec={rec} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function safeParse(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function Compare({ rec }: { rec: Rec }) {
  const p = safeParse(rec.payload_json);
  const receipt = safeParse(rec.receipt_json);
  if (!p) return <div className="muted">无法解析 CSV 内容</div>;
  const rows: [string, string, string | null][] = [
    ['业务流水号', p.serial, receipt?.serial ?? null],
    ['线路', p.route, receipt?.route ?? null],
    ['仓库', p.warehouse, receipt?.warehouse ?? null],
    ['预约日期', p.date, receipt?.date ?? null],
    ['时段', p.slot, receipt?.time_range ?? null],
    ['车牌号', p.plate, receipt?.plate ?? null],
    ['司机姓名', p.driver, receipt?.driver ?? null],
    ['司机电话', p.phone, receipt?.phone ?? null],
    ['备注', p.remark || '（空）', receipt ? (receipt.remark || '（空）') : null],
  ];
  const fmtStops = (stops: any[] | undefined) =>
    (stops ?? []).map((s: any, i: number) => `${i + 1}. ${s.kind} ${s.address}`).join('\n');
  rows.push(['装卸点（顺序）', fmtStops(p.stops), receipt ? fmtStops(receipt.stops) : null]);

  return (
    <table className="compare">
      <thead><tr><th>字段</th><th>CSV 期望</th><th>网站回执实际值</th><th>核对</th></tr></thead>
      <tbody>
        {rows.map(([label, csvV, rcV]) => {
          const state = rcV == null ? 'na' : String(csvV) === String(rcV) ? 'ok' : 'bad';
          return (
            <tr key={label} className={state}>
              <td>{label}</td>
              <td className="pre">{csvV}</td>
              <td className="pre">{rcV ?? '—（尚无回执）'}</td>
              <td>{state === 'ok' ? '✓' : state === 'bad' ? '✗' : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
