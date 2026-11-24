import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { Engine, EngineError } from '../engine.ts';
import type { Artifact } from '../engine.ts';
import { ulid } from '../../../shared/src/index.ts';
import { AUDIO_EXT, ffmpegBinary, ffprobeBinary, probeAudio, run, sha256File } from '../media.ts';
import { licenseApprovalCheck, validateLicenseShape } from '../license.ts';
import type { LicenseRecord } from '../license.ts';
import type { AppConfig } from '../config.ts';
import { TtsRegistry } from './tts.ts';
import { validateMixShape } from './mix.ts';
import type { MixSpec } from './mix.ts';

export type ClipKind = 'narration' | 'music' | 'sfx';

export interface AudioClip {
  id: string;
  project_id: string;
  lang_code: string | null;
  kind: ClipKind;
  name: string;
  rel_path: string;
  sha256: string;
  duration_seconds: number;
  sample_rate: number | null;
  channels: number | null;
  provider: string;
  voice: string | null;
  params: Record<string, unknown>;
  license: LicenseRecord;
  created_at: string;
}

export interface NarrationContent {
  chunks: { clip_id: string; section_ids: string[] }[];
  gap_seconds?: number;
  voice?: { provider: string; voice: string; rate?: number };
  mix?: MixSpec;
}

export interface LayoutChunk {
  clip_id: string;
  section_ids: string[];
  start: number;
  duration: number;
  path: string;
}

const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const rowToClip = (r: any): AudioClip => ({ ...r, params: JSON.parse(r.params_json), license: JSON.parse(r.license_json) });

export function validateNarrationShape(c: unknown): NarrationContent {
  if (!isObj(c) || !Array.isArray(c.chunks)) throw bad('Narration must be an object with a chunks array');
  c.chunks.forEach((x, i) => {
    if (!isObj(x) || typeof x.clip_id !== 'string') throw bad(`chunks[${i}] needs clip_id`);
    if (!Array.isArray(x.section_ids) || !x.section_ids.length || !x.section_ids.every((s) => typeof s === 'string')) throw bad(`chunks[${i}] needs section_ids`);
  });
  if (c.gap_seconds !== undefined && !(typeof c.gap_seconds === 'number' && c.gap_seconds >= 0 && c.gap_seconds <= 2)) throw bad('gap_seconds must be between 0 and 2');
  if (c.voice !== undefined && !(isObj(c.voice) && typeof c.voice.provider === 'string' && typeof c.voice.voice === 'string')) throw bad('voice needs provider and voice');
  validateMixShape(c.mix);
  return c as unknown as NarrationContent;
}

export class AudioService {
  engine: Engine;
  config: AppConfig;
  tts: TtsRegistry;

  constructor(engine: Engine, config: AppConfig) {
    this.engine = engine;
    this.config = config;
    this.tts = new TtsRegistry({ ffmpeg: config.ffprobePath, ...config.tts });
  }

  absPath(c: AudioClip) {
    return join(this.config.root, c.rel_path);
  }

  get(id: string): AudioClip {
    const r = this.engine.db.prepare('SELECT * FROM audio_clips WHERE id = ?').get(id);
    if (!r) throw new EngineError('NOT_FOUND', `Audio clip ${id} not found`);
    return rowToClip(r);
  }

  list(projectId: string, filter: { kind?: string; lang?: string } = {}): AudioClip[] {
    const where = ['project_id = ?'];
    const args: string[] = [projectId];
    if (filter.kind) (where.push('kind = ?'), args.push(filter.kind));
    if (filter.lang) (where.push('lang_code = ?'), args.push(filter.lang));
    return (this.engine.db.prepare(`SELECT * FROM audio_clips WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args) as any[]).map(rowToClip);
  }

  /** Copy an audio file into the project, verify it with ffprobe, record its measured duration. */
  async importClip(
    projectId: string,
    srcPath: string,
    opts: { kind: ClipKind; lang?: string; name?: string; license: unknown; provider?: string; voice?: string; params?: Record<string, unknown> },
    internal: { moveSource?: boolean } = {},
  ): Promise<AudioClip> {
    const project = this.engine.getProject(projectId);
    if (!['narration', 'music', 'sfx'].includes(opts.kind)) throw bad('kind must be narration, music or sfx');
    if (opts.kind === 'narration') {
      if (!opts.lang || !project.languages.includes(opts.lang)) throw bad('Narration needs a lang that belongs to this project');
    }
    const license = validateLicenseShape(opts.license);
    const ext = extname(srcPath).toLowerCase();
    if (!AUDIO_EXT.has(ext)) throw bad(`Unsupported audio type "${ext || 'none'}"`, [...AUDIO_EXT]);
    let st;
    try {
      st = await stat(srcPath);
    } catch {
      throw bad('File not found');
    }
    if (!st.isFile() || st.size === 0) throw bad('Not a non-empty regular file');
    if (st.size > this.config.maxImportBytes) throw bad('File is too large');
    const sha = await sha256File(srcPath);
    const dup = this.engine.db.prepare("SELECT id FROM audio_clips WHERE project_id = ? AND kind = ? AND sha256 = ? AND IFNULL(lang_code, '') = ?").get(projectId, opts.kind, sha, opts.lang ?? '') as { id: string } | undefined;
    if (dup) throw new EngineError('DUPLICATE_ASSET', 'This exact audio file is already in the project', { existing_id: dup.id });

    const id = ulid();
    const rel = join('projects', `proj_${projectId}`, 'audio', opts.kind, `${id}${ext}`);
    const dest = join(this.config.root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(srcPath, dest);
    try {
      const probe = await probeAudio(dest, ffprobeBinary(this.config.ffprobePath));
      this.engine.db
        .prepare(
          `INSERT INTO audio_clips (id, project_id, lang_code, kind, name, rel_path, sha256, duration_seconds, sample_rate, channels, provider, voice, params_json, license_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, projectId, opts.lang ?? null, opts.kind, opts.name?.trim() || `${opts.kind}-${id.slice(-6)}`, rel, sha, probe.duration, probe.sampleRate || null, probe.channels || null, opts.provider ?? 'manual-import', opts.voice ?? null, JSON.stringify(opts.params ?? {}), JSON.stringify(license), new Date().toISOString());
    } catch (e) {
      await unlink(dest).catch(() => {});
      throw e;
    }
    if (internal.moveSource) await unlink(srcPath).catch(() => {});
    return this.get(id);
  }

  /** Synthesize narration for already-prepared TTS text and store it as a verified clip. */
  async synthesize(projectId: string, lang: string, text: string, voice: { provider: string; voice: string; rate?: number }, name?: string): Promise<AudioClip> {
    if (!text.trim()) throw bad('Nothing to synthesize');
    const provider = this.tts.get(voice.provider);
    const avail = await provider.available();
    if (!avail.ok) throw new EngineError('PROVIDER_ERROR', `${provider.name} is not available: ${avail.detail}`);
    const tmp = join(this.config.root, 'cache', `tts_${ulid()}.wav`);
    await mkdir(dirname(tmp), { recursive: true });
    try {
      await provider.synthesize({ text, voice: voice.voice, rate: voice.rate, outWav: tmp });
      return await this.importClip(
        projectId,
        tmp,
        { kind: 'narration', lang, name, provider: provider.id, voice: voice.voice, params: { rate: voice.rate ?? null, online: provider.terms.online }, license: { type: 'ai-generated', commercial_use: 'unknown', notes: `${provider.name}: ${provider.terms.commercialUse}` } },
        { moveSource: true },
      );
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** Clip ids referenced by this project's audio artifacts' current content. */
  referenced(projectId: string): Set<string> {
    const ids = new Set<string>();
    for (const a of this.engine.list(projectId, { kind: 'audio' })) {
      const c = this.engine.getContent(a.id) as NarrationContent | null;
      c?.chunks?.forEach((x) => ids.add(x.clip_id));
      c?.mix?.music?.forEach((x) => ids.add(x.clip_id));
      c?.mix?.sfx?.forEach((x) => ids.add(x.clip_id));
    }
    return ids;
  }

  async remove(id: string): Promise<void> {
    const c = this.get(id);
    if (this.referenced(c.project_id).has(id)) throw new EngineError('PROTECTED', 'This clip is used by a narration or mix; remove it from there first');
    this.engine.db.prepare('DELETE FROM audio_clips WHERE id = ?').run(id);
    await unlink(this.absPath(c)).catch(() => {});
  }

  /** Waveform preview: peak amplitude (0..1) per bucket, computed from the decoded audio. */
  async peaks(id: string, buckets = 200): Promise<{ duration: number; peaks: number[] }> {
    const c = this.get(id);
    const n = Math.min(2000, Math.max(10, Math.floor(buckets)));
    const rate = 8000;
    const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
      import('node:child_process').then(({ execFile }) => {
        execFile(ffmpegBinary(this.config.ffprobePath), ['-v', 'error', '-i', this.absPath(c), '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (err, out) =>
          err ? reject(new EngineError('TOOL_FAILED', 'Could not decode audio for waveform')) : resolve({ stdout: out as unknown as Buffer }),
        );
      });
    });
    const samples = stdout.length / 2;
    const per = Math.max(1, Math.floor(samples / n));
    const peaks: number[] = [];
    for (let b = 0; b < n; b++) {
      let max = 0;
      for (let i = b * per; i < Math.min(samples, (b + 1) * per); i++) max = Math.max(max, Math.abs(stdout.readInt16LE(i * 2)));
      peaks.push(Math.round((max / 32768) * 1000) / 1000);
    }
    return { duration: c.duration_seconds, peaks };
  }

  // ---- layout and readiness ----
  /** Place narration chunks on a timeline using their MEASURED durations (the authoritative anchor). */
  layout(content: NarrationContent): { chunks: LayoutChunk[]; total: number } {
    const gap = content.gap_seconds ?? 0.25;
    let t = 0;
    const chunks = content.chunks.map((x) => {
      const clip = this.get(x.clip_id);
      const c: LayoutChunk = { clip_id: x.clip_id, section_ids: x.section_ids, start: Math.round(t * 1000) / 1000, duration: clip.duration_seconds, path: this.absPath(clip) };
      t += clip.duration_seconds + gap;
      return c;
    });
    return { chunks, total: Math.round((t - (content.chunks.length ? gap : 0)) * 1000) / 1000 };
  }

  /** Cross-checks that need the database: clips exist, belong to this project/language, and sections are real. */
  checkContent(a: Artifact, content: NarrationContent, scriptSectionIds: Set<string> | null) {
    const seen = new Set<string>();
    for (const x of content.chunks) {
      const clip = this.engine.db.prepare('SELECT project_id, kind, lang_code FROM audio_clips WHERE id = ?').get(x.clip_id) as { project_id: string; kind: string; lang_code: string | null } | undefined;
      if (!clip) throw bad(`Narration clip ${x.clip_id} does not exist`);
      if (clip.project_id !== a.project_id) throw bad('Clip belongs to a different project');
      if (clip.kind !== 'narration' || clip.lang_code !== a.lang_code) throw bad(`Clip ${x.clip_id} is not "${a.lang_code}" narration`);
      for (const s of x.section_ids) {
        if (scriptSectionIds && !scriptSectionIds.has(s)) throw bad(`Section ${s} is not in the ${a.lang_code} script`);
        if (seen.has(s)) throw bad(`Section ${s} is covered by more than one clip`);
        seen.add(s);
      }
    }
    for (const m of [...(content.mix?.music ?? []), ...(content.mix?.sfx ?? [])]) {
      const clip = this.engine.db.prepare('SELECT project_id, kind FROM audio_clips WHERE id = ?').get(m.clip_id) as { project_id: string; kind: string } | undefined;
      if (!clip || clip.project_id !== a.project_id) throw bad(`Mix clip ${m.clip_id} does not exist in this project`);
    }
    for (const m of content.mix?.music ?? []) if (this.get(m.clip_id).kind !== 'music') throw bad(`Clip ${m.clip_id} is not music`);
    for (const m of content.mix?.sfx ?? []) if (this.get(m.clip_id).kind !== 'sfx') throw bad(`Clip ${m.clip_id} is not an sfx clip`);
  }

  readiness(content: NarrationContent, scriptSections: { id: string; text: string }[]) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const covered = new Set(content.chunks.flatMap((c) => c.section_ids));
    const missing = scriptSections.filter((s) => s.text.trim() && !covered.has(s.id)).map((s) => s.id);
    if (missing.length) errors.push(`No narration covers script section(s): ${missing.join(', ')}`);
    for (const x of content.chunks) {
      const clip = this.get(x.clip_id);
      if (clip.license.commercial_use === 'unknown') warnings.push(`Narration from ${clip.provider} has unverified commercial-use terms`);
    }
    for (const m of [...(content.mix?.music ?? []), ...(content.mix?.sfx ?? [])]) {
      const clip = this.get(m.clip_id);
      const r = licenseApprovalCheck(clip.license);
      for (const e of r.errors) errors.push(`${clip.kind} "${clip.name}": ${e}`);
      for (const w of r.warnings) warnings.push(`${clip.kind} "${clip.name}": ${w}`);
    }
    return { errors, warnings: [...new Set(warnings)] };
  }

  async runFfmpeg(args: string[], timeout = 300_000) {
    return run(ffmpegBinary(this.config.ffprobePath), ['-hide_banner', '-nostats', '-y', ...args], { timeout });
  }
}
