import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ulid, TRANSITIONS, USER_ONLY_TARGETS } from '../../shared/src/index.ts';
import type { Actor, ArtifactKind, State } from '../../shared/src/index.ts';

export class EngineError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

export interface Artifact {
  id: string;
  project_id: string;
  kind: ArtifactKind;
  lang_code: string | null;
  format: string | null;
  scene_id: string | null;
  label: string;
  state: State;
  current_version_id: string | null;
  last_error: string | null;
}

export interface VersionRow {
  id: string;
  artifact_id: string;
  seq: number;
  content_json: string;
  content_hash: string;
  created_by: string;
  created_at: string;
  approved_at: string | null;
}

export interface NewArtifact {
  projectId: string;
  kind: ArtifactKind;
  label: string;
  lang?: string;
  format?: string;
  sceneId?: string;
}

const now = () => new Date().toISOString();

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined) // match JSON.stringify: undefined fields are omitted
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export class Engine {
  db: DatabaseSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---- projects / artifacts ----

  createProject(name: string, languages: string[], category?: string, settings: Record<string, unknown> = {}): string {
    return this.tx(() => {
      const id = ulid();
      this.db
        .prepare('INSERT INTO projects (id, name, category, settings_json, created_at) VALUES (?,?,?,?,?)')
        .run(id, name, category ?? null, JSON.stringify(settings), now());
      for (const l of languages) {
        this.db.prepare('INSERT INTO project_languages (project_id, lang_code) VALUES (?,?)').run(id, l);
      }
      return id;
    });
  }

  listProjects(): { id: string; name: string; category: string | null; created_at: string }[] {
    return (this.db.prepare('SELECT id, name, category, created_at FROM projects ORDER BY id DESC').all() as any[]).map((r) => ({ ...r }));
  }

  /** Rename a project or change its category. The category only drives suggestions, so nothing is invalidated. */
  updateProject(id: string, patch: { name?: string; category?: string | null }) {
    this.getProject(id);
    const bad = (m: string) => new EngineError('VALIDATION', m);
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n || n.length > 120) throw bad('name must be 1-120 characters');
      sets.push('name = ?');
      args.push(n);
    }
    if (patch.category !== undefined) {
      const c = patch.category === null ? '' : String(patch.category).trim();
      if (c.length > 60) throw bad('category must be 60 characters or fewer');
      sets.push('category = ?');
      args.push(c || null);
    }
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.getProject(id);
  }

  getProject(id: string) {
    const p = this.db.prepare('SELECT id, name, category, settings_json, created_at FROM projects WHERE id = ?').get(id) as any;
    if (!p) throw new EngineError('NOT_FOUND', `Project ${id} not found`);
    const languages = (this.db.prepare('SELECT lang_code FROM project_languages WHERE project_id = ?').all(id) as any[]).map((r) => r.lang_code as string);
    const { settings_json, ...rest } = p;
    return { ...rest, settings: JSON.parse(settings_json) as Record<string, unknown>, languages };
  }

  /** Parsed content of the artifact's current version, or null if it has none. */
  getContent(id: string): unknown | null {
    const a = this.get(id);
    if (!a.current_version_id) return null;
    const v = this.db.prepare('SELECT content_json FROM versions WHERE id = ?').get(a.current_version_id) as { content_json: string };
    return JSON.parse(v.content_json);
  }

  createArtifact(a: NewArtifact): string {
    const id = ulid();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, lang_code, format, scene_id, label, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, a.projectId, a.kind, a.lang ?? null, a.format ?? null, a.sceneId ?? null, a.label, t, t);
    return id;
  }

  get(id: string): Artifact {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact | undefined;
    if (!row) throw new EngineError('NOT_FOUND', `Artifact ${id} not found`);
    return { ...row };
  }

  list(projectId: string, filter: Partial<Pick<Artifact, 'kind' | 'lang_code' | 'format' | 'scene_id' | 'state'>> = {}): Artifact[] {
    const where = ['project_id = ?'];
    const args: (string | null)[] = [projectId];
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      where.push(`${k} = ?`);
      args.push(v as string);
    }
    return (this.db.prepare(`SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY id`).all(...args) as unknown as Artifact[]).map(
      (r) => ({ ...r }),
    );
  }

  // ---- dependencies ----

  addDependency(artifactId: string, dependsOnId: string): void {
    const a = this.get(artifactId);
    const b = this.get(dependsOnId);
    if (a.project_id !== b.project_id) throw new EngineError('CROSS_PROJECT', 'Dependencies must stay within one project');
    if (artifactId === dependsOnId || this.downstream(artifactId).some((d) => d.id === dependsOnId)) {
      throw new EngineError('CYCLE', `Dependency ${artifactId} -> ${dependsOnId} would create a cycle`);
    }
    this.db.prepare('INSERT OR IGNORE INTO artifact_deps (artifact_id, depends_on_id) VALUES (?,?)').run(artifactId, dependsOnId);
  }

  upstreamDirect(id: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT a.* FROM artifacts a JOIN artifact_deps d ON d.depends_on_id = a.id WHERE d.artifact_id = ?')
        .all(id) as unknown as Artifact[]
    ).map((r) => ({ ...r }));
  }

  /** All artifacts transitively depending on `id`. */
  downstream(id: string): Artifact[] {
    return (
      this.db
        .prepare(
          `WITH RECURSIVE d(id) AS (
             SELECT artifact_id FROM artifact_deps WHERE depends_on_id = ?
             UNION
             SELECT ad.artifact_id FROM artifact_deps ad JOIN d ON ad.depends_on_id = d.id
           )
           SELECT a.* FROM artifacts a JOIN d ON a.id = d.id`,
        )
        .all(id) as unknown as Artifact[]
    ).map((r) => ({ ...r }));
  }

  // ---- state machine ----

  private transition(a: Artifact, to: State, actor: Actor, opts: { note?: string; versionId?: string | null; cause?: string } = {}): void {
    if (!TRANSITIONS[a.state].includes(to)) {
      throw new EngineError('BAD_TRANSITION', `Cannot move ${a.label} from ${a.state} to ${to}`);
    }
    if (USER_ONLY_TARGETS.includes(to) && actor !== 'user') {
      throw new EngineError('USER_ONLY', `Only the user can move an artifact to ${to}; actor was ${actor}`);
    }
    const t = now();
    this.db.prepare('UPDATE artifacts SET state = ?, updated_at = ?, last_error = CASE WHEN ? = \'failed\' THEN last_error ELSE NULL END WHERE id = ?').run(to, t, to, a.id);
    this.db
      .prepare(
        `INSERT INTO approval_events (id, artifact_id, version_id, from_state, to_state, actor, note, cause_artifact_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(ulid(), a.id, opts.versionId ?? a.current_version_id, a.state, to, actor, opts.note ?? null, opts.cause ?? null, t);
  }

  /** Mark approved/awaiting-review downstream artifacts as needs_revision. Never touches other states. */
  private invalidateDownstream(sourceId: string): string[] {
    const hit: string[] = [];
    for (const d of this.downstream(sourceId)) {
      if (d.state === 'approved' || d.state === 'awaiting_review') {
        this.transition(d, 'needs_revision', 'system', { note: 'Upstream changed', cause: sourceId });
        hit.push(d.id);
      }
    }
    return hit;
  }

  /**
   * Mark an approved/in-review artifact as needing revision because something it relies on changed
   * outside its own content (e.g. the pronunciation lexicon), then cascade downstream.
   */
  invalidate(id: string, note: string): string[] {
    return this.tx(() => {
      const a = this.get(id);
      const hit: string[] = [];
      if (a.state === 'approved' || a.state === 'awaiting_review') {
        this.transition(a, 'needs_revision', 'system', { note });
        hit.push(a.id);
      }
      return [...hit, ...this.invalidateDownstream(id)];
    });
  }

  /**
   * Save new content as a new immutable version. Approved artifacts are protected:
   * editing one requires `reopen: true`. Unchanged content is a no-op (no invalidation).
   */
  saveVersion(id: string, content: unknown, opts: { actor?: Actor; reopen?: boolean } = {}): { versionId: string; changed: boolean; invalidated: string[] } {
    return this.tx(() => {
      const a = this.get(id);
      const actor = opts.actor ?? 'user';
      if (a.state === 'approved' && !opts.reopen) {
        throw new EngineError('PROTECTED', `${a.label} is approved; pass reopen to edit it (the approved version stays in history)`);
      }
      const json = canonical(content);
      const hash = createHash('sha256').update(json).digest('hex');
      if (a.current_version_id) {
        const cur = this.db.prepare('SELECT content_hash FROM versions WHERE id = ?').get(a.current_version_id) as { content_hash: string };
        if (cur.content_hash === hash) {
          // Same content: allow resuming work without creating a version or invalidating downstream.
          if (a.state === 'needs_revision' || a.state === 'failed' || a.state === 'rejected') this.transition(a, 'in_progress', actor);
          return { versionId: a.current_version_id, changed: false, invalidated: [] };
        }
      }
      const seq = ((this.db.prepare('SELECT MAX(seq) AS m FROM versions WHERE artifact_id = ?').get(id) as { m: number | null }).m ?? 0) + 1;
      const versionId = ulid();
      this.db
        .prepare('INSERT INTO versions (id, artifact_id, seq, content_json, content_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(versionId, id, seq, json, hash, actor, now());
      this.db.prepare('UPDATE artifacts SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, now(), id);
      const fresh = this.get(id);
      if (fresh.state !== 'in_progress') this.transition(fresh, 'in_progress', actor, { versionId, note: `Saved version ${seq}` });
      const invalidated = this.invalidateDownstream(id);
      return { versionId, changed: true, invalidated };
    });
  }

  /** Begin work without changing content (e.g. redo a needs_revision artifact). */
  startWork(id: string, actor: Actor = 'user'): void {
    this.tx(() => this.transition(this.get(id), 'in_progress', actor));
  }

  submitForReview(id: string, actor: Actor = 'user'): void {
    this.tx(() => {
      const a = this.get(id);
      if (!a.current_version_id) throw new EngineError('NO_VERSION', `${a.label} has no content to review`);
      this.transition(a, 'awaiting_review', actor);
    });
  }

  /** Human approval only. Requires every upstream dependency to already be approved. */
  approve(id: string, opts: { actor: Actor; note?: string }): void {
    this.tx(() => {
      const a = this.get(id);
      if (opts.actor !== 'user') throw new EngineError('USER_ONLY', 'Approval requires an explicit user action');
      const unmet = this.upstreamDirect(id).filter((u) => u.state !== 'approved');
      if (unmet.length) {
        throw new EngineError('UNMET_DEPENDENCY', `${a.label} cannot be approved until approved: ${unmet.map((u) => u.label).join(', ')}`);
      }
      this.transition(a, 'approved', opts.actor, { note: opts.note });
      this.db.prepare('UPDATE versions SET approved_at = ? WHERE id = ?').run(now(), a.current_version_id);
    });
  }

  requestRevision(id: string, note?: string): void {
    this.tx(() => this.transition(this.get(id), 'needs_revision', 'user', { note }));
  }

  reject(id: string, opts: { actor: Actor; note?: string }): void {
    this.tx(() => this.transition(this.get(id), 'rejected', opts.actor, { note: opts.note }));
  }

  /** Failure isolation: only this artifact changes state; approved versions and other artifacts are untouched. */
  fail(id: string, message: string): void {
    this.tx(() => {
      const a = this.get(id);
      this.transition(a, 'failed', 'system', { note: message });
      this.db.prepare('UPDATE artifacts SET last_error = ? WHERE id = ?').run(message, id);
    });
  }

  // ---- history ----

  versions(id: string): VersionRow[] {
    return (this.db.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY seq').all(id) as unknown as VersionRow[]).map((r) => ({ ...r }));
  }

  events(id: string) {
    return this.db.prepare('SELECT * FROM approval_events WHERE artifact_id = ? ORDER BY created_at, id').all(id);
  }

  /** Non-destructive restore: copies an old version's content into a new version. */
  restoreVersion(id: string, versionId: string, opts: { actor?: Actor } = {}) {
    const v = this.db.prepare('SELECT content_json FROM versions WHERE id = ? AND artifact_id = ?').get(versionId, id) as { content_json: string } | undefined;
    if (!v) throw new EngineError('NOT_FOUND', `Version ${versionId} not found for artifact ${id}`);
    return this.saveVersion(id, JSON.parse(v.content_json), { actor: opts.actor ?? 'user', reopen: true });
  }
}
