import { useEffect, useState, useSyncExternalStore } from 'react';
import { Btn } from './ui';
import { api, ApiError } from './api';

/** A long request the page is waiting on (no server job). Kept outside React so it survives moving between steps. */
export interface Task { scope: string; label: string; detail: string; startedAt: number }
let tasks: Task[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function startTask(scope: string, label: string, detail: string): () => void {
  const t = { scope, label, detail, startedAt: Date.now() };
  tasks = [...tasks, t];
  emit();
  return () => { tasks = tasks.filter((x) => x !== t); emit(); };
}
export const useTask = (...scopes: string[]): Task | undefined =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => tasks).find((t) => scopes.includes(t.scope));

/** Start a background job and wait for it. The floating footer shows its progress; a failure comes back as an error. */
export async function runJob(projectId: string, kind: string, artifactId: string, params: Record<string, unknown>): Promise<void> {
  let job = await api.post(`/jobs`, { project_id: projectId, kind, artifact_id: artifactId, params });
  while (job.state === 'queued' || job.state === 'running') {
    await new Promise((r) => setTimeout(r, 700));
    job = await api.get(`/jobs/${job.id}`);
  }
  if (job.state !== 'succeeded') throw new ApiError(0, job.error?.code ?? job.state.toUpperCase(), job.state === 'cancelled' ? 'Cancelled' : (job.error?.message ?? 'The job failed'), job.error?.details);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The floating footer while something is running. A percentage is shown only when the work reports one. */
export function ProgressFooter({ label, detail, progress, startedAt, onCancel }: { label: string; detail?: string; progress?: number; startedAt?: number; onCancel?: () => Promise<void> | void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const known = typeof progress === 'number' && progress > 0;
  const pct = known ? Math.min(100, Math.round(progress * 100)) : undefined;
  return (
    <div className="stepfoot busy">
      <div className="busy-row">
        <span className="spin" aria-hidden />
        <div className="grow" role="status"><strong>{label}</strong>{detail && <div className="muted small">{detail}</div>}</div>
        <span className="mono">{pct !== undefined ? `${pct}%` : ''}{startedAt ? ` ${clock(Math.max(0, Math.round((now - startedAt) / 1000)))}` : ''}</span>
        {onCancel && <Btn small kind="danger" onClick={onCancel}>Cancel</Btn>}
      </div>
      <div className={`busy-bar${known ? '' : ' moving'}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={known ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
