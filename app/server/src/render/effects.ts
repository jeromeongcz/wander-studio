// "Dark folklore" scene effects: the editing grammar of docs/style/dark-folklore-shorts.md (camera on every shot, hard
// cuts, scale cuts, a dark graded and grainy look with flicker, one big caption word, impact hits, a final glitch sting).
// Only the grammar is reused: pictures, words and sounds are the project's own or generated here.
import type { Timeline, TimelineScene } from './timeline.ts';
import type { Camera } from './motion.ts';

export const EFFECT_STYLES = ['folklore'] as const;
export type EffectStyle = (typeof EFFECT_STYLES)[number];

export const SHOT_SECONDS = 3; // a new framing at least this often
export const GLITCH_SECONDS = 0.6;

const CYCLE: Camera[] = [
  { movement: 'zoom', direction: 'in', intensity: 'medium' },
  { movement: 'pan', direction: 'left_to_right', intensity: 'medium' },
  { movement: 'zoom', direction: 'out', intensity: 'medium' },
  { movement: 'ken_burns', direction: 'in', intensity: 'medium' },
  { movement: 'pan', direction: 'right_to_left', intensity: 'medium' },
];
/** A camera on every shot: strong push-in to open and to close, alternating moves between. */
export function folkloreCamera(index: number, total: number): Camera {
  if (index === 0 || index === total - 1) return { movement: 'zoom', direction: 'in', intensity: 'strong' };
  return CYCLE[index % CYCLE.length];
}

export function applyEffects(tl: Timeline, style: EffectStyle | undefined): Timeline {
  if (!style) return tl;
  // the style sets camera, cuts and grade, except where the person overrode them in Compose & Render
  const scenes: TimelineScene[] = tl.scenes.map(({ look, ...s }, i) => ({
    ...s,
    ...(look && s.sources?.look === 'scene_override' ? { look } : {}),
    camera: s.asset?.animated?.camera_baked || s.sources?.camera ? s.camera : folkloreCamera(i, tl.scenes.length),
    transition_in: s.sources?.transition ? s.transition_in : { type: 'cut', duration: 0 },
  }));
  const { look: _wide, ...rest } = tl;
  return { ...rest, effects: style, scenes, captions: { ...tl.captions, mode: 'word' } };
}

/** Picture grade for one clip: darker, desaturated, vignette, living grain and a faint candle-like flicker. */
export const LOOK_FILTERS = [
  "eq=contrast=1.12:saturation=0.82:brightness='-0.035+0.02*sin(2*PI*t*6.3)*sin(2*PI*t*1.7)':eval=frame",
  'vignette=angle=PI/4.3',
  'noise=alls=4:allf=t',
];

/** The analog glitch over the last moments of the final shot: colour fringes, heavy noise and a stuttering flash. */
export function glitchFilters(clipSeconds: number): string[] {
  const when = `gte(t,${Math.max(0, clipSeconds - GLITCH_SECONDS).toFixed(3)})*lt(mod(n,5),3)`;
  return [`rgbashift=rh=-22:bh=22:gv=6:enable='${when}'`, `noise=alls=55:allf=t:enable='${when}'`, `eq=brightness=0.16:contrast=1.5:enable='gte(t,${Math.max(0, clipSeconds - GLITCH_SECONDS).toFixed(3)})*lt(mod(n,7),2)'`];
}

/** Where the low "hits" land: selectively, on the reveal, the last shot and the glitch. */
export function impactTimes(tl: Timeline): number[] {
  const last = tl.scenes[tl.scenes.length - 1];
  const times = [tl.scenes[1]?.start, last.start, Math.max(0, tl.duration - GLITCH_SECONDS)].filter((t): t is number => typeof t === 'number' && t > 0);
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))];
}
