import { createHash } from 'node:crypto';
import { LOOK_FILTERS, SHOT_SECONDS, glitchFilters } from './effects.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Camera {
  movement: 'static' | 'pan' | 'zoom' | 'ken_burns' | 'parallax';
  direction?: string;
  intensity?: 'subtle' | 'medium' | 'strong';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Largest window of the target aspect inside the source, positioned around the focal point.
 * This is what keeps the subject in frame when one asset serves 9:16, 16:9 and 1:1.
 * `override` is a normalized crop (0..1) chosen by the creator for this scene.
 */
export function coverCrop(src: { w: number; h: number }, target: { w: number; h: number }, focal: { x: number; y: number }, override?: Rect): Rect {
  if (override) {
    const w = clamp(override.w, 0.05, 1) * src.w;
    const h = clamp(override.h, 0.05, 1) * src.h;
    return { x: even(clamp(override.x * src.w, 0, src.w - w)), y: even(clamp(override.y * src.h, 0, src.h - h)), w: even(w), h: even(h) };
  }
  const ta = target.w / target.h;
  let w = src.w;
  let h = src.h;
  if (src.w / src.h > ta) w = src.h * ta;
  else h = src.w / ta;
  const cw = Math.min(src.w, even(w));
  const ch = Math.min(src.h, even(h));
  return { x: clamp(Math.round(focal.x * src.w - cw / 2), 0, src.w - cw), y: clamp(Math.round(focal.y * src.h - ch / 2), 0, src.h - ch), w: cw, h: ch };
}

export interface MotionPlan {
  z0: number;
  z1: number;
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

const K = { subtle: 0.6, medium: 1, strong: 1.6 } as const;

/** Camera movement as zoom and centre keyframes (centre is relative to the cropped window). */
export function motionPlan(cam: Camera, focalRel: { x: number; y: number }): MotionPlan {
  const k = K[cam.intensity ?? 'subtle'];
  const amt = 0.1 * k;
  const still: MotionPlan = { z0: 1, z1: 1, cx0: 0.5, cy0: 0.5, cx1: 0.5, cy1: 0.5 };
  const rev = (p: MotionPlan): MotionPlan => ({ z0: p.z1, z1: p.z0, cx0: p.cx1, cy0: p.cy1, cx1: p.cx0, cy1: p.cy0 });
  switch (cam.movement) {
    case 'static':
      return still;
    case 'zoom': {
      const p = { z0: 1, z1: 1 + amt, cx0: focalRel.x, cy0: focalRel.y, cx1: focalRel.x, cy1: focalRel.y };
      return cam.direction === 'out' ? rev(p) : p;
    }
    case 'ken_burns': {
      const p = { z0: 1, z1: 1 + 1.2 * amt, cx0: 0.5, cy0: 0.5, cx1: 0.5 + (focalRel.x - 0.5) * 0.8, cy1: 0.5 + (focalRel.y - 0.5) * 0.8 };
      return cam.direction === 'out' ? rev(p) : p;
    }
    case 'pan': {
      const z = 1 + Math.max(0.12, amt);
      const pm = 0.9 * ((1 - 1 / z) / 2);
      const dir = cam.direction ?? 'left_to_right';
      if (dir === 'up' || dir === 'down') return { z0: z, z1: z, cx0: 0.5, cx1: 0.5, cy0: dir === 'up' ? 0.5 + pm : 0.5 - pm, cy1: dir === 'up' ? 0.5 - pm : 0.5 + pm };
      return { z0: z, z1: z, cy0: 0.5, cy1: 0.5, cx0: dir === 'right_to_left' ? 0.5 + pm : 0.5 - pm, cx1: dir === 'right_to_left' ? 0.5 - pm : 0.5 + pm };
    }
    case 'parallax': {
      // Honest approximation: true parallax needs separate depth layers. v1 = slow zoom plus lateral drift.
      const z = 1 + 1.2 * amt;
      const pm = 0.45 * ((1 - 1 / z) / 2);
      return { z0: 1, z1: z, cx0: 0.5 - pm, cy0: 0.5, cx1: 0.5 + pm, cy1: 0.5 };
    }
  }
}

const f = (n: number) => Number(n.toFixed(5));

/** ffmpeg zoompan expressions. Kept in single quotes by the caller so commas need no escaping. */
export function zoompanFilter(p: MotionPlan, frames: number, size: { w: number; h: number }, fps: number): string {
  const n = Math.max(2, frames);
  const [z, x, y] = motionExpressions(p, `on/${n - 1}`);
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${n}:s=${size.w}x${size.h}:fps=${fps}`;
}

function motionExpressions(p: MotionPlan, prog: string): [string, string, string] {
  const z = `${f(p.z0)}+(${f(p.z1)}-${f(p.z0)})*${prog}`;
  const x = `max(0,min(iw*(${f(p.cx0)}+(${f(p.cx1)}-${f(p.cx0)})*${prog})-iw/zoom/2,iw-iw/zoom))`;
  const y = `max(0,min(ih*(${f(p.cy0)}+(${f(p.cy1)}-${f(p.cy0)})*${prog})-ih/zoom/2,ih-ih/zoom))`;
  return [z, x, y];
}

/**
 * Several shots cut from one picture ("scale cuts"): each shot holds its own framing and linear move, and the change
 * between them is a hard cut on a single frame.
 */
export function shotsFilter(base: MotionPlan, shots: number, frames: number, size: { w: number; h: number }, fps: number, focalRel: { x: number; y: number }): string {
  const n = Math.max(2, frames);
  const per = Math.ceil(n / shots);
  const plans: MotionPlan[] = Array.from({ length: shots }, (_, i) => {
    if (i === 0) return base;
    // alternate a tight framing near the subject with a slightly wider one, pushing in then pulling out
    const z = i % 2 ? 1.34 : 1.12;
    const side = i % 4 < 2 ? -0.08 : 0.08;
    const cx = clamp(focalRel.x + (i % 2 ? 0 : side), 0, 1);
    return { z0: i % 2 ? z : z + 0.1, z1: i % 2 ? z + 0.1 : z, cx0: cx, cx1: cx, cy0: focalRel.y, cy1: focalRel.y };
  });
  const parts = plans.map((p, i) => motionExpressions(p, `min(1,(on-${i * per})/${Math.max(1, per - 1)})`));
  const pick = (k: 0 | 1 | 2) => parts.slice(0, -1).reduceRight((rest, e, i) => `if(lt(on,${(i + 1) * per}),${e[k]},${rest})`, parts[parts.length - 1][k]);
  return `zoompan=z='${pick(0)}':x='${pick(1)}':y='${pick(2)}':d=${n}:s=${size.w}x${size.h}:fps=${fps}`;
}

export interface SceneClipSpec {
  asset: { path: string; kind: 'image' | 'video'; width: number; height: number; sha256: string };
  focal: { x: number; y: number };
  camera: Camera;
  crop?: Rect; // normalized override
  duration: number;
  width: number;
  height: number;
  fps: number;
  effects?: 'folklore';
  glitch?: boolean; // the final shot of a folklore video
  hold?: boolean; // one continuous camera move, even in a style that cuts between framings
}

/** Cache key: any input that changes the pixels changes the key; anything else (captions, audio, other scenes) does not. */
export function sceneClipKey(s: SceneClipSpec): string {
  const { path: _p, ...asset } = s.asset;
  return createHash('sha256').update(JSON.stringify({ v: 1, asset, focal: s.focal, camera: s.camera, crop: s.crop ?? null, d: Math.round(s.duration * 1000), w: s.width, h: s.height, fps: s.fps, effects: s.effects, glitch: s.glitch, hold: s.hold })).digest('hex').slice(0, 32);
}

export function sceneClipArgs(s: SceneClipSpec, out: string): string[] {
  const frames = Math.max(2, Math.round(s.duration * s.fps));
  const crop = coverCrop({ w: s.asset.width, h: s.asset.height }, { w: s.width, h: s.height }, s.focal, s.crop);
  const cropF = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(s.fps), out];
  if (s.asset.kind === 'video') {
    // v1: stock video plays as-is (looped or trimmed); camera moves apply to stills only.
    return ['-stream_loop', '-1', '-i', s.asset.path, '-t', s.duration.toFixed(3), '-vf', `${cropF},scale=${s.width}:${s.height}:flags=lanczos,fps=${s.fps},setsar=1,format=yuv420p`, ...enc];
  }
  const focalRel = { x: clamp((s.focal.x * s.asset.width - crop.x) / crop.w, 0, 1), y: clamp((s.focal.y * s.asset.height - crop.y) / crop.h, 0, 1) };
  const plan = motionPlan(s.camera, focalRel);
  const over = 2; // oversample before zoompan to avoid integer-pixel jitter
  const size = { w: s.width, h: s.height };
  const shots = s.effects && !s.hold ? Math.max(1, Math.ceil(s.duration / SHOT_SECONDS - 0.25)) : 1;
  const camera = shots > 1 ? shotsFilter(plan, shots, frames, size, s.fps, focalRel) : zoompanFilter(plan, frames, size, s.fps);
  const look = s.effects ? [...LOOK_FILTERS, ...(s.glitch ? glitchFilters(frames / s.fps) : [])] : [];
  const chain = [cropF, `scale=${s.width * over}:${s.height * over}:flags=lanczos`, camera, 'setsar=1', ...look, 'format=yuv420p'];
  return ['-i', s.asset.path, '-vf', chain.join(','), '-frames:v', String(frames), ...enc];
}
