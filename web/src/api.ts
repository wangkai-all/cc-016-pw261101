export interface Batch {
  id: number; name: string; csv_path: string; status: string; created_at: string;
  total: number; done: number; error: number; duplicate: number; pending: number; running: number;
  live_running?: boolean;
}

export interface Rec {
  id: number; batch_id: number; seq: number; serial: string;
  payload_json: string; status: 'pending' | 'running' | 'done' | 'error' | 'duplicate';
  error: string | null; appointment_id: number | null;
  receipt_url: string | null; receipt_json: string | null;
  attempts: number; updated_at: string;
}

export interface Ev {
  id: number; batch_id: number; record_id: number | null;
  ts: string; kind: string; message: string;
}

export interface Meta { siteUrl: string; demoUrl: string }

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => fetch('/api/meta').then(r => j<Meta>(r)),
  batches: () => fetch('/api/batches').then(r => j<Batch[]>(r)),
  batch: (id: number) => fetch(`/api/batches/${id}`).then(r => j<{ batch: Batch; records: Rec[]; live_running: boolean }>(r)),
  events: (id: number, afterId: number, recordId?: number) =>
    fetch(`/api/batches/${id}/events?after_id=${afterId}${recordId ? `&record_id=${recordId}` : ''}`).then(r => j<Ev[]>(r)),
  createBatch: (file: File | null, path: string, name: string) => {
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      if (name) fd.append('name', name);
      return fetch('/api/batches', { method: 'POST', body: fd }).then(r => j<{ id: number }>(r));
    }
    return fetch('/api/batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv_path: path, name }),
    }).then(r => j<{ id: number }>(r));
  },
  start: (id: number) => fetch(`/api/batches/${id}/start`, { method: 'POST' }).then(r => j<{ started: boolean }>(r)),
  pause: (id: number) => fetch(`/api/batches/${id}/pause`, { method: 'POST' }).then(r => j<{ paused: boolean }>(r)),
  retryErrors: (id: number) => fetch(`/api/batches/${id}/retry-errors`, { method: 'POST' }).then(r => j<{ reset: number }>(r)),
};
