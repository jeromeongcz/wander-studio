import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { Engine, EngineError } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';
import type { AppConfig } from './config.ts';
import { sha256File } from './media.ts';
import { ZipWriter, extractEntry, extractToBuffer, readZipEntries } from './zip.ts';

type Row = Record<string, unknown>;
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
const FORMAT = 1;
const MAX_MANIFEST = 200 * 1024 * 1024;

// Insert order respects foreign keys. Child tables are selected through the project's artifacts.
const TABLES: { name: string; where: string }[] = [
  { name: 'projects', where: 'id = :p' },
  { name: 'project_languages', where: 'project_id = :p' },
  { name: 'artifacts', where: 'project_id = :p' },
  { name: 'versions', where: 'artifact_id IN (SELECT id FROM artifacts WHERE project_id = :p)' },
  { name: 'artifact_deps', where: 'artifact_id IN (SELECT id FROM artifacts WHERE project_id = :p)' },
  { name: 'approval_events', where: 'artifact_id IN (SELECT id FROM artifacts WHERE project_id = :p)' },
  { name: 'assets', where: 'project_id = :p' },
  { name: 'audio_clips', where: 'project_id = :p' },
  { name: 'renders', where: 'project_id = :p' },
  { name: 'pronunciation_entries', where: 'project_id = :p' },
  { name: 'publishing_kits', where: 'project_id = :p' },
  { name: 'thumbnails', where: 'project_id = :p' },
  { name: 'topic_batches', where: 'project_id = :p' },
  { name: 'topic_ideas', where: 'project_id = :p' },
  { name: 'scene_timing', where: "scene_id IN (SELECT scene_id FROM artifacts WHERE project_id = :p AND scene_id IS NOT NULL)" },
];
const ID_TABLES = ['projects', 'artifacts', 'versions', 'approval_events', 'assets', 'audio_clips', 'renders', 'pronunciation_entries', 'publishing_kits', 'thumbnails', 'topic_batches', 'topic_ideas'];

export interface Manifest {
  format: number;
  app: 'wander-ai-director';
  schema: number;
  created_at: string;
  project_id: string;
  locales: Row[];
  rows: Record<string, Row[]>;
  files: { path: string; bytes: number; sha256: string }[];
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export class ArchiveService {
  engine: Engine;
  config: AppConfig;
  constructor(engine: Engine, config: AppConfig) {
    this.engine = engine;
    this.config = config;
  }

  private rows(table: string, where: string, projectId: string): Row[] {
    return (this.engine.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all({ p: projectId } as never) as Row[]).map((r) => ({ ...r }));
  }

  /** Build a portable .zip: the project's database rows plus every file under its folder. Caches and other projects are never included. */
  async create(projectId: string, outPath?: string): Promise<{ path: string; bytes: number; files: number }> {
    this.engine.getProject(projectId);
    const rows: Record<string, Row[]> = {};
    for (const t of TABLES) rows[t.name] = this.rows(t.name, t.where, projectId);
    const langs = (rows.project_languages as Row[]).map((r) => r.lang_code as string);
    const locales = (this.engine.db.prepare('SELECT * FROM locales WHERE builtin = 0').all() as Row[]).filter((l) => langs.includes(l.code as string)).map((l) => ({ ...l }));

    const base = join(this.config.root, 'projects', `proj_${projectId}`);
    const abs = await walk(base);
    const files: Manifest['files'] = [];
    for (const f of abs) files.push({ path: relative(this.config.root, f).split(sep).join('/'), bytes: (await stat(f)).size, sha256: await sha256File(f) });

    const manifest: Manifest = { format: FORMAT, app: 'wander-ai-director', schema: (this.engine.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, created_at: new Date().toISOString(), project_id: projectId, locales, rows, files };
    const dest = outPath ?? join(this.config.root, 'exports', `proj_${projectId}_${new Date().toISOString().replace(/[:.]/g, '-')}.wander.zip`);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${ulid()}.partial`;
    try {
      const zip = new ZipWriter(tmp);
      await zip.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest)));
      for (const f of files) await zip.addFile(`files/${f.path}`, join(this.config.root, f.path));
      await zip.finish();
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { path: dest, bytes: (await stat(dest)).size, files: files.length };
  }

  /**
   * Restore an archive. Every file is checked against its SHA-256 before anything is moved into
   * place; the database changes are one transaction; a failure at any point removes what was added.
   * `asCopy` gives every record a fresh id, so the same archive can be restored next to the original.
   */
  async restore(zipPath: string, opts: { asCopy?: boolean } = {}): Promise<{ projectId: string; files: number; remapped: boolean }> {
    const entries = await readZipEntries(zipPath);
    const mEntry = entries.find((e) => e.name === 'manifest.json');
    if (!mEntry) throw new EngineError('VALIDATION', 'Archive has no manifest.json');
    if (mEntry.usize > MAX_MANIFEST) throw new EngineError('VALIDATION', 'Manifest is too large');
    let text = (await extractToBuffer(zipPath, mEntry, MAX_MANIFEST)).toString('utf8');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(text) as Manifest;
    } catch {
      throw new EngineError('VALIDATION', 'Manifest is not valid JSON');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new EngineError('VALIDATION', 'Invalid archive manifest');
    if (manifest.app !== 'wander-ai-director' || manifest.format !== FORMAT) throw new EngineError('VALIDATION', `Unsupported archive (format ${manifest.format})`);
    const current = (this.engine.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (manifest.schema > current) throw new EngineError('VALIDATION', `Archive was made by a newer app version (schema ${manifest.schema} > ${current})`);

    // Validate untrusted manifest structure and SQL identifiers before staging any files.
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const validId = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
    if (!Number.isSafeInteger(manifest.schema) || manifest.schema < 1 || !validId(manifest.project_id) || !record(manifest.rows) || !Array.isArray(manifest.files)) {
      throw new EngineError('VALIDATION', 'Invalid archive manifest structure');
    }
    const allowedTables = new Set(TABLES.map((t) => t.name));
    for (const name of Object.keys(manifest.rows)) {
      if (!allowedTables.has(name)) throw new EngineError('VALIDATION', 'Unknown archive table');
    }
    for (const t of TABLES) {
      const rows = manifest.rows[t.name] ?? [];
      if (!Array.isArray(rows)) throw new EngineError('VALIDATION', 'Invalid archive rows');
      // The table name comes only from TABLES, never the archive.
      const columns = new Set((this.engine.db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name));
      for (const row of rows) {
        if (!record(row) || !Object.keys(row).length) throw new EngineError('VALIDATION', 'Invalid archive row');
        for (const [key, value] of Object.entries(row)) {
          if (!columns.has(key)) throw new EngineError('VALIDATION', 'Unknown archive column');
          if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new EngineError('VALIDATION', 'Invalid archive column value');
        }
        if (ID_TABLES.includes(t.name) && !validId(row.id)) throw new EngineError('VALIDATION', 'Invalid archive row ID');
        if (Object.hasOwn(row, 'project_id') && row.project_id !== manifest.project_id) throw new EngineError('VALIDATION', 'Archive row belongs to another project');
      }
    }
    if (manifest.rows.projects?.length !== 1 || manifest.rows.projects[0].id !== manifest.project_id) throw new EngineError('VALIDATION', 'Archive project ID does not match its project row');
    if (manifest.locales !== undefined && (!Array.isArray(manifest.locales) || !manifest.locales.every(record))) throw new EngineError('VALIDATION', 'Invalid archive locales');
    for (const file of manifest.files) {
      if (!record(file) || typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new EngineError('VALIDATION', 'Invalid archive file metadata');
    }

    // owned ids (only these are remapped when restoring as a copy)
    const owned = new Set<string>();
    for (const t of ID_TABLES) for (const r of manifest.rows[t] ?? []) owned.add(String(r.id));
    for (const a of manifest.rows.artifacts ?? []) if (a.scene_id) owned.add(String(a.scene_id));
    const map = new Map<string, string>();
    if (opts.asCopy) for (const id of owned) map.set(id, ulid());
    const remap = (s: string) => (map.size ? s.replace(ULID, (m) => map.get(m) ?? m) : s);
    if (map.size) {
      text = remap(text);
      manifest = JSON.parse(text) as Manifest;
    }
    const projectId = manifest.project_id;
    if (!opts.asCopy && this.engine.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      throw new EngineError('DUPLICATE_PROJECT', 'This project already exists here; restore as a copy instead');
    }

    // validate entry names (zip-slip) and that the manifest's files are all present
    const byName = new Map(entries.map((e) => [remap(e.name), e]));
    const prefix = `files/projects/proj_${projectId}/`;
    for (const f of manifest.files) {
      const name = `files/${f.path}`;
      const parts = name.split('/');
      if (!name.startsWith(prefix) || parts.includes('..') || parts.includes('') || name.includes('\\')) throw new EngineError('VALIDATION', `Unsafe path in archive: ${f.path}`);
      if (!byName.has(name)) throw new EngineError('VALIDATION', `Archive is missing ${f.path}`);
    }

    const stage = join(this.config.root, 'cache', `restore_${ulid()}`);
    const finalDir = join(this.config.root, 'projects', `proj_${projectId}`);
    let moved = false;
    try {
      for (const f of manifest.files) {
        const dest = join(stage, f.path);
        await mkdir(dirname(dest), { recursive: true });
        await extractEntry(zipPath, byName.get(`files/${f.path}`)!, createWriteStream(dest), f.bytes + 1);
        if ((await sha256File(dest)) !== f.sha256) throw new EngineError('VALIDATION', `${f.path} does not match its recorded checksum; the archive is damaged or was modified`);
      }
      if (existsSync(finalDir)) throw new EngineError('DUPLICATE_PROJECT', `Folder ${posix.join('projects', `proj_${projectId}`)} already exists`);
      const staged = join(stage, 'projects', `proj_${projectId}`);
      await mkdir(dirname(finalDir), { recursive: true });
      if (existsSync(staged)) {
        await rename(staged, finalDir);
        moved = true;
      }
      this.engine.tx(() => {
        for (const l of manifest.locales ?? []) {
          this.engine.db.prepare('INSERT OR IGNORE INTO locales (code, name, bcp47, default_wpm, builtin) VALUES (?,?,?,?,0)').run(l.code as string, l.name as string, l.bcp47 as string, l.default_wpm as number);
        }
        for (const t of TABLES) {
          for (const r of manifest.rows[t.name] ?? []) {
            const cols = Object.keys(r);
            this.engine.db.prepare(`INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(cols.map((c) => r[c]) as never[]));
          }
        }
      });
      return { projectId, files: manifest.files.length, remapped: map.size > 0 };
    } catch (e) {
      if (moved) await rm(finalDir, { recursive: true, force: true });
      throw e;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
