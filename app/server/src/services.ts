import { Engine, EngineError, canonical } from './engine.ts';
import type { Artifact } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';
import type { Actor } from '../../shared/src/index.ts';
import { validateResearchShape, researchReadiness } from './studios/research.ts';
import type { ResearchContent } from './studios/research.ts';
import { validateScriptShape, scriptReadiness } from './studios/script.ts';
import type { ScriptContent } from './studios/script.ts';
import { resolveWpm, FALLBACK_WPM } from './studios/estimator.ts';
import type { CalibrationSample } from './studios/estimator.ts';
import { buildAdaptationPrompt, compareScripts, detectMix, languageFitWarnings, ttsText } from './studios/locales.ts';
import type { LexiconEntry, Locale } from './studios/locales.ts';
import { validateStoryboardShape, storyboardReadiness, draftScenes, buildStoryboardPrompt, profileFor } from './studios/storyboard.ts';
import type { Scene, StoryboardContent } from './studios/storyboard.ts';
import { validateCameraOverride, validateTransitionOverride } from './render/resolve.ts';
import { validateLook } from './render/styles.ts';
import { addScene } from './pipeline.ts';
import { AssetService } from './assets.ts';
import { resolveConfig } from './config.ts';
import { AudioService, validateNarrationShape } from './audio/service.ts';
import type { NarrationContent } from './audio/service.ts';
import { RenderService } from './render/service.ts';
import { validateTimelineShape } from './render/timeline.ts';
import type { Timeline } from './render/timeline.ts';
import { validateMixShape } from './audio/mix.ts';
import type { MixSpec } from './audio/mix.ts';
import { alignHeuristic, alignWithAsr, tokenize } from './captions/align.ts';
import type { Confidence } from './captions/align.ts';
import { DEFAULT_STYLE, checkAgainstScript, toSrt, toVtt, validateTrackShape } from './captions/track.ts';
import type { CaptionTrack } from './captions/track.ts';
import { runWhisper, whisperStatus } from './captions/whisper.ts';
import { computeSceneTimes } from './render/timing.ts';
import { ffmpegBinary, detectSilences } from './media.ts';
import { ArchiveService } from './archive.ts';
import { PublishService } from './publish/service.ts';
import { CacheService } from './cache.ts';
import { TemplateService } from './templates.ts';
import { JobRunner } from './jobs.ts';
import { ResearchService } from './research/service.ts';
import { ScriptWriter } from './research/scriptwriter.ts';
import { SketchArtist } from './research/sketch.ts';
import type { JobHandler } from './jobs.ts';
import { requireHealthy, runPreflight } from './preflight.ts';
import { scriptEstimate } from './studios/script.ts';
import { mkdir, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import type { AssetType } from './studios/storyboard.ts';

const LOCALE_CODE = /^[a-z][a-z0-9_-]{1,15}$/;

/** A change to an override: a value sets it, null removes it, leaving it out keeps it. */
function applyDirection(target: Record<string, unknown>, change: { camera?: unknown; transition?: unknown; look?: unknown }) {
  for (const [key, check] of [['camera', validateCameraOverride], ['transition', validateTransitionOverride], ['look', validateLook]] as const) {
    const value = change[key];
    if (value === null) delete target[key];
    else if (value !== undefined) target[key] = check(value);
  }
}

/** Remember who set each scene's camera and transition. What the client sends for existing scenes is not trusted. */
function recordOrigins(before: StoryboardContent | null, after: StoryboardContent, actor: Actor) {
  const old = new Map((before?.scenes ?? []).map((s) => [s.scene_id, s]));
  const by = actor === 'user' ? 'user' : actor === 'ai' ? 'ai' : 'draft';
  for (const scene of after.scenes) {
    const was = old.get(scene.scene_id);
    if (!was) continue;
    const origin: NonNullable<Scene['origin']> = {};
    for (const [field, keys] of [['camera', ['camera']], ['transition', ['transition_in', 'transition_settings']], ['look', ['look']]] as const) {
      const same = keys.every((k) => canonical(scene[k] ?? null) === canonical(was[k] ?? null));
      const from = same ? was.origin?.[field] : by;
      if (from) origin[field] = from;
    }
    if (Object.keys(origin).length) scene.origin = origin;
    else delete scene.origin;
  }
}

/** Studio service layer: kind-specific validation on top of the generic engine. */
export class Studio {
  engine: Engine;
  config: AppConfig;
  assets: AssetService;
  audio: AudioService;
  render: RenderService;
  archive: ArchiveService;
  publish: PublishService;
  cache: CacheService;
  templates: TemplateService;
  jobs: JobRunner;
  research: ResearchService;
  writer: ScriptWriter;
  sketches: SketchArtist;
  constructor(engine: Engine, config: Partial<AppConfig> = {}) {
    this.engine = engine;
    this.config = resolveConfig(config);
    this.assets = new AssetService(engine, this.config);
    this.audio = new AudioService(engine, this.config);
    this.render = new RenderService(engine, this.assets, this.audio, this.config);
    this.archive = new ArchiveService(engine, this.config);
    this.publish = new PublishService(this);
    this.cache = new CacheService(this.config);
    this.templates = new TemplateService(engine);
    this.jobs = new JobRunner(engine, this.jobHandlers());
    this.research = new ResearchService(this);
    this.writer = new ScriptWriter(this);
    this.sketches = new SketchArtist(this);
  }

  estimateScript(sc: ScriptContent): number {
    return scriptEstimate(sc, this.samples(sc.lang), this.defaultWpm(sc.lang)).seconds;
  }

  preflight(needBytes?: number) {
    return runPreflight(this.config, {
      needBytes,
      fontsOk: () => {
        const have = this.render.listFonts().some((f) => f.family.toLowerCase().replace(/[^a-z0-9]/g, '') === DEFAULT_STYLE.font_family.toLowerCase().replace(/[^a-z0-9]/g, ''));
        return { ok: have, detail: have ? `"${DEFAULT_STYLE.font_family}" found` : `"${DEFAULT_STYLE.font_family}" not found in ${this.render.fontDirs().join(', ')}` };
      },
    });
  }

  /** Background job kinds. Heavy ones run a preflight first and report readable diagnostics when the environment cannot cope. */
  private jobHandlers(): Record<string, JobHandler> {
    const guard = (ctx: { signal: AbortSignal }) => {
      if (ctx.signal.aborted) throw new EngineError('CANCELLED', 'Cancelled');
    };
    return {
      render_composition: async (ctx) => {
        await requireHealthy(this.config, { fontsOk: undefined });
        ctx.log(`Rendering ${ctx.params.compositionId}`);
        return this.renderComposition(ctx.params.compositionId, ctx.params.variants ?? ['captioned', 'clean'], { reopen: ctx.params.reopen === true, signal: ctx.signal, onProgress: ctx.progress });
      },
      batch_render: async (ctx) => {
        await requireHealthy(this.config);
        const { langs, formats } = ctx.params as { langs?: string[]; formats?: string[] };
        const comps = this.engine.list(ctx.job.project_id, { kind: 'composition', state: 'approved' }).filter((c) => (!langs || langs.includes(c.lang_code!)) && (!formats || formats.includes(c.format!)));
        const items: { id: string; label: string; ok: boolean; error?: { code: string; message: string } }[] = [];
        for (const [i, c] of comps.entries()) {
          guard(ctx);
          ctx.progress(i / Math.max(1, comps.length), `Rendering ${c.label}`);
          try {
            await this.renderComposition(c.id, ctx.params.variants ?? ['captioned', 'clean'], { reopen: ctx.params.reopen === true, signal: ctx.signal });
            items.push({ id: c.id, label: c.label, ok: true });
            ctx.log(`${c.label}: rendered`);
          } catch (e) {
            if ((e as EngineError).code === 'CANCELLED') throw e;
            const err = e as EngineError;
            items.push({ id: c.id, label: c.label, ok: false, error: { code: err.code ?? 'INTERNAL', message: err.message } });
            ctx.log(`${c.label}: ${err.message}`, 'error');
          }
        }
        const failed = items.filter((x) => !x.ok);
        if (failed.length) throw new EngineError('BATCH_PARTIAL', `${failed.length} of ${items.length} renders failed; the others finished`, items);
        return { items, note: comps.length ? undefined : 'No approved compositions to render' };
      },
      research_topics: async (ctx) => this.research.run(ctx.params.batchId, ctx),
      sketch_scenes: async (ctx) => this.sketches.run(ctx),
      align_captions: async (ctx) => {
        guard(ctx);
        ctx.progress(0.1, 'Matching the script words to the narration');
        return this.alignCaptions(ctx.params.captionId, { method: ctx.params.method, reopen: ctx.params.reopen === true });
      },
      synthesize_narration: async (ctx) => {
        guard(ctx);
        return this.synthesizeNarration(ctx.params.audioId, { voice: ctx.params.voice, sectionIds: ctx.params.sectionIds, reopen: ctx.params.reopen === true, signal: ctx.signal, onProgress: ctx.progress });
      },
    };
  }

  applyCaptionStyle(captionId: string, templateId: string, opts: { reopen?: boolean } = {}) {
    const t = this.templates.get(templateId);
    if (t.kind !== 'caption_style') throw new EngineError('VALIDATION', 'Not a caption style template');
    const track = this.engine.getContent(captionId) as CaptionTrack | null;
    if (!track) throw new EngineError('NO_VERSION', 'Align captions before choosing a style');
    return this.save(captionId, { ...track, style: t.content }, { actor: 'user', reopen: opts.reopen });
  }

  applyScriptOutline(scriptId: string, templateId: string, o: { title: string; lang: string; preset: string }) {
    const a = this.engine.get(scriptId);
    if (a.kind !== 'script_base') throw new EngineError('VALIDATION', 'Outlines apply to the base script');
    if (a.current_version_id) throw new EngineError('VALIDATION', 'The base script already has content');
    const t = this.templates.get(templateId);
    if (t.kind !== 'script_outline') throw new EngineError('VALIDATION', 'Not a script outline template');
    const sections = (t.content.sections as { kind: string; guidance?: string }[]).map((s, i) => ({ id: `s${i + 1}`, kind: s.kind, text: '', delivery_note: s.guidance }));
    return this.save(scriptId, { title: o.title, lang: o.lang, preset: o.preset, sections }, { actor: 'user' });
  }

  // ---- locale registry ----
  listLocales(): Locale[] {
    return (this.engine.db.prepare('SELECT * FROM locales ORDER BY builtin DESC, code').all() as unknown as Locale[]).map((l) => ({ ...l }));
  }

  getLocale(code: string): Locale | undefined {
    const l = this.engine.db.prepare('SELECT * FROM locales WHERE code = ?').get(code) as unknown as Locale | undefined;
    return l && { ...l };
  }

  upsertLocale(code: string, name: string, bcp47: string, defaultWpm: number): Locale {
    if (!LOCALE_CODE.test(code)) throw new EngineError('VALIDATION', 'Locale code must be lowercase letters/digits/-/_ (2-16 chars)');
    if (!name.trim() || !bcp47.trim()) throw new EngineError('VALIDATION', 'name and bcp47 are required');
    if (!(defaultWpm >= 60 && defaultWpm <= 300)) throw new EngineError('VALIDATION', 'default_wpm must be between 60 and 300');
    const existing = this.getLocale(code);
    if (existing?.builtin) throw new EngineError('PROTECTED', `Built-in locale ${code} cannot be modified`);
    this.engine.db
      .prepare('INSERT INTO locales (code, name, bcp47, default_wpm, builtin) VALUES (?,?,?,?,0) ON CONFLICT(code) DO UPDATE SET name = excluded.name, bcp47 = excluded.bcp47, default_wpm = excluded.default_wpm')
      .run(code, name.trim(), bcp47.trim(), Math.round(defaultWpm));
    return this.getLocale(code)!;
  }

  assertLocales(codes: string[]) {
    const unknown = codes.filter((c) => !this.getLocale(c));
    if (unknown.length) throw new EngineError('VALIDATION', `Unregistered locale(s): ${unknown.join(', ')}`);
  }

  defaultWpm(lang: string): number {
    return this.getLocale(lang)?.default_wpm ?? FALLBACK_WPM;
  }

  // ---- calibration ----
  samples(lang: string): CalibrationSample[] {
    return this.engine.db.prepare('SELECT words, seconds FROM speech_calibration WHERE lang_code = ? ORDER BY created_at DESC LIMIT 50').all(lang) as unknown as CalibrationSample[];
  }

  addCalibration(lang: string, words: number, seconds: number) {
    if (!(words >= 5) || !(seconds > 0)) throw new EngineError('VALIDATION', 'Calibration needs words >= 5 and seconds > 0');
    this.engine.db.prepare('INSERT INTO speech_calibration (id, lang_code, words, seconds, created_at) VALUES (?,?,?,?,?)').run(ulid(), lang, words, seconds, new Date().toISOString());
    return this.wpm(lang);
  }

  wpm(lang: string) {
    return resolveWpm(lang, this.samples(lang), this.defaultWpm(lang));
  }

  // ---- saving and review ----
  save(id: string, content: unknown, opts: { actor?: Actor; reopen?: boolean } = {}) {
    return this.engine.tx(() => {
      const a = this.engine.get(id);
      const actor = opts.actor ?? 'user';
      this.validateShape(a, content, actor);
      // A refused or failing save rolls back everything, including scene-artifact sync.
      const toSave = a.kind === 'storyboard' ? this.prepareStoryboard(a, content, actor) : content;
      return this.engine.saveVersion(id, toSave, { ...opts, actor });
    });
  }

  /** Assign scene ids and order, and keep one scene_asset artifact per scene. Runs inside save()'s transaction. */
  private prepareStoryboard(a: Artifact, content: unknown, actor: Actor): StoryboardContent {
    const sb = JSON.parse(JSON.stringify(validateStoryboardShape(content))) as StoryboardContent;
    sb.scenes.forEach((sc, i) => {
      if (!sc.scene_id) sc.scene_id = ulid();
      sc.order_index = i;
    });
    recordOrigins(this.engine.getContent(a.id) as StoryboardContent | null, sb, actor);
    const keep = new Set(sb.scenes.map((sc) => sc.scene_id!));
    const assets = this.engine.list(a.project_id, { kind: 'scene_asset' });
    const existing = new Map(assets.map((x) => [x.scene_id, x]));

    for (const x of assets) {
      if (keep.has(x.scene_id!)) continue;
      const approvedBefore = (this.engine.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE artifact_id = ? AND approved_at IS NOT NULL').get(x.id) as { n: number }).n > 0;
      if (x.state === 'approved' || x.state === 'awaiting_review' || approvedBefore) {
        throw new EngineError('PROTECTED', `Scene asset "${x.label}" has approved or in-review work; reopen and discard it before removing the scene`);
      }
      this.engine.db.prepare('DELETE FROM artifacts WHERE id = ?').run(x.id);
      this.engine.db.prepare('DELETE FROM scene_timing WHERE scene_id = ?').run(x.scene_id);
    }
    for (const sc of sb.scenes) {
      if (!existing.has(sc.scene_id!)) addScene(this.engine, a.project_id, sc.title, { sceneId: sc.scene_id, invalidate: false });
    }
    return sb;
  }

  private validateShape(a: Artifact, content: unknown, actor: Actor) {
    if (a.kind === 'research') validateResearchShape(content, actor, this.engine.getContent(a.id));
    else if (a.kind === 'script_base') validateScriptShape(content);
    else if (a.kind === 'audio') {
      const n = validateNarrationShape(content);
      this.audio.checkContent(a, n, this.scriptSectionIds(a));
    } else if (a.kind === 'caption') {
      const t = validateTrackShape(content);
      if (t.lang !== a.lang_code) throw new EngineError('VALIDATION', `This artifact holds "${a.lang_code}" captions but content says "${t.lang}"`);
      const script = this.scriptSections(a);
      if (script) {
        const problems = checkAgainstScript(t.words, script);
        if (problems.length) throw new EngineError('VALIDATION', 'Caption text must match the approved script', problems);
      }
    } else if (a.kind === 'composition') validateTimelineShape(content);
    else if (a.kind === 'script_lang') {
      const s = validateScriptShape(content);
      // Per-language isolation: a language's script artifact only ever holds that language.
      if (s.lang !== a.lang_code) throw new EngineError('VALIDATION', `This artifact holds "${a.lang_code}" but content says lang "${s.lang}"`);
    }
  }

  private baseOf(scriptLang: Artifact): { artifact: Artifact; content: ScriptContent | null } {
    const base = this.engine.upstreamDirect(scriptLang.id).find((u) => u.kind === 'script_base');
    if (!base) throw new EngineError('NOT_FOUND', 'Base script not found');
    return { artifact: base, content: this.engine.getContent(base.id) as ScriptContent | null };
  }

  private scriptLang(id: string): { a: Artifact; content: ScriptContent } {
    const a = this.engine.get(id);
    if (a.kind !== 'script_lang') throw new EngineError('VALIDATION', 'Not a language script artifact');
    const content = this.engine.getContent(id) as ScriptContent | null;
    if (!content) throw new EngineError('NO_VERSION', 'This language script has no content yet');
    return { a, content };
  }

  /** Submit for review after kind-specific readiness checks. Returns non-blocking warnings. */
  async submit(id: string, actor: Actor = 'user'): Promise<{ warnings: string[] }> {
    const a = this.engine.get(id);
    const content = this.engine.getContent(id);
    let warnings: string[] = [];
    if (content !== null) {
      let r: { errors: string[]; warnings: string[] } | null = null;
      if (a.kind === 'research') r = researchReadiness(validateResearchShape(content, 'user', content) as ResearchContent);
      else if (a.kind === 'script_base') {
        const c = validateScriptShape(content);
        r = scriptReadiness(c, this.samples(c.lang), this.defaultWpm(c.lang));
      } else if (a.kind === 'script_lang') r = this.languageReadiness(a, validateScriptShape(content));
      else if (a.kind === 'audio') r = this.audio.readiness(validateNarrationShape(content), this.scriptSections(a) ?? []);
      else if (a.kind === 'caption') r = await this.captionReadiness(a, content as CaptionTrack);
      else if (a.kind === 'composition') r = this.compositionReadiness(a, content);
      else if (a.kind === 'scene_asset') r = this.assets.sceneReadiness(a.project_id, content, this.plannedAssetType(a));
      else if (a.kind === 'storyboard') {
        const base = this.storyboardBase(a);
        const sb = validateStoryboardShape(content);
        r = base.content ? storyboardReadiness(sb, base.content, { samples: this.samples(base.content.lang), defaultWpm: this.defaultWpm(base.content.lang) }) : { errors: ['The base script has no content yet'], warnings: [] };
      }
      if (r) {
        if (r.errors.length) throw new EngineError('NOT_READY', `${a.label} is not ready for review`, r.errors);
        warnings = r.warnings;
      }
    }
    this.engine.submitForReview(id, actor);
    return { warnings };
  }

  private languageReadiness(a: Artifact, c: ScriptContent) {
    const r = scriptReadiness(c, this.samples(c.lang), this.defaultWpm(c.lang));
    const { artifact: base, content: baseContent } = this.baseOf(a);
    if (baseContent) {
      const have = new Set(c.sections.filter((s) => s.text.trim()).map((s) => s.id));
      const missing = baseContent.sections.filter((s) => s.text.trim() && !have.has(s.id)).map((s) => s.id);
      if (missing.length) r.errors.push(`Missing adapted text for base section(s): ${missing.join(', ')}`);
      if (c.source_version_id && c.source_version_id !== base.current_version_id) {
        r.warnings.push('Adapted from an older version of the base script; compare and re-check');
      }
    }
    r.warnings.push(...languageFitWarnings(c.lang, c.sections.map((s) => s.text).join(' ')));
    return r;
  }

  // ---- localization workflow ----
  /** Create a starting draft for a language from the approved base script (a copy to adapt, by hand or via a pasted LLM answer). */
  seedFromBase(scriptLangId: string): { versionId: string } {
    const a = this.engine.get(scriptLangId);
    if (a.kind !== 'script_lang') throw new EngineError('VALIDATION', 'Not a language script artifact');
    if (a.current_version_id) throw new EngineError('VALIDATION', 'This language already has a draft; edit it instead of reseeding');
    const { artifact: base, content: b } = this.baseOf(a);
    if (base.state !== 'approved' || !b) throw new EngineError('UNMET_DEPENDENCY', 'Approve the base script before adapting it');
    const draft: ScriptContent = {
      title: b.title,
      lang: a.lang_code!,
      preset: b.preset,
      target_seconds: b.target_seconds,
      sections: b.sections.map((s) => ({ id: s.id, kind: s.kind, text: s.text })),
      source_version_id: base.current_version_id!,
      adaptation_notes: '',
    };
    const r = this.engine.saveVersion(scriptLangId, draft, { actor: 'system' });
    return { versionId: r.versionId };
  }

  adaptationPrompt(scriptLangId: string, notes?: string): string {
    const a = this.engine.get(scriptLangId);
    if (a.kind !== 'script_lang') throw new EngineError('VALIDATION', 'Not a language script artifact');
    const { content: b } = this.baseOf(a);
    if (!b) throw new EngineError('NO_VERSION', 'The base script has no content yet');
    const target = this.getLocale(a.lang_code!);
    if (!target) throw new EngineError('VALIDATION', `Locale ${a.lang_code} is not registered`);
    return buildAdaptationPrompt({ target, baseLang: b.lang, title: b.title, sections: b.sections.map(({ id, kind, text }) => ({ id, kind, text })), notes });
  }

  compare(scriptLangId: string) {
    const { a, content } = this.scriptLang(scriptLangId);
    const { artifact: base, content: b } = this.baseOf(a);
    if (!b) throw new EngineError('NO_VERSION', 'The base script has no content yet');
    const { rows, missing } = compareScripts(b, content);
    return {
      baseLang: b.lang,
      lang: content.lang,
      stale: !!content.source_version_id && content.source_version_id !== base.current_version_id,
      missing,
      rows,
    };
  }

  languageMix(scriptLangId: string) {
    const { content } = this.scriptLang(scriptLangId);
    const text = content.sections.map((s) => s.text).join(' ');
    return { ...detectMix(text), warnings: languageFitWarnings(content.lang, text), heuristic: true };
  }

  // ---- pronunciation ----
  listLexicon(projectId: string, lang: string): (LexiconEntry & { id: string })[] {
    return (this.engine.db.prepare('SELECT id, term, respelling FROM pronunciation_entries WHERE project_id = ? AND lang_code = ? ORDER BY term').all(projectId, lang) as any[]).map((r) => ({ ...r }));
  }

  /** Changing pronunciation changes how narration is generated, so it marks that language's audio (and downstream) for revision. Display text and other languages are untouched. */
  private lexiconChanged(projectId: string, lang: string): string[] {
    const [audio] = this.engine.list(projectId, { kind: 'audio', lang_code: lang });
    return audio ? this.engine.invalidate(audio.id, 'Pronunciation lexicon changed') : [];
  }

  setLexicon(projectId: string, lang: string, term: string, respelling: string) {
    if (!term.trim() || !respelling.trim()) throw new EngineError('VALIDATION', 'term and respelling are required');
    if (!this.engine.getProject(projectId).languages.includes(lang)) throw new EngineError('VALIDATION', `Project has no language ${lang}`);
    return this.engine.tx(() => {
      this.engine.db
        .prepare('INSERT INTO pronunciation_entries (id, project_id, lang_code, term, respelling, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id, lang_code, term) DO UPDATE SET respelling = excluded.respelling')
        .run(ulid(), projectId, lang, term.trim(), respelling.trim(), new Date().toISOString());
      return { invalidated: this.lexiconChanged(projectId, lang) };
    });
  }

  deleteLexicon(entryId: string) {
    return this.engine.tx(() => {
      const e = this.engine.db.prepare('SELECT project_id, lang_code FROM pronunciation_entries WHERE id = ?').get(entryId) as { project_id: string; lang_code: string } | undefined;
      if (!e) throw new EngineError('NOT_FOUND', 'Lexicon entry not found');
      this.engine.db.prepare('DELETE FROM pronunciation_entries WHERE id = ?').run(entryId);
      return { invalidated: this.lexiconChanged(e.project_id, e.lang_code) };
    });
  }

  ttsPreview(scriptLangId: string) {
    const { a, content } = this.scriptLang(scriptLangId);
    const entries = this.listLexicon(a.project_id, content.lang);
    return content.sections.map((s) => {
      const tts = ttsText(s, entries);
      return { id: s.id, display: s.text, tts, differs: tts !== s.text };
    });
  }

  // ---- storyboard ----
  private storyboardBase(sb: Artifact): { artifact: Artifact; content: ScriptContent | null } {
    if (sb.kind !== 'storyboard') throw new EngineError('VALIDATION', 'Not a storyboard artifact');
    const base = this.engine.upstreamDirect(sb.id).find((u) => u.kind === 'script_base');
    if (!base) throw new EngineError('NOT_FOUND', 'Base script not found');
    return { artifact: base, content: this.engine.getContent(base.id) as ScriptContent | null };
  }

  /** Create a deterministic draft storyboard from the approved base script. Visual descriptions are skeletons (draft: true) for a human or pasted-LLM creative pass. */
  seedStoryboard(storyboardId: string, sceneSeconds?: number) {
    const a = this.engine.get(storyboardId);
    const { artifact: base, content: b } = this.storyboardBase(a);
    if (a.current_version_id) throw new EngineError('VALIDATION', 'This storyboard already has content; edit it instead of reseeding');
    if (base.state !== 'approved' || !b) throw new EngineError('UNMET_DEPENDENCY', 'Approve the base script before generating a storyboard');
    const category = this.engine.getProject(a.project_id).category ?? undefined;
    const draft = draftScenes(b, category, { samples: this.samples(b.lang), defaultWpm: this.defaultWpm(b.lang), sceneSeconds });
    return this.save(storyboardId, draft, { actor: 'system' });
  }

  storyboardPrompt(storyboardId: string, notes?: string): string {
    const a = this.engine.get(storyboardId);
    const { content: b } = this.storyboardBase(a);
    if (!b) throw new EngineError('NO_VERSION', 'The base script has no content yet');
    return buildStoryboardPrompt({ category: this.engine.getProject(a.project_id).category ?? undefined, base: b, notes });
  }

  recommendations(category?: string) {
    return profileFor(category);
  }

  /** Narration length per scene is stored apart from the storyboard so audio changes never invalidate it. */
  setSceneTiming(sceneId: string, lang: string, audioSeconds: number) {
    if (!(audioSeconds > 0)) throw new EngineError('VALIDATION', 'audio_seconds must be positive');
    const exists = this.engine.db.prepare("SELECT 1 FROM artifacts WHERE scene_id = ? AND kind = 'scene_asset'").get(sceneId);
    if (!exists) throw new EngineError('NOT_FOUND', `Scene ${sceneId} not found`);
    this.engine.db
      .prepare('INSERT INTO scene_timing (scene_id, lang_code, audio_seconds, updated_at) VALUES (?,?,?,?) ON CONFLICT(scene_id, lang_code) DO UPDATE SET audio_seconds = excluded.audio_seconds, updated_at = excluded.updated_at')
      .run(sceneId, lang, audioSeconds, new Date().toISOString());
    return { sceneId, lang, audio_seconds: audioSeconds };
  }

  /** Effective scene durations for one language: measured audio when known, otherwise the storyboard estimate. */
  timeline(storyboardId: string, lang: string) {
    const a = this.engine.get(storyboardId);
    if (a.kind !== 'storyboard') throw new EngineError('VALIDATION', 'Not a storyboard artifact');
    const sb = this.engine.getContent(storyboardId) as StoryboardContent | null;
    if (!sb) throw new EngineError('NO_VERSION', 'This storyboard has no content yet');
    const rows = sb.scenes.map((s) => {
      const t = this.engine.db.prepare('SELECT audio_seconds FROM scene_timing WHERE scene_id = ? AND lang_code = ?').get(s.scene_id ?? '', lang) as { audio_seconds: number } | undefined;
      return { scene_id: s.scene_id, title: s.title, seconds: t ? t.audio_seconds : s.target_duration, source: t ? ('audio' as const) : ('estimate' as const) };
    });
    return { lang, total_seconds: Math.round(rows.reduce((n, r) => n + r.seconds, 0) * 10) / 10, scenes: rows, fully_anchored: rows.every((r) => r.source === 'audio') };
  }

  // ---- scene visuals ----
  private sceneArtifact(sceneId: string): Artifact {
    const row = this.engine.db.prepare("SELECT id FROM artifacts WHERE scene_id = ? AND kind = 'scene_asset'").get(sceneId) as { id: string } | undefined;
    if (!row) throw new EngineError('NOT_FOUND', `Scene ${sceneId} not found`);
    return this.engine.get(row.id);
  }

  private storyboardScene(projectId: string, sceneId: string) {
    const [sb] = this.engine.list(projectId, { kind: 'storyboard' });
    const content = sb ? (this.engine.getContent(sb.id) as StoryboardContent | null) : null;
    return content?.scenes.find((s) => s.scene_id === sceneId);
  }

  private plannedAssetType(a: Artifact): AssetType | undefined {
    return a.scene_id ? this.storyboardScene(a.project_id, a.scene_id)?.asset_type : undefined;
  }

  /** Link assets to a scene. Saving the scene's asset artifact invalidates its compositions; an approved scene needs reopen. */
  setSceneAssets(sceneId: string, links: { asset_id: string; role?: string }[], primary: string, opts: { reopen?: boolean } = {}) {
    const art = this.sceneArtifact(sceneId);
    this.assets.checkSceneLinks(art.project_id, links, primary);
    const content = { assets: links.map((l) => ({ asset_id: l.asset_id, role: l.role ?? (l.asset_id === primary ? 'primary' : 'overlay') })), primary_asset_id: primary };
    return this.save(art.id, content, { actor: 'user', reopen: opts.reopen });
  }

  sceneImagePrompt(sceneId: string, providerId = 'manual-prompt') {
    const art = this.sceneArtifact(sceneId);
    const scene = this.storyboardScene(art.project_id, sceneId);
    if (!scene) throw new EngineError('NOT_FOUND', 'Scene is not in the storyboard');
    const fmt = (this.engine.getProject(art.project_id).settings.formats as string[] | undefined)?.[0] ?? 'vertical_9x16';
    const aspect = fmt.includes('9x16') ? '9:16' : fmt.includes('1x1') ? '1:1' : '16:9';
    return { aspect, ...this.assets.providers.imagePrompt(providerId).buildPrompt({ description: scene.visual_description, style: scene.visual_style, assetType: scene.asset_type, aspect }) };
  }

  // ---- narration, captions, composition, rendering ----
  private scriptSections(a: Artifact): { id: string; text: string }[] | null {
    const art = this.engine.list(a.project_id, { kind: 'script_lang', lang_code: a.lang_code ?? undefined })[0];
    const c = art ? (this.engine.getContent(art.id) as ScriptContent | null) : null;
    return c ? c.sections.map(({ id, text }) => ({ id, text })) : null;
  }

  private scriptSectionIds(a: Artifact): Set<string> | null {
    const s = this.scriptSections(a);
    return s ? new Set(s.map((x) => x.id)) : null;
  }

  private async captionReadiness(a: Artifact, raw: CaptionTrack) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const t = validateTrackShape(raw);
    if (!t.words.length) errors.push('Caption track has no words; align captions first');
    const audioArt = this.engine.list(a.project_id, { kind: 'audio', lang_code: a.lang_code ?? undefined })[0];
    const narration = audioArt ? (this.engine.getContent(audioArt.id) as NarrationContent | null) : null;
    if (!narration) errors.push('No narration audio to align to');
    else if (JSON.stringify(narration.chunks.map((c) => c.clip_id)) !== JSON.stringify(t.audio_ref)) errors.push('Captions were aligned to different audio than the current narration; align again');
    const script = this.scriptSections(a);
    if (script) errors.push(...checkAgainstScript(t.words, script));
    try {
      await this.render.prepareFonts(t.style.font_family);
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (t.confidence !== 'high') warnings.push(`Word timing is ${t.confidence}-confidence (${t.method}); check it in the caption editor`);
    return { errors, warnings };
  }

  private compositionReadiness(a: Artifact, content: unknown) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let tl: Timeline;
    try {
      tl = validateTimelineShape(content);
    } catch (e) {
      return { errors: [`No valid timeline yet: ${(e as Error).message}. Build the timeline first.`], warnings };
    }
    if (this.render.isStale(a.id)) errors.push('The timeline is out of date with its storyboard, narration, captions or scene assets; rebuild it');
    const noAsset = tl.scenes.filter((s) => !s.asset).map((s) => s.title);
    if (noAsset.length) errors.push(`Scene(s) without an asset: ${noAsset.join(', ')}`);
    if (!tl.captions.enabled) warnings.push('No captions in this composition (clean render only)');
    const estimated = tl.scenes.filter((s) => s.timing_source === 'estimate').length;
    if (estimated) warnings.push(`${estimated} scene(s) are timed from estimates, not narration`);
    return { errors, warnings };
  }

  /** User approval plus the follow-ups it implies: audio approval anchors scene timing and calibrates speech rate. */
  approve(id: string, note?: string) {
    const a = this.engine.get(id);
    this.engine.approve(id, { actor: 'user', note });
    if (a.kind === 'audio' || a.kind === 'caption') this.anchorScenes(a.project_id, a.lang_code!);
    if (a.kind === 'audio') this.calibrateFromAudio(a);
  }

  private calibrateFromAudio(a: Artifact) {
    const n = this.engine.getContent(a.id) as NarrationContent | null;
    const script = this.scriptSections(a);
    if (!n || !script) return;
    const byId = new Map(script.map((s) => [s.id, s.text]));
    for (const c of n.chunks) {
      const words = c.section_ids.reduce((sum, id) => sum + tokenize([{ id, text: byId.get(id) ?? '' }]).length, 0);
      const secs = this.audio.get(c.clip_id).duration_seconds;
      if (words >= 5 && secs > 0) this.addCalibration(a.lang_code!, words, secs);
    }
  }

  /** Write measured per-scene durations (scene_timing) from the narration's real word times. */
  anchorScenes(projectId: string, lang: string) {
    const sb = this.engine.list(projectId, { kind: 'storyboard' })[0];
    const sbc = sb ? (this.engine.getContent(sb.id) as StoryboardContent | null) : null;
    const nw = this.render.narrationWords(projectId, lang);
    if (!sbc || !nw) return [];
    const times = computeSceneTimes(sbc.scenes.map((s) => ({ scene_id: s.scene_id!, script_segment_id: s.script_segment_id, segment_text: s.segment_text, target_duration: s.target_duration })), nw.words, nw.total);
    for (const t of times) if (t.source === 'audio') this.setSceneTiming(t.scene_id, lang, Math.max(0.1, t.duration));
    return times;
  }

  /** Generate narration with a TTS provider, one clip per script section (so a section can be redone alone). */
  async synthesizeNarration(audioId: string, opts: { voice: { provider: string; voice: string; rate?: number }; sectionIds?: string[]; reopen?: boolean; signal?: AbortSignal; onProgress?: (done: number, message?: string) => void }) {
    const a = this.engine.get(audioId);
    if (a.kind !== 'audio') throw new EngineError('VALIDATION', 'Not an audio artifact');
    const script = this.engine.list(a.project_id, { kind: 'script_lang', lang_code: a.lang_code ?? undefined })[0];
    const sc = script ? (this.engine.getContent(script.id) as ScriptContent | null) : null;
    if (!sc) throw new EngineError('NO_VERSION', `Write the "${a.lang_code}" script first`);
    const entries = this.listLexicon(a.project_id, a.lang_code!);
    const wanted = (opts.sectionIds ?? sc.sections.map((s) => s.id)).map((id) => {
      const sec = sc.sections.find((x) => x.id === id);
      if (!sec) throw new EngineError('VALIDATION', `Section ${id} is not in the script`);
      return sec;
    }).filter((s) => s.text.trim());
    if (!wanted.length) throw new EngineError('VALIDATION', 'No script text to narrate');
    if (a.state === 'approved' && !opts.reopen) throw new EngineError('PROTECTED', 'Narration is approved; pass reopen to regenerate it');
    const prev = (this.engine.getContent(audioId) as NarrationContent | null) ?? { chunks: [] };
    const made = new Map<string, string>();
    try {
      for (const [i, sec] of wanted.entries()) {
        if (opts.signal?.aborted) throw new EngineError('CANCELLED', 'Cancelled');
        opts.onProgress?.(i / wanted.length, `Speaking section ${i + 1} of ${wanted.length}`);
        const clip = await this.audio.synthesize(a.project_id, a.lang_code!, ttsText(sec, entries), opts.voice, `${a.lang_code}-${sec.id}`);
        made.set(sec.id, clip.id);
      }
      if (opts.signal?.aborted) throw new EngineError('CANCELLED', 'Cancelled');
    } catch (e) {
      // a cancelled or failed run leaves no half-made clips behind
      for (const id of made.values()) await this.audio.remove(id).catch(() => {});
      throw e;
    }
    const kept = prev.chunks.filter((c) => !c.section_ids.some((s) => made.has(s)));
    const chunks = [...kept, ...[...made].map(([sid, clip_id]) => ({ clip_id, section_ids: [sid] }))].sort((x, y) => sc.sections.findIndex((s) => s.id === x.section_ids[0]) - sc.sections.findIndex((s) => s.id === y.section_ids[0]));
    return this.save(audioId, { ...prev, chunks, voice: opts.voice }, { actor: 'user', reopen: opts.reopen });
  }

  /** Manual voiceover: one recording for the whole script, or for specific sections. */
  async importNarration(audioId: string, opts: { path: string; sectionIds?: string[]; name?: string; license?: unknown; reopen?: boolean }) {
    const a = this.engine.get(audioId);
    if (a.kind !== 'audio') throw new EngineError('VALIDATION', 'Not an audio artifact');
    const script = this.scriptSections(a);
    if (!script) throw new EngineError('NO_VERSION', `Write the "${a.lang_code}" script first`);
    const ids = opts.sectionIds ?? script.filter((s) => s.text.trim()).map((s) => s.id);
    if (a.state === 'approved' && !opts.reopen) throw new EngineError('PROTECTED', 'Narration is approved; pass reopen to replace it');
    const clip = await this.audio.importClip(a.project_id, opts.path, { kind: 'narration', lang: a.lang_code!, name: opts.name, license: opts.license ?? { type: 'own', commercial_use: 'yes', notes: 'Own voiceover recording' }, provider: 'manual-import' });
    const prev = (this.engine.getContent(audioId) as NarrationContent | null) ?? { chunks: [] };
    const kept = prev.chunks.map((c) => ({ ...c, section_ids: c.section_ids.filter((s) => !ids.includes(s)) })).filter((c) => c.section_ids.length);
    const chunks = [...kept, { clip_id: clip.id, section_ids: ids }].sort((x, y) => script.findIndex((s) => s.id === x.section_ids[0]) - script.findIndex((s) => s.id === y.section_ids[0]));
    return { clip, ...this.save(audioId, { ...prev, chunks }, { actor: 'user', reopen: opts.reopen }) };
  }

  setMix(audioId: string, mix: unknown, opts: { reopen?: boolean } = {}) {
    const prev = this.engine.getContent(audioId) as NarrationContent | null;
    if (!prev) throw new EngineError('NO_VERSION', 'Add narration before configuring the mix');
    return this.save(audioId, { ...prev, mix: validateMixShape(mix) as MixSpec }, { actor: 'user', reopen: opts.reopen });
  }

  whisperStatus() {
    return whisperStatus(this.config.whisper);
  }

  /** Build the canonical caption track: words come from the approved script, only timestamps come from the audio. */
  async alignCaptions(captionId: string, opts: { method?: 'heuristic' | 'asr'; reopen?: boolean } = {}) {
    const a = this.engine.get(captionId);
    if (a.kind !== 'caption') throw new EngineError('VALIDATION', 'Not a caption artifact');
    const audioArt = this.engine.list(a.project_id, { kind: 'audio', lang_code: a.lang_code ?? undefined })[0];
    const narration = audioArt ? (this.engine.getContent(audioArt.id) as NarrationContent | null) : null;
    if (!narration) throw new EngineError('NO_VERSION', `No narration audio for "${a.lang_code}" yet`);
    const script = this.scriptSections(a);
    if (!script) throw new EngineError('NO_VERSION', `No "${a.lang_code}" script yet`);
    const layout = this.audio.layout(narration);
    const ff = ffmpegBinary(this.config.ffprobePath);
    const method = opts.method ?? 'heuristic';
    const ws = this.whisperStatus();
    if (method === 'asr' && !ws.ready) throw new EngineError('VALIDATION', 'Whisper is not ready: set a model file you have downloaded (see GET /alignment/whisper for sizes and licenses)', ws);

    const words: CaptionTrack['words'] = [];
    const ranks: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
    let worst: Confidence = 'high';
    const notes: string[] = [];
    for (const c of layout.chunks) {
      const sw = tokenize(c.section_ids.flatMap((id) => script.filter((s) => s.id === id)));
      let timings;
      let conf: Confidence;
      if (method === 'asr') {
        const asr = await runWhisper({ ffmpeg: ff, bin: ws.binary!, model: ws.model!, clip: c.path, lang: a.lang_code! });
        const r = alignWithAsr(sw, asr, c.duration);
        timings = r.timings;
        conf = r.confidence;
        notes.push(`${r.matched}/${sw.length} words matched ASR`);
      } else {
        const h = alignHeuristic(sw, c.duration, await detectSilences(c.path, ff));
        timings = h.timings;
        conf = h.confidence;
        notes.push(h.note);
      }
      if (ranks[conf] < ranks[worst]) worst = conf;
      sw.forEach((w, i) => words.push({ text: w.text, start: Math.round((c.start + timings[i].start) * 1000) / 1000, end: Math.round((c.start + timings[i].end) * 1000) / 1000, section_id: w.section_id }));
    }
    const prev = this.engine.getContent(captionId) as CaptionTrack | null;
    const track: CaptionTrack = { lang: a.lang_code!, method: method === 'asr' ? 'asr-assisted' : 'heuristic', confidence: worst, note: [...new Set(notes)].join('; '), audio_ref: layout.chunks.map((c) => c.clip_id), duration: layout.total, words, style: prev?.style ?? DEFAULT_STYLE };
    return this.save(captionId, track, { actor: 'user', reopen: opts.reopen });
  }

  /** Write .srt/.vtt sidecars and the canonical track JSON into the project folder. */
  async exportSubtitles(captionId: string) {
    const a = this.engine.get(captionId);
    const track = this.engine.getContent(captionId) as CaptionTrack | null;
    if (a.kind !== 'caption' || !track) throw new EngineError('NO_VERSION', 'No caption track to export');
    const dir = join(this.config.root, 'projects', `proj_${a.project_id}`, 'captions');
    await mkdir(join(dir, 'exports'), { recursive: true });
    await mkdir(join(dir, 'tracks'), { recursive: true });
    const srt = toSrt(track.words);
    const vtt = toVtt(track.words);
    await writeFile(join(dir, 'exports', `${track.lang}.srt`), srt, 'utf8');
    await writeFile(join(dir, 'exports', `${track.lang}.vtt`), vtt, 'utf8');
    await writeFile(join(dir, 'tracks', `${track.lang}.json`), JSON.stringify(track, null, 2), 'utf8');
    // Record the export as a reviewable step (it depends on the captions, so caption edits invalidate it).
    const rec = this.engine.list(a.project_id, { kind: 'subtitle_export', lang_code: track.lang })[0];
    if (rec && rec.state !== 'approved') this.engine.saveVersion(rec.id, { srt: `captions/exports/${track.lang}.srt`, vtt: `captions/exports/${track.lang}.vtt`, caption_version: a.current_version_id, words: track.words.length }, { actor: 'user' });
    return { srt, vtt, files: [`captions/exports/${track.lang}.srt`, `captions/exports/${track.lang}.vtt`, `captions/tracks/${track.lang}.json`] };
  }

  buildComposition(compId: string, opts: { reopen?: boolean; effects?: string } = {}) {
    return { ...this.save(compId, this.render.build(compId, opts.effects), { actor: 'user', reopen: opts.reopen }) };
  }

  setSceneOverride(compId: string, sceneId: string, override: { crop?: { x: number; y: number; w: number; h: number }; caption_y_pct?: number | null; camera?: unknown; transition?: unknown; look?: unknown }, opts: { reopen?: boolean } = {}) {
    const tl = validateTimelineShape(this.engine.getContent(compId));
    const cur = { ...(tl.overrides[sceneId] ?? {}) } as Record<string, unknown>;
    if (override.crop !== undefined) {
      const c = override.crop;
      if (!(c && c.w > 0.05 && c.h > 0.05 && c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001)) throw new EngineError('VALIDATION', 'crop must be normalized x,y,w,h inside the image');
      cur.crop = c;
    }
    if (override.caption_y_pct !== undefined) {
      if (override.caption_y_pct === null) delete cur.caption_y_pct;
      else if (!(override.caption_y_pct >= 0.2 && override.caption_y_pct <= 0.98)) throw new EngineError('VALIDATION', 'caption_y_pct must be between 0.2 and 0.98');
      else cur.caption_y_pct = override.caption_y_pct;
    }
    const index = tl.scenes.findIndex((s) => s.scene_id === sceneId);
    if (index < 0) throw new EngineError('NOT_FOUND', `Scene ${sceneId} is not in this timeline`);
    if (override.transition && index === 0) throw new EngineError('VALIDATION', 'The first scene has no incoming transition');
    applyDirection(cur, override);
    const overrides = { ...tl.overrides, [sceneId]: cur };
    if (!Object.keys(cur).length) delete overrides[sceneId];
    // rebuild with the new overrides, so caption placement, camera and transitions all pick up the change
    return this.save(compId, this.render.build(compId, undefined, { overrides }), { actor: 'user', reopen: opts.reopen });
  }

  /** Camera, transition and style for every scene of one video. Scene overrides and the person's storyboard edits still win. */
  setCompositionOverride(compId: string, override: { camera?: unknown; transition?: unknown; look?: unknown }, opts: { reopen?: boolean } = {}) {
    if (this.engine.get(compId).kind !== 'composition') throw new EngineError('VALIDATION', 'Not a composition artifact');
    const tl = validateTimelineShape(this.engine.getContent(compId));
    const all = { ...tl.overrides_all } as Record<string, unknown>;
    applyDirection(all, override);
    return this.save(compId, this.render.build(compId, undefined, { overrides_all: all }), { actor: 'user', reopen: opts.reopen });
  }

  async renderComposition(compId: string, variants: ('captioned' | 'clean')[], opts: { reopen?: boolean; signal?: AbortSignal; onProgress?: (pct: number, msg: string) => void } = {}) {
    const comp = this.engine.get(compId);
    if (comp.kind !== 'composition') throw new EngineError('VALIDATION', 'Not a composition artifact');
    const finalArt = this.engine.list(comp.project_id, { kind: 'final_render', lang_code: comp.lang_code ?? undefined, format: comp.format ?? undefined })[0];
    if (finalArt?.state === 'approved' && !opts.reopen) throw new EngineError('PROTECTED', 'The final render is approved; pass reopen to render again');
    if (this.render.isStale(compId)) throw new EngineError('VALIDATION', 'The timeline is out of date; rebuild it before rendering');
    const result = await this.render.render(compId, variants, { signal: opts.signal, onProgress: opts.onProgress });
    if (finalArt) {
      const prev = (this.engine.getContent(finalArt.id) as { renders?: Record<string, unknown>[] } | null)?.renders ?? [];
      const latest = new Map<string, Record<string, unknown>>(prev.map((r) => [String(r.variant), r]));
      for (const r of result.renders) latest.set(r.variant, { render_id: r.id, variant: r.variant, rel_path: r.rel_path, sha256: r.sha256, duration_seconds: r.duration_seconds, width: r.width, height: r.height });
      this.save(finalArt.id, { renders: [...latest.values()], timeline_hash: result.renders[0].timeline_hash, composition_version: comp.current_version_id }, { actor: 'user', reopen: opts.reopen });
    }
    return result;
  }

  // ---- deleting a project ----
  private async dirSize(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    if (!existsSync(dir)) return { files, bytes };
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const r = await this.dirSize(p);
        files += r.files;
        bytes += r.bytes;
      } else if (e.isFile()) {
        files++;
        bytes += (await stat(p)).size;
      }
    }
    return { files, bytes };
  }

  /** What deleting a project would remove, shown to the person before they confirm. */
  async deletionPreview(projectId: string) {
    const p = this.engine.getProject(projectId);
    const count = (sql: string) => (this.engine.db.prepare(sql).get(projectId) as { n: number }).n;
    const disk = await this.dirSize(join(this.config.root, 'projects', `proj_${projectId}`));
    return {
      id: p.id,
      name: p.name,
      artifacts: count('SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ?'),
      approved: count("SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND state = 'approved'"),
      assets: count('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?'),
      audio_clips: count('SELECT COUNT(*) AS n FROM audio_clips WHERE project_id = ?'),
      renders: count('SELECT COUNT(*) AS n FROM renders WHERE project_id = ?'),
      active_jobs: count("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND state IN ('queued','running')"),
      files: disk.files,
      bytes: disk.bytes,
      keeps: ['Items you added to the shared library', 'Export packages and archives already saved under exports/'],
    };
  }

  /**
   * Permanently delete a project and its files. Irreversible, so it needs the exact project name, and it
   * refuses while the project has queued or running jobs. Files are moved aside first and only removed after
   * the database change succeeds; if the database change fails they are moved back.
   */
  async deleteProject(projectId: string, confirmName: unknown) {
    const p = this.engine.getProject(projectId);
    if (typeof confirmName !== 'string' || confirmName !== p.name) throw new EngineError('VALIDATION', 'Type the project name exactly to confirm deletion');
    const active = (this.engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND state IN ('queued','running')").get(projectId) as { n: number }).n;
    if (active) throw new EngineError('BUSY', `This project has ${active} queued or running job(s). Cancel them or wait, then try again.`);
    const dir = join(this.config.root, 'projects', `proj_${projectId}`);
    const trash = join(this.config.root, 'cache', `trash_${ulid()}`);
    let moved = false;
    if (existsSync(dir)) {
      await mkdir(join(this.config.root, 'cache'), { recursive: true });
      await rename(dir, trash);
      moved = true;
    }
    try {
      this.engine.tx(() => {
        const scenes = this.engine.db.prepare('SELECT scene_id FROM artifacts WHERE project_id = ? AND scene_id IS NOT NULL').all(projectId) as { scene_id: string }[];
        for (const s of scenes) this.engine.db.prepare('DELETE FROM scene_timing WHERE scene_id = ?').run(s.scene_id);
        this.engine.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      });
    } catch (e) {
      if (moved) await rename(trash, dir);
      throw e;
    }
    let cleanup: 'removed' | 'left in cache' = 'removed';
    if (moved) await rm(trash, { recursive: true, force: true }).catch(() => (cleanup = 'left in cache'));
    return { deleted: true, name: p.name, files_removed: moved, cleanup };
  }
}
