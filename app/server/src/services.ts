import { Engine, EngineError } from './engine.ts';
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
import type { StoryboardContent } from './studios/storyboard.ts';
import { addScene } from './pipeline.ts';
import { AssetService } from './assets.ts';
import { resolveConfig } from './config.ts';
import type { AppConfig } from './config.ts';
import type { AssetType } from './studios/storyboard.ts';

const LOCALE_CODE = /^[a-z][a-z0-9_-]{1,15}$/;

/** Studio service layer: kind-specific validation on top of the generic engine. */
export class Studio {
  engine: Engine;
  config: AppConfig;
  assets: AssetService;
  constructor(engine: Engine, config: Partial<AppConfig> = {}) {
    this.engine = engine;
    this.config = resolveConfig(config);
    this.assets = new AssetService(engine, this.config);
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
      const toSave = a.kind === 'storyboard' ? this.prepareStoryboard(a, content) : content;
      return this.engine.saveVersion(id, toSave, { ...opts, actor });
    });
  }

  /** Assign scene ids and order, and keep one scene_asset artifact per scene. Runs inside save()'s transaction. */
  private prepareStoryboard(a: Artifact, content: unknown): StoryboardContent {
    const sb = JSON.parse(JSON.stringify(validateStoryboardShape(content))) as StoryboardContent;
    sb.scenes.forEach((sc, i) => {
      if (!sc.scene_id) sc.scene_id = ulid();
      sc.order_index = i;
    });
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
  submit(id: string, actor: Actor = 'user'): { warnings: string[] } {
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
}
