import { Engine, EngineError } from './engine.ts';
import type { Artifact } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';
import type { Actor } from '../../shared/src/index.ts';
import { validateResearchShape, researchReadiness } from './studios/research.ts';
import type { ResearchContent } from './studios/research.ts';
import { validateScriptShape, scriptReadiness } from './studios/script.ts';
import type { ScriptContent } from './studios/script.ts';
import { resolveWpm } from './studios/estimator.ts';
import type { CalibrationSample } from './studios/estimator.ts';

/** Studio service layer: kind-specific validation on top of the generic engine. */
export class Studio {
  engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
  }

  samples(lang: string): CalibrationSample[] {
    return this.engine.db.prepare('SELECT words, seconds FROM speech_calibration WHERE lang_code = ? ORDER BY created_at DESC LIMIT 50').all(lang) as unknown as CalibrationSample[];
  }

  addCalibration(lang: string, words: number, seconds: number) {
    if (!(words >= 5) || !(seconds > 0)) throw new EngineError('VALIDATION', 'Calibration needs words >= 5 and seconds > 0');
    this.engine.db.prepare('INSERT INTO speech_calibration (id, lang_code, words, seconds, created_at) VALUES (?,?,?,?,?)').run(ulid(), lang, words, seconds, new Date().toISOString());
    return resolveWpm(lang, this.samples(lang));
  }

  save(id: string, content: unknown, opts: { actor?: Actor; reopen?: boolean } = {}) {
    const a = this.engine.get(id);
    const actor = opts.actor ?? 'user';
    this.validateShape(a, content, actor);
    return this.engine.saveVersion(id, content, { ...opts, actor });
  }

  private validateShape(a: Artifact, content: unknown, actor: Actor) {
    if (a.kind === 'research') validateResearchShape(content, actor, this.engine.getContent(a.id));
    else if (a.kind === 'script_base' || a.kind === 'script_lang') validateScriptShape(content);
  }

  /** Submit for review after kind-specific readiness checks. Returns non-blocking warnings. */
  submit(id: string, actor: Actor = 'user'): { warnings: string[] } {
    const a = this.engine.get(id);
    const content = this.engine.getContent(id);
    let warnings: string[] = [];
    if (content !== null) {
      let r: { errors: string[]; warnings: string[] } | null = null;
      if (a.kind === 'research') r = researchReadiness(validateResearchShape(content, 'user', content) as ResearchContent);
      else if (a.kind === 'script_base' || a.kind === 'script_lang') r = scriptReadiness(validateScriptShape(content) as ScriptContent, this.samples((content as ScriptContent).lang));
      if (r) {
        if (r.errors.length) throw new EngineError('NOT_READY', `${a.label} is not ready for review`, r.errors);
        warnings = r.warnings;
      }
    }
    this.engine.submitForReview(id, actor);
    return { warnings };
  }
}
