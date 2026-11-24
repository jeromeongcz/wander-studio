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

const LOCALE_CODE = /^[a-z][a-z0-9_-]{1,15}$/;

/** Studio service layer: kind-specific validation on top of the generic engine. */
export class Studio {
  engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
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
    const a = this.engine.get(id);
    const actor = opts.actor ?? 'user';
    this.validateShape(a, content, actor);
    return this.engine.saveVersion(id, content, { ...opts, actor });
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
}
