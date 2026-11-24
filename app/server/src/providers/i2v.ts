import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EngineError } from '../engine.ts';
import type { Camera, SceneClipSpec } from '../render/motion.ts';
import { sceneClipArgs } from '../render/motion.ts';
import { run } from '../media.ts';

export interface ImageToVideoProvider {
  id: string;
  name: string;
  kind: 'image_to_video';
  /** Honest requirements shown BEFORE anything is enabled or downloaded. */
  requirements: { gpu: boolean; minRamGB: number; downloadsModel: boolean; online: boolean };
  terms: { freeTier: string; requiresKey: boolean; commercialUse: string; privacy: string };
  available(): Promise<{ ok: boolean; detail: string }>;
  generate(args: { spec: SceneClipSpec; outPath: string; ffmpeg: string; signal?: AbortSignal }): Promise<void>;
}

/** Plain-language motion prompt to a camera move. Deterministic keyword mapping, not an AI model. */
export function parseMotionPrompt(prompt: string): Camera {
  const p = prompt.toLowerCase();
  const intensity: Camera['intensity'] = /\b(fast|quick(ly)?|strong(ly)?|dramatic(ally)?)\b/.test(p) ? 'strong' : /\b(medium|moderate(ly)?)\b/.test(p) ? 'medium' : 'subtle';
  if (/ken ?burns/.test(p)) return { movement: 'ken_burns', intensity };
  if (/parallax/.test(p)) return { movement: 'parallax', intensity };
  if (/zoom(ing)? out|pull(ing)? back/.test(p)) return { movement: 'zoom', direction: 'out', intensity };
  if (/zoom|push in|closer/.test(p)) return { movement: 'zoom', direction: 'in', intensity };
  if (/pan(ning)? (to the )?right|left to right/.test(p)) return { movement: 'pan', direction: 'left_to_right', intensity };
  if (/pan(ning)? (to the )?left|right to left/.test(p)) return { movement: 'pan', direction: 'right_to_left', intensity };
  if (/pan/.test(p)) return { movement: 'pan', direction: 'left_to_right', intensity };
  if (/static|still|hold/.test(p)) return { movement: 'static' };
  return { movement: 'ken_burns', intensity };
}

/** The always-available fallback the plan calls for: a still animated with pan/zoom/Ken Burns. It does not generate new imagery. */
export const stillMotion: ImageToVideoProvider = {
  id: 'still-motion',
  name: 'Still-image camera motion (built in)',
  kind: 'image_to_video',
  requirements: { gpu: false, minRamGB: 4, downloadsModel: false, online: false },
  terms: { freeTier: 'Always free and offline', requiresKey: false, commercialUse: 'Inherits the source image license', privacy: 'Runs fully on this Mac' },
  async available() {
    return { ok: true, detail: 'Always available' };
  },
  async generate({ spec, outPath, ffmpeg, signal }) {
    if (spec.asset.kind !== 'image') throw new EngineError('VALIDATION', 'Still motion needs an image as its source');
    await mkdir(dirname(outPath), { recursive: true });
    await run(ffmpeg, ['-hide_banner', '-nostats', '-y', ...sceneClipArgs(spec, outPath)], { timeout: 300_000, signal });
  },
};

/**
 * AI image-to-video models (local ComfyUI/diffusers or cloud GPU services) are deliberately NOT bundled:
 * they need user-supplied endpoints or multi-GB model downloads that must be confirmed first. They would
 * implement ImageToVideoProvider and be registered explicitly; nothing falls back to them silently.
 */
export const I2V_PROVIDERS: ImageToVideoProvider[] = [stillMotion];
