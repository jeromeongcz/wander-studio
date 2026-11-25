import { EngineError } from '../engine.ts';
import { estimate, isPreset, PRESETS } from './estimator.ts';
import type { CalibrationSample, Estimate, PresetId } from './estimator.ts';
import { validateCinematic, validateSceneCinematic } from './direction.ts';
import type { CinematicSettings, SceneCinematic } from './direction.ts';

export const SECTION_KINDS = ['hook', 'intro', 'main', 'payoff', 'cta', 'other'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface ScriptSection {
  id: string;
  kind: SectionKind;
  text: string; // clean display text (also what captions are anchored to)
  delivery_note?: string;
  tts_text?: string; // optional phonetic respelling for TTS, never shown in captions
  visual?: SceneVisual; // what the viewer sees while this narration plays; never narrated or captioned
  cinematic?: SceneCinematic; // camera, transition and look instructions; never narrated or captioned
}
/** The visual brief for one beat. Storyboard scenes are built from it. */
export const VISUAL_FIELDS = ['setting', 'characters', 'action', 'shot', 'mood', 'props'] as const;
export type SceneVisual = Partial<Record<(typeof VISUAL_FIELDS)[number], string>>;
/** A recurring character, described once so every scene draws them the same way. */
export interface ScriptCharacter {
  name: string;
  description: string;
}
export interface ScriptContent {
  title: string;
  lang: string;
  preset: PresetId;
  target_seconds?: number;
  sections: ScriptSection[];
  hook_variants?: { id: string; text: string; selected?: boolean }[];
  source_version_id?: string; // base-script version this adaptation was made from
  adaptation_notes?: string;
  characters?: ScriptCharacter[];
  cinematic_direction?: CinematicSettings; // the Cinematic Direction this script was written with
}

const bad = (message: string, details?: unknown) => new EngineError('VALIDATION', message, details);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateScriptShape(content: unknown): ScriptContent {
  if (!isObj(content)) throw bad('Script content must be an object');
  if (typeof content.title !== 'string') throw bad('title must be a string');
  if (typeof content.lang !== 'string' || !content.lang) throw bad('lang is required');
  if (!isPreset(content.preset)) throw bad(`preset must be one of ${Object.keys(PRESETS).join(', ')}`);
  if (content.target_seconds !== undefined && !(typeof content.target_seconds === 'number' && content.target_seconds > 0)) throw bad('target_seconds must be positive');
  if (!Array.isArray(content.sections)) throw bad('sections must be an array');
  const ids = new Set<string>();
  for (const s of content.sections) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.text !== 'string') throw bad('Each section needs an id and text');
    if (!SECTION_KINDS.includes(s.kind as SectionKind)) throw bad(`Section ${s.id} has invalid kind`);
    if (ids.has(s.id)) throw bad(`Duplicate section id ${s.id}`);
    ids.add(s.id);
    for (const k of ['delivery_note', 'tts_text'] as const) if (s[k] !== undefined && typeof s[k] !== 'string') throw bad(`${k} must be a string`);
    if (s.visual !== undefined && !(isObj(s.visual) && Object.entries(s.visual).every(([k, v]) => (VISUAL_FIELDS as readonly string[]).includes(k) && typeof v === 'string'))) throw bad(`Section ${s.id} has an invalid visual description`);
    if (s.cinematic !== undefined) validateSceneCinematic(s.cinematic, `Section ${s.id}`);
  }
  if (content.cinematic_direction !== undefined) validateCinematic(content.cinematic_direction);
  if (content.characters !== undefined && !(Array.isArray(content.characters) && content.characters.every((c) => isObj(c) && typeof c.name === 'string' && typeof c.description === 'string'))) throw bad('Invalid characters');
  for (const k of ['source_version_id', 'adaptation_notes'] as const) if (content[k] !== undefined && typeof content[k] !== 'string') throw bad(`${k} must be a string`);
  if (content.hook_variants !== undefined) {
    if (!Array.isArray(content.hook_variants) || !content.hook_variants.every((h) => isObj(h) && typeof h.id === 'string' && typeof h.text === 'string')) {
      throw bad('Invalid hook_variants');
    }
  }
  return content as unknown as ScriptContent;
}

export function scriptEstimate(c: ScriptContent, samples: CalibrationSample[], defaultWpm?: number): Estimate {
  return estimate({ sections: c.sections, lang: c.lang, preset: c.preset, targetSeconds: c.target_seconds, samples, defaultWpm });
}

export function scriptReadiness(c: ScriptContent, samples: CalibrationSample[], defaultWpm?: number): { errors: string[]; warnings: string[]; estimate: Estimate } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const filled = c.sections.filter((s) => s.text.trim());
  if (filled.length === 0) errors.push('Script has no text');
  const isShort = c.preset.startsWith('short_');
  if (isShort && filled.length && filled[0].kind !== 'hook') errors.push('Shorts scripts must open with a hook section');
  if (isShort && !c.sections.some((s) => s.kind === 'cta')) warnings.push('No CTA section');
  const est = scriptEstimate(c, samples, defaultWpm);
  if (est.overHardLimit) errors.push(`Estimated ${est.seconds}s exceeds the 60s Shorts limit`);
  else if (est.fit === 'over') warnings.push(`Estimated ${est.seconds}s is over the preset (${PRESETS[c.preset].label})`);
  else if (est.fit === 'under') warnings.push(`Estimated ${est.seconds}s is under the preset (${PRESETS[c.preset].label})`);
  return { errors, warnings, estimate: est };
}
