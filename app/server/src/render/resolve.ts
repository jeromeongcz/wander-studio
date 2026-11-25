// Who wins when several places say how a scene should look. Pure functions: no database, no FFmpeg.
// Only values the renderer can really execute are accepted here; new kinds are added together with their rendering.
import { EngineError } from '../engine.ts';
import { validateCamera } from './camera.ts';
import { validateTransition } from './transitions.ts';
import type { TransitionSpec } from './transitions.ts';
export { MAX_TRANSITION, MIN_TRANSITION } from './transitions.ts';
import type { Scene } from '../studios/storyboard.ts';
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

export type TransitionChoice = TransitionSpec;
export interface DirectionOverride {
  camera?: Camera;
  transition?: TransitionChoice;
}

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export const validateCameraOverride = (x: unknown): Camera => validateCamera(x);

export const validateTransitionOverride = (x: unknown): TransitionChoice => validateTransition(x);

/** Check the camera and transition parts of a stored override, leaving crop and caption position alone. */
export function checkDirectionOverride(x: unknown): void {
  if (!isObj(x)) throw bad('An override must be an object');
  if (x.camera !== undefined) validateCameraOverride(x.camera);
  if (x.transition !== undefined) validateTransitionOverride(x.transition);
}
