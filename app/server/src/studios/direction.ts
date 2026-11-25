// "Cinematic Direction": what the person chooses in the Script step, how it is put to the script writer, and how the
// writer's per-scene instructions are checked. Instructions live beside the narration, never inside it.
import { EngineError } from '../engine.ts';
import { CAMERA_KEYS, DIRECTIONS, EASINGS, MOVEMENTS, validateCamera } from '../render/camera.ts';
import type { Movement } from '../render/camera.ts';
import { TRANSITIONS, TRANSITION_DIRECTIONS, TRANSITION_KEYS, validateTransition } from '../render/transitions.ts';
import type { Transition, TransitionSpec } from '../render/transitions.ts';
import { PARAMS, STYLES, STYLE_IDS, validateLookParams } from '../render/styles.ts';
import type { LookParams, ParamName, StyleId } from '../render/styles.ts';
import type { Camera } from '../render/motion.ts';

interface Choice<T> { label: string; guide: string; prefer: T[] }

export const CAMERA_CHOICES: Record<string, Choice<Movement>> = {
  automatic: { label: 'Automatic / AI directed', guide: 'Choose each move from what the scene needs.', prefer: [] },
  documentary: { label: 'Cinematic documentary', guide: 'Measured, motivated moves; let facts and places be read.', prefer: ['dolly_in', 'truck_right', 'ken_burns', 'pullback', 'static'] },
  dynamic: { label: 'Dynamic cinematic', guide: 'Varied, confident movement with depth.', prefer: ['tracking', 'orbit', 'crane_up', 'dolly_in', 'whip_pan'] },
  atmospheric: { label: 'Slow and atmospheric', guide: 'Slow establishing shots and patient holds.', prefer: ['slow_reveal', 'dolly_in', 'pullback', 'static', 'tilt_up'] },
  dramatic: { label: 'Dramatic and emotional', guide: 'Push in on emotional moments; hold still when it matters.', prefer: ['dolly_in', 'dramatic_push_in', 'static', 'pullback', 'crane_up'] },
  suspenseful: { label: 'Suspenseful', guide: 'Gradual tracking and reveals; unsettling stillness.', prefer: ['slow_reveal', 'tracking', 'static', 'dramatic_push_in', 'handheld'] },
  action: { label: 'Action and adventure', guide: 'Energetic moves, impacts and quick reframing.', prefer: ['tracking', 'whip_pan', 'impact_shake', 'crane_up', 'dramatic_push_in'] },
  minimal: { label: 'Minimal camera movement', guide: 'Mostly static or very subtle movement.', prefer: ['static', 'ken_burns', 'static', 'dolly_in'] },
  custom: { label: 'Custom', guide: 'Follow the custom direction.', prefer: [] },
};

export const TRANSITION_CHOICES: Record<string, Choice<Transition>> = {
  automatic: { label: 'Automatic / AI directed', guide: 'Choose each change from how the two scenes relate.', prefer: [] },
  smooth: { label: 'Cinematic smooth', guide: 'Dissolves, soft fades and matched cuts.', prefer: ['dissolve', 'match_cut', 'dissolve', 'fade'] },
  dramatic: { label: 'Dramatic', guide: 'Deliberate fades, reveals and the occasional flash.', prefer: ['fade', 'cut', 'zoom_reveal', 'flash'] },
  suspenseful: { label: 'Suspenseful', guide: 'Hard cuts, slow dark fades, a rare glitch on a reveal.', prefer: ['cut', 'fade', 'cut', 'blur_dissolve', 'glitch'] },
  dynamic: { label: 'Dynamic', guide: 'Pushes, whip pans and motion blur for energy.', prefer: ['push', 'cut', 'whip_pan', 'motion_blur', 'zoom_through'] },
  minimal: { label: 'Minimal', guide: 'Mostly hard cuts.', prefer: ['cut', 'cut', 'dissolve'] },
  custom: { label: 'Custom', guide: 'Follow the custom direction.', prefer: [] },
};

export const STYLE_CHOICES = ['automatic', ...STYLE_IDS] as const;
export const MAX_CUSTOM = 600;

export interface CinematicSettings {
  version: 1;
  camera: string;
  style: (typeof STYLE_CHOICES)[number];
  transition: string;
  custom_text: string;
}
export const DEFAULT_CINEMATIC: CinematicSettings = { version: 1, camera: 'automatic', style: 'automatic', transition: 'automatic', custom_text: '' };

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clean = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function validateCinematic(x: unknown): CinematicSettings {
  if (x === undefined || x === null) return { ...DEFAULT_CINEMATIC };
  if (!isObj(x)) throw bad('Cinematic direction must be an object');
  const pick = <T extends string>(key: 'camera' | 'style' | 'transition', list: readonly T[]) => {
    const v = x[key] ?? 'automatic';
    if (!list.includes(v as T)) throw bad(`Cinematic ${key} must be one of: ${list.join(', ')}`);
    return v as T;
  };
  if (x.custom_text !== undefined && (typeof x.custom_text !== 'string' || x.custom_text.length > MAX_CUSTOM)) throw bad(`Custom direction must be text of at most ${MAX_CUSTOM} characters`);
  return { version: 1, camera: pick('camera', Object.keys(CAMERA_CHOICES)), style: pick('style', STYLE_CHOICES), transition: pick('transition', Object.keys(TRANSITION_CHOICES)), custom_text: clean(x.custom_text, MAX_CUSTOM) };
}

export function cinematicChoices() {
  const list = <T>(o: Record<string, Choice<T>>) => Object.entries(o).map(([id, c]) => ({ id, label: c.label, guide: c.guide }));
  return { camera: list(CAMERA_CHOICES), transition: list(TRANSITION_CHOICES), style: STYLE_CHOICES.map((id) => (id === 'automatic' ? { id, label: 'Automatic / AI directed', guide: 'The writer picks one style for the video.' } : { id, label: STYLES[id].label, guide: STYLES[id].summary })) };
}

// ---- per-scene instructions ----
export const NOTE_FIELDS = ['lighting', 'color', 'atmosphere', 'composition', 'shot'] as const;
export type SceneCinematic = {
  camera?: Camera;
  transition?: TransitionSpec;
  look?: { style?: StyleId; params?: LookParams } & Partial<Record<(typeof NOTE_FIELDS)[number], string>>;
};

/** Strict check of stored script instructions. */
export function validateSceneCinematic(x: unknown, at: string): void {
  if (!isObj(x) || !Object.keys(x).every((k) => ['camera', 'transition', 'look'].includes(k))) throw bad(`${at}: invalid cinematic instructions`);
  if (x.camera !== undefined) validateCamera(x.camera, `${at}: camera`);
  if (x.transition !== undefined) validateTransition(x.transition, `${at}: transition`);
  const l = x.look;
  if (l === undefined) return;
  if (!isObj(l) || !Object.keys(l).every((k) => ['style', 'params', ...NOTE_FIELDS].includes(k))) throw bad(`${at}: invalid look`);
  if (l.style !== undefined && !(STYLE_IDS as readonly string[]).includes(l.style as string)) throw bad(`${at}: unknown visual style`);
  if (l.params !== undefined) validateLookParams(l.params, `${at}: look.params`);
  if (!NOTE_FIELDS.every((k) => l[k] === undefined || typeof l[k] === 'string')) throw bad(`${at}: look notes must be text`);
}

/** Keep the settings that pass the check, adding them one at a time; report the rest. */
function salvage<T>(raw: Record<string, unknown>, first: string, keys: string[], check: (x: unknown) => T, at: string, dropped: string[]): T | undefined {
  const given = (k: string) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '';
  let kept: Record<string, unknown>;
  let value: T;
  try {
    kept = { [first]: raw[first] };
    value = check(kept);
  } catch {
    dropped.push(`${at} "${String(raw[first]).slice(0, 40)}"`);
    return undefined;
  }
  for (const key of keys.filter((k) => k !== first && given(k))) {
    try {
      value = check({ ...kept, [key]: raw[key] });
      kept = { ...kept, [key]: raw[key] };
    } catch {
      dropped.push(`${at} ${key} "${JSON.stringify(raw[key]).slice(0, 40)}"`);
    }
  }
  return value;
}

/** The writer's instructions for one scene. Anything unknown or out of range is left out and listed, never guessed. */
export function parseSceneCinematic(raw: unknown, style: StyleId | undefined, scene: number, dropped: string[]): SceneCinematic | undefined {
  const out: SceneCinematic = {};
  const r = isObj(raw) ? raw : {};
  const at = `Scene ${scene}:`;
  if (isObj(r.camera)) {
    const camera = salvage(r.camera, 'movement', CAMERA_KEYS, (x) => validateCamera(x), `${at} camera`, dropped);
    if (camera) out.camera = camera;
  }
  if (scene > 1 && isObj(r.transition)) {
    const transition = salvage(r.transition, 'type', TRANSITION_KEYS, (x) => validateTransition(x), `${at} transition`, dropped);
    if (transition) out.transition = transition;
  }
  const l = isObj(r.look) ? r.look : {};
  const look: NonNullable<SceneCinematic['look']> = {};
  for (const k of NOTE_FIELDS) {
    const text = clean(l[k], 300);
    if (text) look[k] = text;
  }
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(isObj(l.effects) ? l.effects : {})) {
    try {
      if (PARAMS[k as ParamName]?.group === 'Colour') throw bad('not an effect');
      Object.assign(params, validateLookParams({ [k]: v }));
    } catch {
      dropped.push(`${at} effect "${k.slice(0, 30)}"`);
    }
  }
  if (Object.keys(params).length) look.params = params as LookParams;
  if (style) look.style = style;
  if (Object.keys(look).length) out.look = look;
  return Object.keys(out).length ? out : undefined;
}

/** The part of the script prompt that asks for camera, transition and look instructions. */
export function directionPrompt(c: CinematicSettings): string[] {
  const style = c.style !== 'automatic' ? STYLES[c.style] : undefined;
  const cameras = MOVEMENTS.map((m) => (DIRECTIONS[m].length ? `${m} (${DIRECTIONS[m].join('/')})` : m)).join(', ');
  const transitions = TRANSITIONS.map((t) => (TRANSITION_DIRECTIONS[t] ? `${t} (${TRANSITION_DIRECTIONS[t]!.join('/')})` : t)).join(', ');
  const effects = (Object.keys(PARAMS) as ParamName[]).filter((k) => PARAMS[k].group !== 'Colour').join(', ');
  return [
    'Cinematic direction (a creative guide, not a rigid rule: decide scene by scene):',
    `- Camera: ${CAMERA_CHOICES[c.camera].label}. ${CAMERA_CHOICES[c.camera].guide}${CAMERA_CHOICES[c.camera].prefer.length ? ` Moves that suit it: ${[...new Set(CAMERA_CHOICES[c.camera].prefer)].join(', ')}.` : ''}`,
    style
      ? `- Visual style: ${style.label}. ${style.summary} Pacing: ${style.pacing} Moves that suit it: ${style.cameras.join(', ')}. Changes that suit it: ${style.transitions.join(', ')}.${style.guidance ? ` ${style.guidance}` : ''}`
      : `- Visual style: choose ONE for the whole video and return it as "visual_style", one of: ${STYLE_IDS.filter((s) => s !== 'custom').join(', ')}. For Filipino myths and legends prefer folklore; use dark_folklore or horror only when the story is meant to frighten.${' '}If you choose folklore: ${STYLES.folklore.guidance}`,
    `- Transitions: ${TRANSITION_CHOICES[c.transition].label}. ${TRANSITION_CHOICES[c.transition].guide}`,
    c.custom_text ? `- Custom direction from the creator: ${c.custom_text}` : '',
    '',
    'For every section also return "cinematic". These are instructions for the editor: they are never narrated or captioned, and "text" must contain none of them.',
    `- "camera": {"movement", optional "direction", "intensity" (subtle/medium/strong), "easing" (${EASINGS.filter((e) => e !== 'custom').join('/')}), "move_seconds", "start_zoom" and "end_zoom" (1-2.5), "focal" {"x","y"} 0-1 where the subject is}. movement is one of: ${cameras}. The pictures are flat illustrations, so moves are 2D.`,
    `- "transition" (how this scene arrives; omit for the first): {"type", optional "direction", "duration" (0.1-2 seconds), "intensity" (subtle/medium/strong), "sound" (whoosh/impact)}. type is one of: ${transitions}.`,
    `- "look": {"shot", "composition", "lighting", "color", "atmosphere" as short phrases, optional "effects": {name: strength 0-1} using only: ${effects}}. Use effects sparingly.`,
    '- Fit each choice to the scene\'s purpose: a slow wide reveal to establish a place, a controlled push-in for an important character moment, stillness or slow movement for emotion, tracking or gradual reveal for suspense, dynamic moves for action, a deliberate pullback or hold to close.',
    '- Do not repeat the same camera movement in two sections in a row, and do not use one transition everywhere without a reason. Relate changes to the story: related scenes dissolve or match, new places move across, sudden events cut or flash.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '');
}
