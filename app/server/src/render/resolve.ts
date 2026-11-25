// Who wins when several places say how a scene should look. Pure functions: no database, no FFmpeg.
// Only values the renderer can really execute are accepted here; new kinds are added together with their rendering.
import { EngineError } from '../engine.ts';
import { TRANSITIONS } from '../studios/storyboard.ts';
import { validateCamera } from './camera.ts';
import type { Scene, Transition } from '../studios/storyboard.ts';
import type { Camera } from './motion.ts';

/** Strongest first. */
export const PRECEDENCE = [
  'scene_override', // Compose & Render, this scene
  'storyboard_user', // a storyboard value the person edited
  'composition_override', // Compose & Render, the whole video
  'ai', // generated scene direction
  'draft', // automatic draft storyboard
  'direction', // the Script Generation selection
  'default', // renderer default
] as const;
export type Source = (typeof PRECEDENCE)[number];

export function resolveLayers<T>(layers: Partial<Record<Source, T | undefined>> & { default: T }): { value: T; source: Source } {
  for (const source of PRECEDENCE) {
    const value = layers[source];
    if (value !== undefined) return { value, source };
  }
  return { value: layers.default, source: 'default' };
}

export type DirectedField = 'camera' | 'transition';

/**
 * Where a storyboard value came from. Without a recorded origin, an untouched automatic draft counts as a draft and
 * anything else counts as the person's own, so older storyboards are never overruled by a video-wide setting.
 */
export function storyboardSource(scene: Pick<Scene, 'origin' | 'draft'>, field: DirectedField): 'storyboard_user' | 'ai' | 'draft' {
  const origin = scene.origin?.[field] ?? (scene.draft ? 'draft' : 'user');
  return origin === 'user' ? 'storyboard_user' : origin;
}

export interface TransitionChoice {
  type: Transition;
  duration?: number; // requested seconds; the timeline shortens it when the scenes are too short
}
export interface DirectionOverride {
  camera?: Camera;
  transition?: TransitionChoice;
}

export const MIN_TRANSITION = 0.1;
export const MAX_TRANSITION = 2;
const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x: Record<string, unknown>, allowed: string[], what: string) => {
  const extra = Object.keys(x).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`${what} does not support: ${extra.join(', ')}`);
};

export const validateCameraOverride = (x: unknown): Camera => validateCamera(x);

export function validateTransitionOverride(x: unknown): TransitionChoice {
  if (!isObj(x) || !(TRANSITIONS as readonly string[]).includes(x.type as string)) throw bad(`transition.type must be one of: ${TRANSITIONS.join(', ')}`);
  onlyKeys(x, ['type', 'duration'], 'transition');
  const type = x.type as Transition;
  const d = x.duration;
  if (d === undefined) return { type };
  if (type === 'cut') throw bad('A cut has no duration');
  if (typeof d !== 'number' || !(d >= MIN_TRANSITION && d <= MAX_TRANSITION)) throw bad(`transition.duration must be ${MIN_TRANSITION} to ${MAX_TRANSITION} seconds`);
  return { type, duration: d };
}

/** Check the camera and transition parts of a stored override, leaving crop and caption position alone. */
export function checkDirectionOverride(x: unknown): void {
  if (!isObj(x)) throw bad('An override must be an object');
  if (x.camera !== undefined) validateCameraOverride(x.camera);
  if (x.transition !== undefined) validateTransitionOverride(x.transition);
}
