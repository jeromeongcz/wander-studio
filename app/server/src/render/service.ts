import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, stat, symlink, unlink, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { Engine, EngineError, canonical } from '../engine.ts';
import type { AssetService } from '../assets.ts';
import type { AudioService, NarrationContent } from '../audio/service.ts';
import { buildMixGraph } from '../audio/mix.ts';
import { alignHeuristic, tokenize } from '../captions/align.ts';
import { buildAss } from '../captions/ass.ts';
import { DEFAULT_STYLE } from '../captions/track.ts';
import type { CaptionTrack } from '../captions/track.ts';
import type { AppConfig } from '../config.ts';
import { ffmpegBinary, ffprobeBinary, run, sha256File } from '../media.ts';
import type { ScriptContent } from '../studios/script.ts';
import type { StoryboardContent } from '../studios/storyboard.ts';
import { ulid } from '../../../shared/src/index.ts';
import { parseFormat, safeZoneFor } from './formats.ts';
import type { SceneClipSpec } from './motion.ts';
import { sceneClipArgs, sceneClipKey } from './motion.ts';
import { buildTimeline, timelineHash, validateTimelineShape } from './timeline.ts';
import type { Timeline, TimelineScene } from './timeline.ts';

export interface RenderRow {
  id: string;
  project_id: string;
  lang_code: string;
  format: string;
  variant: 'captioned' | 'clean';
  rel_path: string;
  width: number;
  height: number;
  fps: number;
  duration_seconds: number;
  bytes: number;
  sha256: string;
  has_audio: number;
  timeline_hash: string;
  created_at: string;
}

const XFADE: Record<string, string> = { cut: 'fade', fade: 'fade', dissolve: 'dissolve', slide: 'slideleft', wipe: 'wipeleft', zoom: 'zoomin' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`; // quote a value inside an ffmpeg filter option

export class RenderService {
  engine: Engine;
  assets: AssetService;
  audio: AudioService;
  config: AppConfig;
  ffmpeg: string;
  ffprobe: string;

  constructor(engine: Engine, assets: AssetService, audio: AudioService, config: AppConfig) {
    this.engine = engine;
    this.assets = assets;
    this.audio = audio;
    this.config = config;
    this.ffmpeg = ffmpegBinary(config.ffprobePath);
    this.ffprobe = ffprobeBinary(config.ffprobePath);
  }

  private cache(...p: string[]) {
    return join(this.config.root, 'cache', ...p);
  }

  // ---- fonts ----
  fontDirs(): string[] {
    return [join(this.config.root, 'templates', 'fonts'), ...(this.config.fontDirs ?? ['/System/Library/Fonts/Supplemental', '/Library/Fonts', join(homedir(), 'Library', 'Fonts')])];
  }

  listFonts(): { family: string; path: string }[] {
    const out: { family: string; path: string }[] = [];
    for (const d of this.fontDirs()) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (/\.(ttf|otf)$/i.test(f)) out.push({ family: basename(f, extname(f)), path: join(d, f) });
    }
    return out;
  }

  /** libass has no fontconfig in this FFmpeg build, so give it a directory containing exactly the face(s) needed. A missing font is an error, never a silent substitution. */
  async prepareFonts(family: string): Promise<string> {
    const want = norm(family);
    const hits = this.listFonts().filter((f) => {
      const n = norm(f.family);
      return n === want || (n.startsWith(want) && /^(bold|italic|bolditalic|regular)$/.test(n.slice(want.length)));
    });
    if (!hits.length) throw new EngineError('VALIDATION', `Caption font "${family}" was not found. Add its .ttf to templates/fonts or pick an installed font.`, { searched: this.fontDirs() });
    const dir = this.cache('fonts', want);
    await mkdir(dir, { recursive: true });
    for (const h of hits) {
      const dest = join(dir, basename(h.path));
      if (!existsSync(dest)) await symlink(h.path, dest).catch(() => {});
    }
    return dir;
  }

  // ---- gather everything a timeline needs from the database ----
  private one(projectId: string, kind: string, lang?: string) {
    return this.engine.list(projectId, { kind: kind as never, lang_code: lang })[0];
  }

  private currentSource(compId: string) {
    const comp = this.engine.get(compId);
    const sb = this.one(comp.project_id, 'storyboard');
    const sbc = sb ? (this.engine.getContent(sb.id) as StoryboardContent | null) : null;
    const audio = this.one(comp.project_id, 'audio', comp.lang_code ?? undefined);
    const caption = this.one(comp.project_id, 'caption', comp.lang_code ?? undefined);
    const scenes: Record<string, string | null> = {};
    for (const s of sbc?.scenes ?? []) scenes[s.scene_id!] = this.engine.list(comp.project_id, { kind: 'scene_asset' }).find((a) => a.scene_id === s.scene_id)?.current_version_id ?? null;
    return { comp, sb, sbc, audio, caption, source: { storyboard: sb?.current_version_id ?? null, audio: audio?.current_version_id ?? null, caption: caption?.current_version_id ?? null, scene_assets: scenes } };
  }

  /** Is the stored timeline still built from the current upstream versions? */
  isStale(compId: string): boolean {
    const content = this.engine.getContent(compId) as Timeline | null;
    if (!content) return true;
    return canonical(content.source) !== canonical(this.currentSource(compId).source);
  }

  /** Estimated word times (proportional within each narration clip) used for scene timing before captions exist. */
  private estimatedWords(layout: ReturnType<AudioService['layout']>, script: ScriptContent) {
    const byId = new Map(script.sections.map((s) => [s.id, s]));
    return layout.chunks.flatMap((c) => {
      const words = tokenize(c.section_ids.flatMap((id) => (byId.has(id) ? [{ id, text: byId.get(id)!.text }] : [])));
      return alignHeuristic(words, c.duration, []).timings.map((t, i) => ({ section_id: words[i].section_id, start: c.start + t.start, end: c.start + t.end }));
    });
  }

  /** Word times on the narration timeline: the caption track when it exists, otherwise proportional estimates. */
  narrationWords(projectId: string, lang: string): { words: { section_id: string; start: number; end: number }[]; total: number; source: 'captions' | 'estimate' } | null {
    const audio = this.one(projectId, 'audio', lang);
    const narration = audio ? (this.engine.getContent(audio.id) as NarrationContent | null) : null;
    const scriptArt = this.one(projectId, 'script_lang', lang);
    const script = scriptArt ? (this.engine.getContent(scriptArt.id) as ScriptContent | null) : null;
    if (!narration || !script) return null;
    const layout = this.audio.layout(narration);
    const capArt = this.one(projectId, 'caption', lang);
    const track = capArt ? (this.engine.getContent(capArt.id) as CaptionTrack | null) : null;
    if (track?.words.length) return { words: track.words.map((w) => ({ section_id: w.section_id, start: w.start, end: w.end })), total: layout.total, source: 'captions' };
    return { words: this.estimatedWords(layout, script), total: layout.total, source: 'estimate' };
  }

  build(compId: string): Timeline {
    const { comp, sbc, audio, caption, source } = this.currentSource(compId);
    if (comp.kind !== 'composition' || !comp.lang_code || !comp.format) throw new EngineError('VALIDATION', 'Not a composition artifact');
    if (!sbc?.scenes.length) throw new EngineError('NO_VERSION', 'The storyboard has no scenes yet');
    const narration = audio ? (this.engine.getContent(audio.id) as NarrationContent | null) : null;
    if (!narration) throw new EngineError('NO_VERSION', `No narration audio for "${comp.lang_code}" yet`);
    const layout = this.audio.layout(narration);
    const scriptArt = this.one(comp.project_id, 'script_lang', comp.lang_code);
    const script = scriptArt ? (this.engine.getContent(scriptArt.id) as ScriptContent | null) : null;
    if (!script) throw new EngineError('NO_VERSION', `No "${comp.lang_code}" script yet`);
    const track = caption ? (this.engine.getContent(caption.id) as CaptionTrack | null) : null;
    const prev = this.engine.getContent(compId) as Timeline | null;

    const assets = new Map<string, any>();
    for (const sc of sbc.scenes) {
      const art = this.engine.list(comp.project_id, { kind: 'scene_asset' }).find((a) => a.scene_id === sc.scene_id);
      const c = art ? (this.engine.getContent(art.id) as { primary_asset_id?: string } | null) : null;
      if (c?.primary_asset_id) {
        const a = this.assets.get(c.primary_asset_id);
        assets.set(sc.scene_id!, { id: a.id, sha256: a.sha256, rel_path: a.rel_path, kind: a.media_kind, width: a.width, height: a.height, focal: a.focal });
      }
    }
    const clipRel = (id: string) => ({ clip_id: id, rel_path: this.audio.get(id).rel_path });
    return buildTimeline({
      lang: comp.lang_code,
      format: parseFormat(comp.format),
      scenes: sbc.scenes.map((s) => ({ scene_id: s.scene_id!, script_segment_id: s.script_segment_id, segment_text: s.segment_text, target_duration: s.target_duration, title: s.title, camera: s.camera, transition_in: s.transition_in })),
      assets,
      timelineWords: track?.words.length ? track.words.map((w) => ({ section_id: w.section_id, start: w.start, end: w.end })) : this.estimatedWords(layout, script),
      narration: {
        chunks: layout.chunks.map((c) => ({ clip_id: c.clip_id, rel_path: this.audio.get(c.clip_id).rel_path, start: c.start, duration: c.duration })),
        narration_total: layout.total,
        mix: narration.mix ?? {},
        music: (narration.mix?.music ?? []).map((m) => clipRel(m.clip_id)),
        sfx: (narration.mix?.sfx ?? []).map((m) => clipRel(m.clip_id)),
      },
      captionWords: track?.words ?? [],
      style: track?.style ?? DEFAULT_STYLE,
      overrides: prev?.overrides ?? {},
      source,
    });
  }

  // ---- rendering ----
  private async ensureSceneClip(tl: Timeline, s: TimelineScene, signal?: AbortSignal): Promise<{ path: string; cached: boolean }> {
    if (!s.asset) throw new EngineError('RENDER_INPUT', `Scene "${s.title}" has no asset`);
    const src = join(this.config.root, s.asset.rel_path);
    if (!existsSync(src)) throw new EngineError('RENDER_INPUT', `Asset file for scene "${s.title}" is missing`);
    const tIn = s.index === 0 ? 0 : s.transition_in.duration > 0 ? s.transition_in.duration : 1 / tl.format.fps;
    const spec: SceneClipSpec = {
      asset: { path: src, kind: s.asset.kind, width: s.asset.width, height: s.asset.height, sha256: s.asset.sha256 },
      focal: s.focal,
      camera: s.camera,
      crop: tl.overrides[s.scene_id]?.crop,
      duration: s.duration + tIn,
      width: tl.format.width,
      height: tl.format.height,
      fps: tl.format.fps,
    };
    const out = this.cache('scene_clips', `${sceneClipKey(spec)}.mp4`);
    if (existsSync(out) && (await stat(out)).size > 0) return { path: out, cached: true };
    await mkdir(dirname(out), { recursive: true });
    const tmp = `${out}.${ulid()}.tmp.mp4`;
    try {
      await run(this.ffmpeg, ['-hide_banner', '-nostats', '-y', ...sceneClipArgs(spec, tmp)], { timeout: 300_000, signal });
      await rename(tmp, out);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { path: out, cached: false };
  }

  private async ensureMix(tl: Timeline, signal?: AbortSignal): Promise<string> {
    const abs = (rel: string) => join(this.config.root, rel);
    const byId = (list: { clip_id: string; rel_path: string }[], id: string) => abs(list.find((x) => x.clip_id === id)!.rel_path);
    const graph = buildMixGraph({
      narration: tl.audio.chunks.map((c) => ({ path: abs(c.rel_path), start: c.start })),
      music: (tl.audio.mix.music ?? []).map((m) => ({ path: byId(tl.audio.music, m.clip_id), spec: m })),
      sfx: (tl.audio.mix.sfx ?? []).map((m) => ({ path: byId(tl.audio.sfx, m.clip_id), spec: m })),
      spec: tl.audio.mix,
      duration: tl.duration,
    });
    for (const p of graph.inputs) if (!existsSync(p)) throw new EngineError('RENDER_INPUT', 'An audio file used by this composition is missing');
    const key = createHash('sha256').update(graph.filter + graph.inputs.join('|')).digest('hex').slice(0, 32);
    const out = this.cache('mix', `${key}.wav`);
    if (existsSync(out)) return out;
    await mkdir(dirname(out), { recursive: true });
    const tmp = `${out}.${ulid()}.tmp.wav`;
    try {
      await run(this.ffmpeg, ['-hide_banner', '-nostats', '-y', ...graph.inputs.flatMap((p) => ['-i', p]), '-filter_complex', graph.filter, '-map', graph.out, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', tmp], { timeout: 300_000, signal });
      await rename(tmp, out);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return out;
  }

  private async assFile(tl: Timeline, offset = 0): Promise<{ path: string; fontsDir: string }> {
    const fmt = parseFormat(tl.format.id, { fps: tl.format.fps, bitrate: tl.format.bitrate });
    const text = buildAss({ words: tl.captions.words, style: tl.captions.style, format: fmt, zone: safeZoneFor(fmt), placement: tl.captions.placement, offset });
    const path = this.cache('ass', `${createHash('sha256').update(text).digest('hex').slice(0, 24)}.ass`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
    return { path, fontsDir: await this.prepareFonts(tl.captions.style.font_family) };
  }

  private async compose(tl: Timeline, clips: string[], mix: string, variant: 'captioned' | 'clean', out: string, signal?: AbortSignal) {
    const { fps } = tl.format;
    const filters: string[] = clips.map((_, i) => `[${i}:v]settb=AVTB,fps=${fps},setpts=PTS-STARTPTS,setsar=1[s${i}]`);
    let last = 's0';
    for (let i = 1; i < clips.length; i++) {
      const s = tl.scenes[i];
      const t = s.transition_in.duration > 0 ? s.transition_in.duration : 1 / fps;
      const offset = Math.max(0, s.start - t);
      filters.push(`[${last}][s${i}]xfade=transition=${XFADE[s.transition_in.type] ?? 'fade'}:duration=${t.toFixed(4)}:offset=${offset.toFixed(4)}[x${i}]`);
      last = `x${i}`;
    }
    if (variant === 'captioned' && tl.captions.enabled) {
      const ass = await this.assFile(tl);
      filters.push(`[${last}]ass=filename=${q(ass.path)}:fontsdir=${q(ass.fontsDir)}[cap]`);
      last = 'cap';
    }
    filters.push(`[${last}]format=yuv420p[vout]`);
    const rate = tl.format.bitrate ? ['-b:v', tl.format.bitrate] : ['-crf', '20'];
    await run(
      this.ffmpeg,
      ['-hide_banner', '-nostats', '-y', ...clips.flatMap((c) => ['-i', c]), '-i', mix, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', `${clips.length}:a`, '-t', tl.duration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', ...rate, '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out],
      { timeout: 900_000, signal },
    );
  }

  /** Never report success unless the output is real: ffprobe must see the expected streams, size and duration. */
  private async verify(file: string, tl: Timeline) {
    const bytes = (await stat(file).catch(() => null))?.size ?? 0;
    if (bytes <= 0) throw new EngineError('RENDER_VERIFY', 'Render produced an empty file');
    const { stdout } = await run(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000 });
    const j = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.find((s) => s.codec_type === 'audio');
    const duration = Number(j.format.duration);
    const problems: string[] = [];
    if (!v || v.codec_name !== 'h264') problems.push('video is not H.264');
    if (v && (v.width !== tl.format.width || v.height !== tl.format.height)) problems.push(`size is ${v.width}x${v.height}, expected ${tl.format.width}x${tl.format.height}`);
    if (!a || a.codec_name !== 'aac') problems.push('audio is missing or not AAC');
    if (!(Math.abs(duration - tl.duration) <= 0.25)) problems.push(`duration ${duration.toFixed(2)}s, expected ${tl.duration}s`);
    if (problems.length) throw new EngineError('RENDER_VERIFY', `Render failed verification: ${problems.join('; ')}`);
    return { bytes, duration, width: v!.width!, height: v!.height!, hasAudio: true };
  }

  /** Render a composition's stored timeline to verified MP4 masters. Scene clips are cached, so unchanged scenes are not re-rendered. */
  async render(compId: string, variants: ('captioned' | 'clean')[], opts: { signal?: AbortSignal; onProgress?: (pct: number, msg: string) => void } = {}): Promise<{ renders: RenderRow[]; scenes: { scene_id: string; cached: boolean }[] }> {
    const comp = this.engine.get(compId);
    const tl = validateTimelineShape(this.engine.getContent(compId));
    if (!variants.length || !variants.every((v) => v === 'captioned' || v === 'clean')) throw new EngineError('VALIDATION', 'variants must be captioned and/or clean');
    const { signal, onProgress } = opts;
    const total = tl.scenes.length + 1 + variants.length;
    let done = 0;
    const tick = (msg: string) => onProgress?.(++done / total, msg);
    const mix = await this.ensureMix(tl, signal);
    tick('Mixed audio');
    const sceneInfo: { scene_id: string; cached: boolean }[] = [];
    const clips: string[] = [];
    for (const s of tl.scenes) {
      const r = await this.ensureSceneClip(tl, s, signal);
      tick(`Scene ${s.index + 1}/${tl.scenes.length}${r.cached ? ' (cached)' : ''}`);
      clips.push(r.path);
      sceneInfo.push({ scene_id: s.scene_id, cached: r.cached });
    }
    const hash = timelineHash(tl);
    const rows: RenderRow[] = [];
    for (const variant of variants) {
      const id = ulid();
      const dirName = tl.format.id.replace(/[^\w-]/g, '_');
      const rel = join('projects', `proj_${comp.project_id}`, 'renders', dirName, `${tl.lang}_${variant}_${id}.mp4`);
      const out = join(this.config.root, rel);
      await mkdir(dirname(out), { recursive: true });
      try {
        await this.compose(tl, clips, mix, variant, out, signal);
        const v = await this.verify(out, tl);
        const row: RenderRow = { id, project_id: comp.project_id, lang_code: tl.lang, format: tl.format.id, variant, rel_path: rel, width: v.width, height: v.height, fps: tl.format.fps, duration_seconds: v.duration, bytes: v.bytes, sha256: await sha256File(out), has_audio: 1, timeline_hash: hash, created_at: new Date().toISOString() };
        this.engine.db
          .prepare('INSERT INTO renders (id, project_id, lang_code, format, variant, rel_path, width, height, fps, duration_seconds, bytes, sha256, has_audio, timeline_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(row.id, row.project_id, row.lang_code, row.format, row.variant, row.rel_path, row.width, row.height, row.fps, row.duration_seconds, row.bytes, row.sha256, row.has_audio, row.timeline_hash, row.created_at);
        rows.push(row);
        tick(`${variant} master verified`);
      } catch (e) {
        await rm(out, { force: true });
        throw e;
      }
    }
    return { renders: rows, scenes: sceneInfo };
  }

  listRenders(projectId: string, filter: { lang?: string; format?: string } = {}): RenderRow[] {
    const where = ['project_id = ?'];
    const args: string[] = [projectId];
    if (filter.lang) (where.push('lang_code = ?'), args.push(filter.lang));
    if (filter.format) (where.push('format = ?'), args.push(filter.format));
    return this.engine.db.prepare(`SELECT * FROM renders WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args) as unknown as RenderRow[];
  }

  getRender(id: string): RenderRow {
    const r = this.engine.db.prepare('SELECT * FROM renders WHERE id = ?').get(id) as unknown as RenderRow | undefined;
    if (!r) throw new EngineError('NOT_FOUND', `Render ${id} not found`);
    return r;
  }

  /** One frame at global time t with the live caption overlay, for previewing styling and safe zones. */
  async previewFrame(compId: string, t: number, withCaptions = true): Promise<Buffer> {
    const tl = validateTimelineShape(this.engine.getContent(compId));
    if (!(t >= 0 && t <= tl.duration)) throw new EngineError('VALIDATION', `t must be between 0 and ${tl.duration}`);
    const s = [...tl.scenes].reverse().find((x) => x.start <= t) ?? tl.scenes[0];
    const clip = await this.ensureSceneClip(tl, s);
    const preroll = s.index === 0 ? 0 : s.transition_in.duration > 0 ? s.transition_in.duration : 1 / tl.format.fps;
    const local = Math.max(0, t - s.start + preroll);
    const out = this.cache('preview', `${ulid()}.png`);
    await mkdir(dirname(out), { recursive: true });
    const vf: string[] = [];
    if (withCaptions && tl.captions.enabled) {
      // with input seeking the frame's timestamp restarts at 0, so shift caption times by t
      const ass = await this.assFile(tl, t);
      vf.push(`ass=filename=${q(ass.path)}:fontsdir=${q(ass.fontsDir)}`);
    }
    try {
      await run(this.ffmpeg, ['-hide_banner', '-nostats', '-y', '-ss', local.toFixed(3), '-i', clip.path, ...(vf.length ? ['-vf', vf.join(',')] : []), '-frames:v', '1', out], { timeout: 60_000 });
      return await readFile(out);
    } finally {
      await unlink(out).catch(() => {});
    }
  }
}
