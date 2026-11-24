import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Studio } from '../services.ts';
import { EngineError } from '../engine.ts';
import { ulid } from '../../../shared/src/index.ts';
import { licenseApprovalCheck } from '../license.ts';
import type { LicenseRecord } from '../license.ts';
import { ffmpegBinary, probeMedia, ffprobeBinary, run, sha256File } from '../media.ts';
import { coverCrop } from '../render/motion.ts';
import type { ScriptContent } from '../studios/script.ts';
import type { CaptionTrack } from '../captions/track.ts';
import type { NarrationContent } from '../audio/service.ts';
import { buildKitPrompt, formatChapters, generateKit, validateKit } from './kit.ts';
import type { KitContent, KitInput } from './kit.ts';

export interface ManifestItem {
  kind: 'visual' | 'narration' | 'music' | 'sfx' | 'font';
  id: string;
  name: string;
  provider: string;
  license: LicenseRecord | null;
  used_in: string[];
  notes?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');

export class PublishService {
  s: Studio;
  constructor(studio: Studio) {
    this.s = studio;
  }
  private get e() {
    return this.s.engine;
  }
  private get root() {
    return this.s.config.root;
  }

  // ---- license / attribution manifest ----
  licenseManifest(projectId: string) {
    const project = this.e.getProject(projectId);
    const items = new Map<string, ManifestItem>();
    const warnings: string[] = [];
    const use = (key: string, make: () => ManifestItem, where: string) => {
      const it = items.get(key) ?? make();
      if (!it.used_in.includes(where)) it.used_in.push(where);
      items.set(key, it);
    };
    for (const art of this.e.list(projectId, { kind: 'scene_asset' })) {
      const c = this.e.getContent(art.id) as { assets?: { asset_id: string }[] } | null;
      for (const l of c?.assets ?? []) {
        const a = this.s.assets.get(l.asset_id);
        use(`v:${a.id}`, () => ({ kind: 'visual', id: a.id, name: a.name, provider: a.provider, license: a.license, used_in: [], notes: a.source_asset_id ? 'Reused from the shared library' : undefined }), art.label);
      }
    }
    const fonts = new Set<string>();
    for (const art of this.e.list(projectId, { kind: 'audio' })) {
      const c = this.e.getContent(art.id) as NarrationContent | null;
      const where = `Audio (${art.lang_code})`;
      for (const ch of c?.chunks ?? []) {
        const clip = this.s.audio.get(ch.clip_id);
        use(`n:${clip.id}`, () => ({ kind: 'narration', id: clip.id, name: clip.name, provider: `${clip.provider}${clip.voice ? ` / ${clip.voice}` : ''}`, license: clip.license, used_in: [], notes: clip.params.online ? 'Synthesized by an online service' : undefined }), where);
      }
      for (const m of [...(c?.mix?.music ?? []), ...(c?.mix?.sfx ?? [])]) {
        const clip = this.s.audio.get(m.clip_id);
        use(`${clip.kind[0]}:${clip.id}`, () => ({ kind: clip.kind as 'music' | 'sfx', id: clip.id, name: clip.name, provider: clip.provider, license: clip.license, used_in: [] }), where);
      }
    }
    for (const art of this.e.list(projectId, { kind: 'caption' })) {
      const t = this.e.getContent(art.id) as CaptionTrack | null;
      if (t?.style.font_family) fonts.add(t.style.font_family);
    }
    for (const f of fonts) items.set(`f:${f}`, { kind: 'font', id: f, name: f, provider: 'font file on this machine', license: null, used_in: ['Burned-in captions'], notes: 'Text is rendered into the video. Confirm the font license allows this; system fonts may not be redistributable.' });

    const list = [...items.values()];
    for (const it of list) {
      if (!it.license) {
        if (it.kind === 'font') warnings.push(`Font "${it.name}": license not recorded; verify it allows embedding in video`);
        continue;
      }
      // Narration is one clip per section: report it once per provider/voice instead of once per clip.
      const label = it.kind === 'narration' ? `narration from ${it.provider}` : `${it.kind} "${it.name}"`;
      const generated = it.license.commercial_use === 'unknown' && it.license.type === 'ai-generated';
      const r = licenseApprovalCheck(it.license);
      for (const x of r.errors) warnings.push(`${label}: ${x}`);
      for (const x of r.warnings.filter((w) => !/^Attribution must/.test(w) && !(generated && /Commercial use is not recorded/.test(w)))) warnings.push(`${label}: ${x}`);
      if (generated) warnings.push(`${label}: generated speech; check that provider's terms before monetizing`);
    }
    const attribution = [...new Set(list.map((i) => i.license?.attribution_text?.trim()).filter((x): x is string => !!x))];
    return { project: { id: project.id, name: project.name }, generated_at: new Date().toISOString(), items: list, warnings: [...new Set(warnings)], attribution_lines: attribution };
  }

  creditsText(m: ReturnType<PublishService['licenseManifest']>): string {
    const lines = [`Credits for "${m.project.name}"`, ''];
    lines.push(...(m.attribution_lines.length ? m.attribution_lines.map((a) => `- ${a}`) : ['(no attribution required by recorded licenses)']));
    if (m.warnings.length) lines.push('', 'Licensing warnings (resolve before publishing):', ...m.warnings.map((w) => `! ${w}`));
    return lines.join('\n') + '\n';
  }

  // ---- publishing kit ----
  private kitInput(projectId: string, lang: string): KitInput & { languageName: string } {
    const project = this.e.getProject(projectId);
    if (!project.languages.includes(lang)) throw new EngineError('VALIDATION', `Project has no language ${lang}`);
    const script = this.e.list(projectId, { kind: 'script_lang', lang_code: lang })[0];
    const sc = script ? (this.e.getContent(script.id) as ScriptContent | null) : null;
    if (!sc) throw new EngineError('NO_VERSION', `Write the "${lang}" script first`);
    const research = this.e.list(projectId, { kind: 'research' })[0];
    const topic = ((research && (this.e.getContent(research.id) as { topic?: string } | null)?.topic) || project.name).trim();
    const nw = this.s.render.narrationWords(projectId, lang);
    const starts: { id: string; start: number }[] = [];
    for (const w of nw?.words ?? []) if (!starts.some((x) => x.id === w.section_id)) starts.push({ id: w.section_id, start: w.start });
    const isShort = sc.preset.startsWith('short_');
    const duration = nw?.total ?? this.s.estimateScript(sc);
    return { lang, projectName: project.name, topic, category: project.category ?? undefined, sections: sc.sections.map(({ id, kind, text }) => ({ id, kind, text })), isShort, durationSeconds: duration, sectionStarts: starts, credits: this.licenseManifest(projectId).attribution_lines, languageName: this.s.getLocale(lang)?.name ?? lang };
  }

  getKit(projectId: string, lang: string): { content: KitContent; updated_at: string } | null {
    const r = this.e.db.prepare('SELECT content_json, updated_at FROM publishing_kits WHERE project_id = ? AND lang_code = ?').get(projectId, lang) as { content_json: string; updated_at: string } | undefined;
    return r ? { content: JSON.parse(r.content_json), updated_at: r.updated_at } : null;
  }

  async saveKit(projectId: string, lang: string, content: unknown): Promise<KitContent> {
    this.e.getProject(projectId);
    const kit = validateKit(content);
    const t = new Date().toISOString();
    this.e.db
      .prepare('INSERT INTO publishing_kits (id, project_id, lang_code, content_json, created_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id, lang_code) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at')
      .run(ulid(), projectId, lang, JSON.stringify(kit), t, t);
    const dir = join(this.root, 'projects', `proj_${projectId}`, 'publishing');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `kit_${lang}.json`), JSON.stringify(kit, null, 2), 'utf8');
    return kit;
  }

  async generateKit(projectId: string, lang: string) {
    return this.saveKit(projectId, lang, generateKit(this.kitInput(projectId, lang)));
  }

  kitPrompt(projectId: string, lang: string) {
    return buildKitPrompt(this.kitInput(projectId, lang));
  }

  kitMarkdown(k: KitContent): string {
    return [`# Publishing kit`, '', '## Titles', ...k.title_options.map((t) => `- ${t}`), '', '## Description', k.description, '', '## Tags', k.tags.join(', '), '', '## Hashtags', k.hashtags.join(' '), ...(k.chapters.length ? ['', '## Chapters', formatChapters(k.chapters)] : []), '', '## Pinned comment ideas', ...k.pinned_comment_ideas.map((t) => `- ${t}`), '', '## Thumbnail text hooks', ...k.thumbnail_hooks.map((t) => `- ${t}`), '', '## Notes', ...k.notes.map((t) => `- ${t}`), ''].join('\n');
  }

  // ---- thumbnails ----
  listThumbnails(projectId: string, lang?: string) {
    return this.e.db.prepare(`SELECT * FROM thumbnails WHERE project_id = ? ${lang ? 'AND lang_code = ?' : ''} ORDER BY id DESC`).all(...(lang ? [projectId, lang] : [projectId])) as any[];
  }

  async createThumbnail(projectId: string, o: { lang: string; sceneId?: string; assetId?: string; text?: string; size?: string }) {
    const project = this.e.getProject(projectId);
    if (!project.languages.includes(o.lang)) throw new EngineError('VALIDATION', `Project has no language ${o.lang}`);
    let assetId = o.assetId;
    if (!assetId && o.sceneId) {
      const art = this.e.list(projectId, { kind: 'scene_asset' }).find((a) => a.scene_id === o.sceneId);
      assetId = (art && (this.e.getContent(art.id) as { primary_asset_id?: string } | null)?.primary_asset_id) || undefined;
    }
    if (!assetId) throw new EngineError('VALIDATION', 'Choose a scene or an asset for the thumbnail');
    const asset = this.s.assets.get(assetId);
    if (asset.project_id !== projectId) throw new EngineError('VALIDATION', 'Asset belongs to a different project');
    const m = (o.size ?? '1280x720').match(/^(\d{3,4})x(\d{3,4})$/);
    if (!m || Number(m[1]) % 2 || Number(m[2]) % 2 || Number(m[1]) < 320 || Number(m[1]) > 3840 || Number(m[2]) > 3840 || Number(m[2]) < 180) throw new EngineError('VALIDATION', 'size must be WxH with even values (e.g. 1280x720)');
    const W = Number(m[1]);
    const H = Number(m[2]);
    const text = (o.text ?? '').trim();
    if (text.length > 60) throw new EngineError('VALIDATION', 'Thumbnail text must be 60 characters or fewer');

    const crop = coverCrop({ w: asset.width, h: asset.height }, { w: W, h: H }, asset.focal);
    const vf = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, `scale=${W}:${H}:flags=lanczos`];
    const style = (this.e.getContent(this.e.list(projectId, { kind: 'caption', lang_code: o.lang })[0]?.id ?? '') as CaptionTrack | null)?.style;
    const family = style?.font_family ?? 'Arial Black';
    if (text) {
      const fontsDir = await this.s.render.prepareFonts(family);
      const lines = wrapLines(text.toUpperCase(), 18);
      const size = Math.round(H * (lines.length > 1 ? 0.14 : 0.17));
      const ass = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: T,${family},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${Math.round(size * 0.1)},0,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${Math.round(H * 0.1)},1`,
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', `Dialogue: 0,0:00:00.00,0:00:10.00,T,,0,0,0,,${lines.map((l) => l.replace(/[{}\\]/g, '')).join('\\N')}`, ''].join('\n');
      const assPath = join(this.root, 'cache', 'ass', `thumb_${createHash('sha256').update(ass).digest('hex').slice(0, 20)}.ass`);
      await mkdir(dirname(assPath), { recursive: true });
      await writeFile(assPath, ass, 'utf8');
      const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
      vf.push(`ass=filename=${q(assPath)}:fontsdir=${q(fontsDir)}`);
    }
    const id = ulid();
    const rel = join('projects', `proj_${projectId}`, 'assets', 'thumbnails', `${id}.jpg`);
    const out = join(this.root, rel);
    await mkdir(dirname(out), { recursive: true });
    const src = join(this.root, asset.rel_path);
    try {
      await run(ffmpegBinary(this.s.config.ffprobePath), ['-hide_banner', '-nostats', '-y', ...(asset.media_kind === 'video' ? ['-ss', '0.5'] : []), '-i', src, '-vf', vf.join(','), '-frames:v', '1', '-q:v', '2', out], { timeout: 60_000 });
      const p = await probeMedia(out, ffprobeBinary(this.s.config.ffprobePath));
      if (p.width !== W || p.height !== H) throw new EngineError('RENDER_VERIFY', `Thumbnail is ${p.width}x${p.height}, expected ${W}x${H}`);
      const bytes = (await stat(out)).size;
      this.e.db.prepare('INSERT INTO thumbnails (id, project_id, lang_code, rel_path, width, height, bytes, sha256, text, source_asset_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, o.lang, rel, W, H, bytes, await sha256File(out), text || null, asset.id, new Date().toISOString());
    } catch (e) {
      await unlink(out).catch(() => {});
      throw e;
    }
    return this.e.db.prepare('SELECT * FROM thumbnails WHERE id = ?').get(id) as any;
  }

  // ---- export package ----
  /** Collect approved masters, sidecars, thumbnail, kit and license manifest into one folder. Nothing is uploaded anywhere. */
  async exportPackage(projectId: string, o: { langs?: string[]; variants?: ('captioned' | 'clean')[]; archive?: boolean } = {}) {
    const project = this.e.getProject(projectId);
    const langs = o.langs ?? project.languages;
    for (const l of langs) if (!project.languages.includes(l)) throw new EngineError('VALIDATION', `Project has no language ${l}`);
    const variants = o.variants ?? ['captioned', 'clean'];
    const formats = (project.settings.formats as string[] | undefined) ?? [];
    const base = slug(project.name);
    const skipped: { item: string; reason: string }[] = [];
    const videos: { lang: string; format: string; variant: string; src: string; row: any }[] = [];

    for (const lang of langs) {
      for (const fmt of formats) {
        const fr = this.e.list(projectId, { kind: 'final_render', lang_code: lang, format: fmt })[0];
        if (!fr || fr.state !== 'approved') {
          skipped.push({ item: `${lang} ${fmt} video`, reason: `final render is ${fr?.state ?? 'missing'}; approve it first` });
          continue;
        }
        const content = this.e.getContent(fr.id) as { renders?: { render_id: string; variant: string }[] } | null;
        for (const v of variants) {
          const ref = content?.renders?.find((r) => r.variant === v);
          if (!ref) {
            skipped.push({ item: `${lang} ${fmt} ${v} video`, reason: 'this variant was not rendered' });
            continue;
          }
          const row = this.s.render.getRender(ref.render_id);
          videos.push({ lang, format: fmt, variant: v, src: join(this.root, row.rel_path), row });
        }
      }
    }
    if (!videos.length) throw new EngineError('VALIDATION', 'No approved final renders to export', skipped);

    const dir = join(this.root, 'exports', `${base}_${stamp()}`);
    await mkdir(join(dir, 'videos'), { recursive: true });
    const files: { path: string; bytes: number; sha256: string }[] = [];
    const record = async (rel: string) => files.push({ path: rel, bytes: (await stat(join(dir, rel))).size, sha256: await sha256File(join(dir, rel)) });

    for (const v of videos) {
      // re-verify at export time: the file must still exist, match its recorded hash, and be real media
      if (!existsSync(v.src)) throw new EngineError('RENDER_INPUT', `Rendered file for ${v.lang} ${v.format} ${v.variant} is missing`);
      if ((await sha256File(v.src)) !== v.row.sha256) throw new EngineError('RENDER_VERIFY', `Rendered file for ${v.lang} ${v.format} ${v.variant} changed after rendering`);
      const info = JSON.parse((await run(ffprobeBinary(this.s.config.ffprobePath), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', v.src], { timeout: 30_000 })).stdout) as { streams: { codec_type: string }[]; format: { duration: string } };
      if (!info.streams.some((x) => x.codec_type === 'video') || !info.streams.some((x) => x.codec_type === 'audio') || !(Number(info.format.duration) > 0)) throw new EngineError('RENDER_VERIFY', `${v.lang} ${v.format} ${v.variant} is not a valid video`);
      const rel = join('videos', `${base}_${v.lang}_${v.format}_${v.variant}.mp4`);
      await copyFile(v.src, join(dir, rel));
      await record(rel);
    }
    for (const lang of [...new Set(videos.map((v) => v.lang))]) {
      const cap = this.e.list(projectId, { kind: 'caption', lang_code: lang })[0];
      if (cap && cap.state === 'approved') {
        const ex = await this.s.exportSubtitles(cap.id);
        await mkdir(join(dir, 'subtitles'), { recursive: true });
        await writeFile(join(dir, 'subtitles', `${base}_${lang}.srt`), ex.srt, 'utf8');
        await writeFile(join(dir, 'subtitles', `${base}_${lang}.vtt`), ex.vtt, 'utf8');
        await record(join('subtitles', `${base}_${lang}.srt`));
        await record(join('subtitles', `${base}_${lang}.vtt`));
      } else skipped.push({ item: `${lang} subtitles`, reason: `captions are ${cap?.state ?? 'missing'}; approve them first` });
      const th = this.listThumbnails(projectId, lang)[0];
      if (th) {
        await mkdir(join(dir, 'thumbnails'), { recursive: true });
        await copyFile(join(this.root, th.rel_path), join(dir, 'thumbnails', `${base}_${lang}.jpg`));
        await record(join('thumbnails', `${base}_${lang}.jpg`));
      } else skipped.push({ item: `${lang} thumbnail`, reason: 'none created yet' });
      const kit = this.getKit(projectId, lang);
      if (kit) {
        await mkdir(join(dir, 'publishing'), { recursive: true });
        await writeFile(join(dir, 'publishing', `kit_${lang}.json`), JSON.stringify(kit.content, null, 2), 'utf8');
        await writeFile(join(dir, 'publishing', `kit_${lang}.md`), this.kitMarkdown(kit.content), 'utf8');
        await record(join('publishing', `kit_${lang}.json`));
        await record(join('publishing', `kit_${lang}.md`));
      } else skipped.push({ item: `${lang} publishing kit`, reason: 'not generated yet' });
    }
    const manifest = this.licenseManifest(projectId);
    await mkdir(join(dir, 'licenses'), { recursive: true });
    await writeFile(join(dir, 'licenses', 'license_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(join(dir, 'licenses', 'CREDITS.txt'), this.creditsText(manifest), 'utf8');
    await record(join('licenses', 'license_manifest.json'));
    await record(join('licenses', 'CREDITS.txt'));
    if (o.archive) {
      const a = await this.s.archive.create(projectId, join(dir, 'project_archive.wander.zip'));
      files.push({ path: 'project_archive.wander.zip', bytes: a.bytes, sha256: await sha256File(a.path) });
    }
    const summary = [`# ${project.name} export`, '', `Created ${new Date().toISOString()}. Review everything locally, then upload manually: this app never publishes for you.`, '', '## Files', ...files.map((f) => `- ${f.path} (${(f.bytes / 1024).toFixed(0)} KB)`), '', ...(skipped.length ? ['## Not included', ...skipped.map((s) => `- ${s.item}: ${s.reason}`), ''] : []), ...(manifest.warnings.length ? ['## Licensing warnings', ...manifest.warnings.map((w) => `- ${w}`), ''] : [])].join('\n');
    await writeFile(join(dir, 'EXPORT_SUMMARY.md'), summary, 'utf8');
    return { dir, files, skipped, warnings: manifest.warnings };
  }
}

function wrapLines(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width && lines.length < 1) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
