import { copyFile, constants, mkdir, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Engine, EngineError } from './engine.ts';
import type { Artifact } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';
import { ASSET_TYPES } from './studios/storyboard.ts';
import type { AssetType } from './studios/storyboard.ts';
import { IMAGE_EXT, VIDEO_EXT, MIME, EXT_FOR_MIME, ffprobeBinary, probeMedia, sha256File } from './media.ts';
import { licenseApprovalCheck, validateLicenseShape } from './license.ts';
import type { LicenseRecord } from './license.ts';
import type { AppConfig } from './config.ts';
import { ProviderRegistry } from './providers/registry.ts';

export interface Asset {
  id: string;
  project_id: string | null;
  scope: 'project' | 'shared';
  type: AssetType;
  name: string;
  rel_path: string;
  mime: string;
  bytes: number;
  sha256: string;
  media_kind: 'image' | 'video';
  width: number;
  height: number;
  duration_seconds: number | null;
  aspect_ratio: number;
  focal: { x: number; y: number };
  prompt: string | null;
  provider: string;
  params: Record<string, unknown>;
  license: LicenseRecord;
  tags: string[];
  approval_status: 'pending' | 'approved' | 'rejected';
  approved_at: string | null;
  source_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportOptions {
  type: AssetType;
  name?: string;
  license: unknown;
  prompt?: string;
  provider?: string;
  params?: Record<string, unknown>;
  tags?: string[];
}

const VIDEO_TYPES = new Set<AssetType>(['stock_video', 'motion_graphic']);
const GRAPHICS_TYPES = new Set<AssetType>(['map', 'infographic', 'icon', 'motion_graphic', 'text_overlay']);
const now = () => new Date().toISOString();
const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);

function rowToAsset(r: any): Asset {
  return {
    id: r.id, project_id: r.project_id, scope: r.scope, type: r.type, name: r.name, rel_path: r.rel_path, mime: r.mime, bytes: r.bytes, sha256: r.sha256,
    media_kind: r.media_kind, width: r.width, height: r.height, duration_seconds: r.duration_seconds, aspect_ratio: r.aspect_ratio,
    focal: { x: r.focal_x, y: r.focal_y }, prompt: r.prompt, provider: r.provider, params: JSON.parse(r.params_json), license: JSON.parse(r.license_json),
    tags: JSON.parse(r.tags_json), approval_status: r.approval_status, approved_at: r.approved_at, source_asset_id: r.source_asset_id, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export class AssetService {
  engine: Engine;
  config: AppConfig;
  providers: ProviderRegistry;

  constructor(engine: Engine, config: AppConfig) {
    this.engine = engine;
    this.config = config;
    this.providers = new ProviderRegistry(config.fetchFn);
  }

  absPath(a: Asset): string {
    const p = resolve(this.config.root, a.rel_path);
    if (!p.startsWith(resolve(this.config.root) + '/')) throw new EngineError('VALIDATION', 'Asset path escapes the application root');
    return p;
  }

  // ---- reads ----
  get(id: string): Asset {
    const r = this.engine.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r) throw new EngineError('NOT_FOUND', `Asset ${id} not found`);
    return rowToAsset(r);
  }

  list(filter: { projectId?: string; shared?: boolean; type?: string; status?: string } = {}): Asset[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.shared) where.push("scope = 'shared'");
    else if (filter.projectId) (where.push('project_id = ?'), args.push(filter.projectId));
    if (filter.type) (where.push('type = ?'), args.push(filter.type));
    if (filter.status) (where.push('approval_status = ?'), args.push(filter.status));
    const sql = `SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
    return (this.engine.db.prepare(sql).all(...args) as any[]).map(rowToAsset);
  }

  /** Scene-asset artifacts whose current content references this asset. */
  usage(asset: Asset): Artifact[] {
    if (!asset.project_id) return [];
    return this.engine.list(asset.project_id, { kind: 'scene_asset' }).filter((a) => {
      const c = this.engine.getContent(a.id) as { assets?: { asset_id: string }[] } | null;
      return !!c?.assets?.some((x) => x.asset_id === asset.id);
    });
  }

  // ---- import ----
  private destRel(projectId: string | null, type: AssetType, kind: 'image' | 'video', id: string, ext: string): string {
    const sub = kind === 'video' ? 'footage' : GRAPHICS_TYPES.has(type) ? 'graphics' : 'images';
    return projectId ? join('projects', `proj_${projectId}`, 'assets', sub, `${id}${ext}`) : join('shared_assets', sub, `${id}${ext}`);
  }

  /** Copy a local file into the project, verify it with ffprobe, and record it. The original is never modified. */
  async importLocal(projectId: string, srcPath: string, opts: ImportOptions, internal: { moveSource?: boolean } = {}): Promise<Asset> {
    this.engine.getProject(projectId);
    if (!ASSET_TYPES.includes(opts.type)) throw bad(`type must be one of ${ASSET_TYPES.join(', ')}`);
    const license = validateLicenseShape(opts.license);
    const ext = extname(srcPath).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) throw bad(`Unsupported file type "${ext || 'none'}"`, { images: [...IMAGE_EXT], video: [...VIDEO_EXT] });
    let st;
    try {
      st = await stat(srcPath);
    } catch {
      throw bad('File not found');
    }
    if (!st.isFile()) throw bad('Path is not a regular file');
    if (st.size === 0) throw bad('File is empty');
    if (st.size > this.config.maxImportBytes) throw bad('File is too large');
    if (VIDEO_EXT.has(ext) && !VIDEO_TYPES.has(opts.type)) throw bad(`Asset type "${opts.type}" expects an image, but this is a video`);
    if (IMAGE_EXT.has(ext) && opts.type === 'stock_video') throw bad('Asset type "stock_video" expects a video file');

    const sha = await sha256File(srcPath);
    const dup = this.engine.db.prepare('SELECT id FROM assets WHERE project_id = ? AND sha256 = ?').get(projectId, sha) as { id: string } | undefined;
    if (dup) throw new EngineError('DUPLICATE_ASSET', 'This exact file is already in the project', { existing_id: dup.id });

    const id = ulid();
    const rel = this.destRel(projectId, opts.type, VIDEO_EXT.has(ext) ? 'video' : 'image', id, ext);
    const dest = join(this.config.root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(srcPath, dest);
    try {
      const probe = await probeMedia(dest, ffprobeBinary(this.config.ffprobePath));
      const t = now();
      this.engine.db
        .prepare(
          `INSERT INTO assets (id, project_id, scope, type, name, rel_path, mime, bytes, sha256, media_kind, width, height, duration_seconds, aspect_ratio, prompt, provider, params_json, license_json, tags_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, projectId, 'project', opts.type, opts.name?.trim() || `${opts.type}-${id.slice(-6)}`, rel, MIME[ext], st.size, sha, probe.kind, probe.width, probe.height, probe.duration ?? null, probe.width / probe.height, opts.prompt ?? null, opts.provider ?? 'manual-import', JSON.stringify(opts.params ?? {}), JSON.stringify(license), JSON.stringify(opts.tags ?? []), t, t);
    } catch (e) {
      await unlink(dest).catch(() => {});
      throw e;
    }
    if (internal.moveSource) await unlink(srcPath).catch(() => {});
    return this.get(id);
  }

  /** Download a stock result chosen from a provider search. Only the provider's own result id is accepted from the client, never an arbitrary URL. */
  async importRemote(projectId: string, providerId: string, resultId: string, type: AssetType): Promise<Asset> {
    const provider = this.providers.stock(providerId);
    const r = await provider.fetchResult(resultId);
    const tmp = join(this.config.root, 'cache', `dl_${ulid()}`);
    await mkdir(dirname(tmp), { recursive: true });
    const finalPath = await this.download(r.download_url, tmp);
    try {
      return await this.importLocal(projectId, finalPath, { type, name: r.title || undefined, license: r.license, provider: providerId, params: { result_id: r.id, landing_url: r.landing_url, download_url: r.download_url } }, { moveSource: true });
    } catch (e) {
      await unlink(finalPath).catch(() => {});
      throw e;
    }
  }

  private async download(url: string, tmpBase: string): Promise<string> {
    const f = this.config.fetchFn ?? fetch;
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      let u: URL;
      try {
        u = new URL(current);
      } catch {
        throw new EngineError('PROVIDER_ERROR', 'Provider returned an invalid download URL');
      }
      if (u.protocol !== 'https:') throw new EngineError('PROVIDER_ERROR', 'Refusing non-HTTPS download');
      if (isPrivateHost(u.hostname)) throw new EngineError('PROVIDER_ERROR', 'Refusing download from a local or private address');
      let res: Response;
      try {
        res = await f(current, { redirect: 'manual', headers: { 'user-agent': 'WanderAIDirector/0.1 (local app)' } });
      } catch (e) {
        throw new EngineError('PROVIDER_ERROR', `Download failed: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      if (!res.ok || !res.body) throw new EngineError('PROVIDER_ERROR', `Download failed with HTTP ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const ext = EXT_FOR_MIME[type];
      if (!ext) throw new EngineError('MEDIA_INVALID', `Remote file is not a supported image (content-type "${type || 'missing'}")`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      const cap = this.config.maxRemoteBytes;
      if (declared > cap) throw new EngineError('MEDIA_INVALID', 'Remote file is too large');
      const dest = tmpBase + ext;
      let seen = 0;
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          seen += chunk.length;
          if (seen > cap) cb(new EngineError('MEDIA_INVALID', 'Remote file is too large'));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as any), limiter, createWriteStream(dest));
      } catch (e) {
        await unlink(dest).catch(() => {});
        throw e instanceof EngineError ? e : new EngineError('PROVIDER_ERROR', `Download failed: ${(e as Error).message}`);
      }
      return dest;
    }
    throw new EngineError('PROVIDER_ERROR', 'Too many redirects');
  }

  // ---- edits and approval ----
  /** Fields that change how an approved asset looks or whether it may be used force a re-approval, so they need `reopen`. */
  update(id: string, patch: { name?: string; type?: AssetType; focal?: { x: number; y: number }; license?: unknown; tags?: string[]; prompt?: string }, opts: { reopen?: boolean } = {}) {
    return this.engine.tx(() => {
      const a = this.get(id);
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      let sensitive = false;
      if (patch.name !== undefined) (sets.push('name = ?'), args.push(String(patch.name).trim() || a.name));
      if (patch.tags !== undefined) {
        if (!Array.isArray(patch.tags) || !patch.tags.every((t) => typeof t === 'string')) throw bad('tags must be strings');
        sets.push('tags_json = ?');
        args.push(JSON.stringify(patch.tags));
      }
      if (patch.prompt !== undefined) (sets.push('prompt = ?'), args.push(String(patch.prompt)));
      if (patch.focal !== undefined) {
        const { x, y } = patch.focal ?? ({} as any);
        if (!(typeof x === 'number' && typeof y === 'number' && x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw bad('focal x and y must be numbers between 0 and 1');
        if (x !== a.focal.x || y !== a.focal.y) {
          sensitive = true;
          sets.push('focal_x = ?', 'focal_y = ?');
          args.push(x, y);
        }
      }
      if (patch.type !== undefined && patch.type !== a.type) {
        if (!ASSET_TYPES.includes(patch.type)) throw bad('invalid asset type');
        if (a.media_kind === 'video' && !VIDEO_TYPES.has(patch.type)) throw bad(`A video cannot be typed "${patch.type}"`);
        if (a.media_kind === 'image' && patch.type === 'stock_video') throw bad('An image cannot be typed "stock_video"');
        sensitive = true;
        sets.push('type = ?');
        args.push(patch.type);
      }
      if (patch.license !== undefined) {
        const l = validateLicenseShape(patch.license);
        if (JSON.stringify(l) !== JSON.stringify(a.license)) {
          sensitive = true;
          sets.push('license_json = ?');
          args.push(JSON.stringify(l));
        }
      }
      let invalidated: string[] = [];
      if (sensitive && a.approval_status === 'approved') {
        if (!opts.reopen) throw new EngineError('PROTECTED', 'This asset is approved; pass reopen to change its focal point, type or license (it will need re-approval)');
        sets.push("approval_status = 'pending'", 'approved_at = NULL');
        for (const scene of this.usage(a)) invalidated.push(...this.engine.invalidate(scene.id, 'A linked asset changed'));
      }
      if (sets.length) {
        sets.push('updated_at = ?');
        args.push(now(), id);
        this.engine.db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      }
      return { asset: this.get(id), invalidated };
    });
  }

  approve(id: string): { asset: Asset; warnings: string[] } {
    const a = this.get(id);
    if (a.scope === 'shared') throw bad('Shared library assets are approved in their source project');
    const { errors, warnings } = licenseApprovalCheck(a.license);
    if (errors.length) throw new EngineError('LICENSE', `${a.name} cannot be approved yet`, errors);
    this.engine.db.prepare("UPDATE assets SET approval_status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    return { asset: this.get(id), warnings };
  }

  reject(id: string): Asset {
    const a = this.get(id);
    return this.engine.tx(() => {
      this.engine.db.prepare("UPDATE assets SET approval_status = 'rejected', approved_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
      if (a.approval_status === 'approved') for (const s of this.usage(a)) this.engine.invalidate(s.id, 'A linked asset was rejected');
      return this.get(id);
    });
  }

  async remove(id: string): Promise<void> {
    const a = this.get(id);
    const used = this.usage(a);
    if (used.length) throw new EngineError('PROTECTED', 'Asset is used by scenes; unlink it first', used.map((u) => u.label));
    this.engine.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    await unlink(this.absPath(a)).catch(() => {});
  }

  // ---- shared library ----
  private async cloneFile(from: Asset, toRel: string) {
    const dest = join(this.config.root, toRel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(this.absPath(from), dest, constants.COPYFILE_FICLONE);
  }

  private insertCopy(src: Asset, id: string, rel: string, projectId: string | null) {
    const t = now();
    this.engine.db
      .prepare(
        `INSERT INTO assets (id, project_id, scope, type, name, rel_path, mime, bytes, sha256, media_kind, width, height, duration_seconds, aspect_ratio, focal_x, focal_y, prompt, provider, params_json, license_json, tags_json, approval_status, approved_at, source_asset_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, projectId ? 'project' : 'shared', src.type, src.name, rel, src.mime, src.bytes, src.sha256, src.media_kind, src.width, src.height, src.duration_seconds, src.aspect_ratio, src.focal.x, src.focal.y, src.prompt, src.provider, JSON.stringify(src.params), JSON.stringify(src.license), JSON.stringify(src.tags), 'approved', t, src.source_asset_id ?? src.id, t, t);
  }

  /** Publish an approved project asset to the shared library (a copy; the project keeps its own). */
  async promote(id: string): Promise<Asset> {
    const a = this.get(id);
    if (a.scope !== 'project' || a.approval_status !== 'approved') throw new EngineError('VALIDATION', 'Only approved project assets can be added to the shared library');
    const existing = this.engine.db.prepare("SELECT id FROM assets WHERE scope = 'shared' AND sha256 = ?").get(a.sha256) as { id: string } | undefined;
    if (existing) throw new EngineError('DUPLICATE_ASSET', 'Already in the shared library', { existing_id: existing.id });
    const nid = ulid();
    const rel = this.destRel(null, a.type, a.media_kind, nid, extname(a.rel_path));
    await this.cloneFile(a, rel);
    try {
      this.insertCopy({ ...a, source_asset_id: a.id }, nid, rel, null);
    } catch (e) {
      await unlink(join(this.config.root, rel)).catch(() => {});
      throw e;
    }
    return this.get(nid);
  }

  /** Copy a shared asset into a project. Its license was approved when it was shared, so it arrives approved. */
  async reuse(sharedId: string, projectId: string): Promise<Asset> {
    this.engine.getProject(projectId);
    const s = this.get(sharedId);
    if (s.scope !== 'shared') throw new EngineError('VALIDATION', 'Not a shared library asset');
    const dup = this.engine.db.prepare('SELECT id FROM assets WHERE project_id = ? AND sha256 = ?').get(projectId, s.sha256) as { id: string } | undefined;
    if (dup) throw new EngineError('DUPLICATE_ASSET', 'This asset is already in the project', { existing_id: dup.id });
    const nid = ulid();
    const rel = this.destRel(projectId, s.type, s.media_kind, nid, extname(s.rel_path));
    await this.cloneFile(s, rel);
    try {
      this.insertCopy({ ...s, source_asset_id: s.source_asset_id ?? s.id }, nid, rel, projectId);
    } catch (e) {
      await unlink(join(this.config.root, rel)).catch(() => {});
      throw e;
    }
    return this.get(nid);
  }

  // ---- scenes ----
  /** Readiness for a scene's visual asset artifact. */
  sceneReadiness(projectId: string, content: unknown, storyboardType?: AssetType): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const c = content as { assets?: { asset_id: string }[]; primary_asset_id?: string } | null;
    const links = c?.assets ?? [];
    if (links.length === 0) errors.push('No asset is linked to this scene');
    if (links.length && !links.some((l) => l.asset_id === c?.primary_asset_id)) errors.push('Choose a primary asset');
    for (const l of links) {
      const a = this.engine.db.prepare('SELECT * FROM assets WHERE id = ? AND project_id = ?').get(l.asset_id, projectId);
      if (!a) {
        errors.push(`Linked asset ${l.asset_id} no longer exists`);
        continue;
      }
      const asset = rowToAsset(a);
      if (asset.approval_status !== 'approved') errors.push(`Asset "${asset.name}" is ${asset.approval_status}; approve it first`);
      if (l.asset_id === c?.primary_asset_id && storyboardType && asset.type !== storyboardType) warnings.push(`Primary asset is "${asset.type}" but the storyboard planned "${storyboardType}"`);
    }
    return { errors, warnings };
  }

  checkSceneLinks(projectId: string, links: { asset_id: string; role?: string }[], primary: string) {
    if (!Array.isArray(links) || links.length === 0) throw bad('assets must be a non-empty array');
    if (!links.some((l) => l.asset_id === primary)) throw bad('primary_asset_id must be one of the linked assets');
    for (const l of links) {
      const a = this.get(l.asset_id);
      if (a.scope === 'shared') throw bad('Reuse shared assets into the project before linking them');
      if (a.project_id !== projectId) throw bad(`Asset ${l.asset_id} belongs to a different project`);
    }
  }
}
