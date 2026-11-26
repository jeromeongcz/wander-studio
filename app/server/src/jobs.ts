import { Engine, EngineError } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  project_id: string;
  artifact_id: string | null;
  kind: string;
  state: JobState;
  progress: number;
  message: string | null;
  error: { code: string; message: string; recovery?: string; details?: unknown } | null;
  params: Record<string, unknown>;
  result: unknown;
  log: { t: string; level: string; msg: string }[];
  attempts: number;
  retry_of: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface JobCtx {
  job: Job;
  params: Record<string, any>;
  signal: AbortSignal;
  progress(pct: number, message?: string): void;
  log(msg: string, level?: 'info' | 'warn' | 'error'): void;
}
export type JobHandler = (ctx: JobCtx) => Promise<unknown>;

const RECOVERY: Record<string, string> = {
  PREFLIGHT: 'Fix the failing environment check (see details), then retry the job.',
  TOOL_FAILED: 'An external tool failed. Run the preflight check and confirm FFmpeg is installed, then retry.',
  RENDER_INPUT: 'An asset or audio file is missing. Restore it or relink the scene, rebuild the timeline, then retry.',
  RENDER_VERIFY: 'The output did not pass verification and was discarded. Retry; if it repeats, check disk space and FFmpeg.',
  PROVIDER_ERROR: 'The provider could not be reached or refused the request. Check your network or choose another provider, then retry.',
  PROTECTED: 'Approved work is protected. Retry with reopen enabled if you intend to replace it.',
  VALIDATION: 'Fix the input described in the message and retry.',
};

const now = () => new Date().toISOString();

function rowToJob(r: any): Job {
  return {
    id: r.id, project_id: r.project_id, artifact_id: r.artifact_id, kind: r.kind, state: r.state, progress: r.progress, message: r.message,
    error: r.error ? JSON.parse(r.error) : null, params: JSON.parse(r.params_json), result: r.result_json ? JSON.parse(r.result_json) : null, log: JSON.parse(r.log_json),
    attempts: r.attempts, retry_of: r.retry_of, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  };
}

/** SQLite-backed, in-process job queue. One heavy job at a time; progress, cancel, retry and structured failure logs. */
export class JobRunner {
  engine: Engine;
  handlers: Record<string, JobHandler>;
  private controllers = new Map<string, AbortController>();
  private pumping = false;
  private waiters: (() => void)[] = [];

  constructor(engine: Engine, handlers: Record<string, JobHandler>) {
    this.engine = engine;
    this.handlers = handlers;
    // A restart cannot resume a half-finished render: mark it failed so it is never reported as done.
    this.engine.db.prepare("UPDATE jobs SET state = 'failed', error = ?, finished_at = ? WHERE state = 'running'").run(JSON.stringify({ code: 'INTERRUPTED', message: 'The app stopped while this job was running', recovery: 'Retry the job.' }), now());
    if ((this.engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").get() as { n: number }).n) queueMicrotask(() => void this.pump());
  }

  get(id: string): Job {
    const r = this.engine.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!r) throw new EngineError('NOT_FOUND', `Job ${id} not found`);
    return rowToJob(r);
  }

  list(projectId?: string, state?: string): Job[] {
    const where: string[] = [];
    const args: string[] = [];
    if (projectId) (where.push('project_id = ?'), args.push(projectId));
    if (state) (where.push('state = ?'), args.push(state));
    return (this.engine.db.prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args) as any[]).map(rowToJob);
  }

  enqueue(kind: string, opts: { projectId: string; artifactId?: string; params?: Record<string, unknown>; retryOf?: string }): Job {
    if (!this.handlers[kind]) throw new EngineError('VALIDATION', `Unknown job kind "${kind}"`);
    this.engine.getProject(opts.projectId);
    const id = ulid();
    const t = now();
    this.engine.db
      .prepare('INSERT INTO jobs (id, project_id, artifact_id, kind, state, params_json, retry_of, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, opts.projectId, opts.artifactId ?? null, kind, 'queued', JSON.stringify(opts.params ?? {}), opts.retryOf ?? null, t, t);
    queueMicrotask(() => void this.pump());
    return this.get(id);
  }

  cancel(id: string): Job {
    const j = this.get(id);
    if (j.state === 'queued') {
      this.engine.db.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ?, message = 'Cancelled before it started' WHERE id = ?").run(now(), now(), id);
    } else if (j.state === 'running') {
      this.controllers.get(id)?.abort();
    } else throw new EngineError('BAD_TRANSITION', `Job is already ${j.state}`);
    return this.get(id);
  }

  retry(id: string): Job {
    const j = this.get(id);
    if (j.state !== 'failed' && j.state !== 'cancelled') throw new EngineError('BAD_TRANSITION', `Only failed or cancelled jobs can be retried (this one is ${j.state})`);
    return this.enqueue(j.kind, { projectId: j.project_id, artifactId: j.artifact_id ?? undefined, params: j.params, retryOf: j.id });
  }

  /** Remove a job's history. Running or queued jobs must be cancelled first. */
  delete(id: string): { deleted: true } {
    const j = this.get(id);
    if (j.state === 'queued' || j.state === 'running') throw new EngineError('BAD_TRANSITION', `Cancel the job before deleting it (it is ${j.state})`);
    this.engine.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    return { deleted: true };
  }

  /** Resolves when nothing is queued or running (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    const busy = this.pumping || (this.engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").get() as { n: number }).n > 0;
    return busy ? new Promise((res) => this.waiters.push(res)) : Promise.resolve();
  }

  private patch(id: string, p: Record<string, unknown>) {
    const keys = Object.keys(p);
    this.engine.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...(keys.map((k) => p[k]) as never[]), now(), id);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.engine.db.prepare("SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get() as { id: string } | undefined;
        if (!next) break;
        await this.execute(next.id);
      }
    } finally {
      this.pumping = false;
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  private async execute(id: string) {
    const job = this.get(id);
    const ac = new AbortController();
    this.controllers.set(id, ac);
    const log: Job['log'] = [];
    const flush = () => this.patch(id, { log_json: JSON.stringify(log.slice(-200)) });
    this.patch(id, { state: 'running', started_at: now(), attempts: job.attempts + 1, progress: 0 });
    const ctx: JobCtx = {
      job,
      params: job.params,
      signal: ac.signal,
      progress: (pct, message) => this.patch(id, { progress: Math.max(0, Math.min(1, pct)), ...(message ? { message } : {}) }),
      log: (msg, level = 'info') => {
        log.push({ t: now(), level, msg });
        flush();
      },
    };
    try {
      const result = await this.handlers[job.kind](ctx);
      if (ac.signal.aborted) throw new EngineError('CANCELLED', 'Cancelled');
      this.patch(id, { state: 'succeeded', progress: 1, result_json: JSON.stringify(result ?? null), finished_at: now(), message: 'Done' });
    } catch (e) {
      const err = e instanceof EngineError ? e : new EngineError('INTERNAL', (e as Error).message);
      if (err.code === 'CANCELLED' || ac.signal.aborted) {
        log.push({ t: now(), level: 'warn', msg: 'Cancelled by user' });
        this.patch(id, { state: 'cancelled', finished_at: now(), message: 'Cancelled', log_json: JSON.stringify(log) });
      } else {
        log.push({ t: now(), level: 'error', msg: `${err.code}: ${err.message}` });
        this.patch(id, { state: 'failed', finished_at: now(), message: 'Failed', log_json: JSON.stringify(log), error: JSON.stringify({ code: err.code, message: err.message, recovery: RECOVERY[err.code], details: err.details }) });
      }
    } finally {
      this.controllers.delete(id);
    }
  }
}
