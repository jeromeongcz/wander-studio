// The cinematic camera. Pictures are flat, so every move here is a 2D simulation: eased zoom and reframing, with
// shake, small rotation, keystone and blur where a move calls for them. Pure functions: FFmpeg filter text only.
// The five original movements without extra settings do NOT come through here (see isClassicCamera), so videos made
// before this existed render exactly as they did.
import { EngineError } from '../engine.ts';
import type { Camera, MotionPlan } from './motion.ts';

export const CLASSIC_MOVEMENTS = ['static', 'pan', 'zoom', 'ken_burns', 'parallax'] as const;
export const CINEMATIC_MOVEMENTS = [
  'dolly_in', 'dolly_out', 'tracking', 'truck_left', 'truck_right', 'tilt_up', 'tilt_down', 'crane_up', 'crane_down',
  'orbit', 'slow_reveal', 'dramatic_push_in', 'pullback', 'handheld', 'impact_shake', 'whip_pan',
] as const;
export const MOVEMENTS = [...CLASSIC_MOVEMENTS, ...CINEMATIC_MOVEMENTS] as const;
export type Movement = (typeof MOVEMENTS)[number];
export const INTENSITIES = ['subtle', 'medium', 'strong', 'custom'] as const;
export type Intensity = (typeof INTENSITIES)[number];
export const EASINGS = ['linear', 'ease_in', 'ease_out', 'ease_in_out', 'cinematic', 'dramatic', 'custom'] as const;
export type Easing = (typeof EASINGS)[number];

const SIDES = ['left_to_right', 'right_to_left'] as const;
const ALL_SIDES = [...SIDES, 'up', 'down'] as const;
export const DIRECTIONS: Record<Movement, readonly string[]> = {
  static: [], pan: ALL_SIDES, zoom: ['in', 'out'], ken_burns: ['in', 'out'], parallax: [],
  dolly_in: [], dolly_out: [], tracking: SIDES, truck_left: [], truck_right: [], tilt_up: [], tilt_down: [],
  crane_up: [], crane_down: [], orbit: SIDES, slow_reveal: ALL_SIDES, dramatic_push_in: [], pullback: [],
  handheld: [], impact_shake: [], whip_pan: ALL_SIDES,
};

interface Point { x: number; y: number }
const NUMBERS = {
  amount: [0.1, 3], // strength, with intensity "custom"
  curve: [0.2, 5], // exponent, with easing "custom"
  start_zoom: [1, 2.5],
  end_zoom: [1, 2.5],
  move_seconds: [0.3, 60], // how long the move takes; the last framing is held after it
  rotation: [-8, 8], // degrees, reached at the end of the move
  shake: [0, 1],
  smoothness: [0, 1], // of the shake: 1 removes the fast jitter
  motion_blur: [0, 1],
} as const;
const POINTS = ['start', 'end', 'focal'] as const;
const BASIC = ['movement', 'direction', 'intensity'];
export const CAMERA_KEYS = [...BASIC, 'easing', ...Object.keys(NUMBERS), ...POINTS];

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Check a camera completely and return a clean copy. */
export function validateCamera(x: unknown, at = 'camera'): Camera {
  if (!isObj(x) || !(MOVEMENTS as readonly string[]).includes(x.movement as string)) throw bad(`${at}.movement must be one of: ${MOVEMENTS.join(', ')}`);
  const extra = Object.keys(x).filter((k) => !CAMERA_KEYS.includes(k));
  if (extra.length) throw bad(`${at} does not support: ${extra.join(', ')}`);
  const movement = x.movement as Movement;
  const out: Record<string, unknown> = { movement };
  if (x.direction !== undefined) {
    if (!DIRECTIONS[movement].includes(x.direction as string)) throw bad(DIRECTIONS[movement].length ? `${at}.direction for ${movement} must be one of: ${DIRECTIONS[movement].join(', ')}` : `${movement} has no direction`);
    out.direction = x.direction;
  }
  for (const [key, list] of [['intensity', INTENSITIES], ['easing', EASINGS]] as const) {
    if (x[key] === undefined) continue;
    if (!(list as readonly string[]).includes(x[key] as string)) throw bad(`${at}.${key} must be one of: ${list.join(', ')}`);
    out[key] = x[key];
  }
  for (const [key, [lo, hi]] of Object.entries(NUMBERS)) {
    const v = x[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw bad(`${at}.${key} must be between ${lo} and ${hi}`);
    out[key] = v;
  }
  for (const key of POINTS) {
    const p = x[key];
    if (p === undefined) continue;
    if (!isObj(p) || ![p.x, p.y].every((n) => typeof n === 'number' && n >= 0 && n <= 1)) throw bad(`${at}.${key} must be {x, y} between 0 and 1`);
    out[key] = { x: p.x, y: p.y };
  }
  return out as unknown as Camera;
}

/** One of the original movements with nothing new set: rendered by the original code path. */
export const isClassicCamera = (c: Camera) =>
  (CLASSIC_MOVEMENTS as readonly string[]).includes(c.movement) && c.intensity !== 'custom' && Object.keys(c).every((k) => BASIC.includes(k) || (c as unknown as Record<string, unknown>)[k] === undefined);

const STRENGTH = { subtle: 0.6, medium: 1, strong: 1.6 } as const;
export const strength = (c: Camera) => (c.intensity === 'custom' ? c.amount ?? 1 : STRENGTH[c.intensity ?? 'subtle']);

const f = (n: number) => Number(n.toFixed(5));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** FFmpeg expression for an easing curve applied to `p` (0..1). */
export function easingExpr(easing: Easing, p: string, curve = 1.6): string {
  switch (easing) {
    case 'linear': return `(${p})`;
    case 'ease_in': return `pow(${p},2)`;
    case 'ease_out': return `(1-pow(1-(${p}),2))`;
    case 'ease_in_out': return `if(lt(${p},0.5),2*pow(${p},2),1-pow(2-2*(${p}),2)/2)`;
    case 'cinematic': return `(pow(${p},3)*((${p})*((${p})*6-15)+10))`;
    case 'dramatic': return `pow(${p},3)`;
    case 'custom': return `pow(${p},${f(curve)})`;
  }
}

export interface CameraMove {
  plan: MotionPlan;
  easing: Easing;
  shake: { amp: number; kind: 'handheld' | 'impact' } | null;
  rotation: number; // degrees at the end of the move
  sway: number; // degrees of handheld roll
  keystone: { kind: 'orbit' | 'tilt_up' | 'tilt_down'; amount: number; reverse: boolean } | null;
  motionBlur: number;
  whip: Camera['direction'] | null;
}

const DEFAULT_EASING: Partial<Record<Movement, Easing>> = {
  dolly_in: 'cinematic', dolly_out: 'cinematic', tracking: 'ease_in_out', truck_left: 'ease_in_out', truck_right: 'ease_in_out',
  tilt_up: 'cinematic', tilt_down: 'cinematic', crane_up: 'cinematic', crane_down: 'cinematic', orbit: 'ease_in_out',
  slow_reveal: 'ease_in_out', dramatic_push_in: 'dramatic', pullback: 'ease_out', whip_pan: 'ease_out',
};

/** Zoom and centre keyframes plus the extras of one movement. `classic` supplies the keyframes of the original five. */
export function cameraMove(cam: Camera, focalRel: Point, classic: (c: Camera, focal: Point) => MotionPlan): CameraMove {
  const k = strength(cam);
  const amt = 0.1 * k;
  const focus = cam.focal ?? focalRel;
  const dir = cam.direction;
  const zoomed = (extra: number, min = 0.12) => 1 + Math.max(min, extra);
  const room = (z: number) => 0.9 * ((1 - 1 / z) / 2); // how far the centre can travel at this zoom
  const at = (z0: number, z1: number, c0: Point, c1: Point): MotionPlan => ({ z0, z1, cx0: c0.x, cy0: c0.y, cx1: c1.x, cy1: c1.y });
  const centre = { x: 0.5, y: 0.5 };
  const move: CameraMove = { plan: at(1, 1, centre, centre), easing: DEFAULT_EASING[cam.movement as Movement] ?? 'linear', shake: null, rotation: cam.rotation ?? 0, sway: 0, keystone: null, motionBlur: cam.motion_blur ?? 0, whip: null };
  /** travel along one axis at a fixed zoom, around the subject */
  const slide = (z: number, towards: string): [Point, Point] => {
    const r = room(z);
    const sign = towards === 'right_to_left' || towards === 'up' ? -1 : 1;
    return towards === 'up' || towards === 'down'
      ? [{ x: focus.x, y: 0.5 - sign * r }, { x: focus.x, y: 0.5 + sign * r }]
      : [{ x: 0.5 - sign * r, y: focus.y }, { x: 0.5 + sign * r, y: focus.y }];
  };

  switch (cam.movement) {
    case 'static': case 'pan': case 'zoom': case 'ken_burns': case 'parallax':
      move.plan = classic(cam, focus);
      break;
    case 'dolly_in': move.plan = at(1, 1 + 1.6 * amt, centre, focus); break;
    case 'dolly_out': move.plan = at(1 + 1.6 * amt, 1, focus, centre); break;
    case 'dramatic_push_in': move.plan = at(1, 1 + 3 * amt, focus, focus); break;
    case 'pullback': move.plan = at(1 + 3 * amt, 1, focus, centre); break;
    case 'tracking': {
      const z = zoomed(1.4 * amt, 0.16);
      const [from] = slide(z, dir ?? 'left_to_right');
      move.plan = at(z, z + 0.4 * amt, from, focus);
      break;
    }
    case 'truck_left': case 'truck_right': {
      const z = zoomed(1.4 * amt, 0.14);
      const [a, b] = slide(z, cam.movement === 'truck_left' ? 'right_to_left' : 'left_to_right');
      move.plan = at(z, z, a, b);
      break;
    }
    case 'tilt_up': case 'tilt_down': {
      const z = zoomed(1.5 * amt, 0.14);
      const [a, b] = slide(z, cam.movement === 'tilt_up' ? 'up' : 'down');
      move.plan = at(z, z, a, b);
      move.keystone = { kind: cam.movement, amount: Math.min(0.06, 0.03 * k), reverse: false };
      break;
    }
    case 'crane_up': case 'crane_down': {
      const near = zoomed(2 * amt, 0.2);
      const far = zoomed(0.4 * amt, 0.04);
      const low = { x: focus.x, y: 0.5 + room(near) };
      const high = { x: focus.x, y: 0.5 - room(far) };
      move.plan = cam.movement === 'crane_up' ? at(near, far, low, high) : at(far, near, high, low);
      break;
    }
    case 'orbit': {
      const z = zoomed(1.8 * amt, 0.18);
      const r = room(z) * 0.7;
      const sign = dir === 'right_to_left' ? -1 : 1;
      move.plan = at(z, z, { x: focus.x - sign * r, y: focus.y }, { x: focus.x + sign * r, y: focus.y });
      move.keystone = { kind: 'orbit', amount: Math.min(0.09, 0.045 * k), reverse: sign < 0 };
      break;
    }
    case 'slow_reveal': {
      const z = zoomed(3.5 * amt, 0.35);
      const [from] = slide(z, dir ?? 'up');
      move.plan = at(z, 1, from, centre);
      break;
    }
    case 'handheld': {
      const z = zoomed(amt, 0.09);
      move.plan = at(z, z + 0.2 * amt, focus, focus);
      move.shake = { kind: 'handheld', amp: 0.007 * k };
      move.sway = 0.35 * k;
      break;
    }
    case 'impact_shake': {
      const z = zoomed(amt, 0.12);
      move.plan = at(z + 0.4 * amt, z, focus, focus);
      move.shake = { kind: 'impact', amp: 0.03 * k };
      move.easing = 'ease_out';
      break;
    }
    case 'whip_pan': {
      const z = zoomed(2 * amt, 0.2);
      const [from] = slide(z, dir ?? 'left_to_right');
      move.plan = at(z, z, from, focus);
      move.whip = dir ?? 'left_to_right';
      break;
    }
  }

  // keep the subject inside the frame at the end framings
  const keep = (c: number, subject: number, z: number) => clamp(clamp(c, subject - 0.45 / z, subject + 0.45 / z), 0.5 / z, 1 - 0.5 / z);
  const p = move.plan;
  // moves that deliberately start away from the subject only have their final framing protected
  const startsAway = cam.movement === 'slow_reveal' || cam.movement === 'whip_pan' || cam.movement === 'tracking';
  p.cx1 = keep(p.cx1, focus.x, p.z1);
  p.cy1 = keep(p.cy1, focus.y, p.z1);
  if (!startsAway) {
    p.cx0 = keep(p.cx0, focus.x, p.z0);
    p.cy0 = keep(p.cy0, focus.y, p.z0);
  }

  // the person's own framing wins over the movement's
  if (cam.start_zoom !== undefined) p.z0 = cam.start_zoom;
  if (cam.end_zoom !== undefined) p.z1 = cam.end_zoom;
  if (cam.start) [p.cx0, p.cy0] = [cam.start.x, cam.start.y];
  if (cam.end) [p.cx1, p.cy1] = [cam.end.x, cam.end.y];
  if (cam.easing) move.easing = cam.easing;
  if (cam.shake !== undefined) {
    move.shake = cam.shake > 0 ? { kind: move.shake?.kind ?? 'handheld', amp: 0.025 * cam.shake } : null;
    if (cam.shake === 0) move.sway = 0;
    // shaking needs a margin to move in
    else { p.z0 = Math.max(p.z0, 1 + 3 * move.shake!.amp); p.z1 = Math.max(p.z1, 1 + 3 * move.shake!.amp); }
  }
  return move;
}

/** The filters that play one movement on an already cropped and oversampled still. */
export function cinematicFilters(cam: Camera, frames: number, size: { w: number; h: number }, fps: number, focalRel: Point, classic: (c: Camera, focal: Point) => MotionPlan, videoInput = false): string[] {
  const n = Math.max(2, frames);
  const m = cameraMove(cam, focalRel, classic);
  const last = Math.max(1, Math.min(n - 1, cam.move_seconds ? Math.round(cam.move_seconds * fps) - 1 : m.whip ? Math.round(n * 0.3) : n - 1));
  const prog = easingExpr(m.easing, `min(1,on/${last})`, cam.curve);
  const p = m.plan;
  const lerp = (a: number, b: number) => `(${f(a)}+(${f(b)}-${f(a)})*${prog})`;
  const time = `(on/${fps})`;
  const wobble = (axis: 'x' | 'y') => {
    if (!m.shake) return '';
    const a = f(m.shake.amp);
    if (m.shake.kind === 'impact') return `+i${axis === 'x' ? 'w' : 'h'}*${a}*exp(-7*${time})*sin(${axis === 'x' ? 88 : 71}*${time})`;
    const fast = f(0.4 * (1 - (cam.smoothness ?? 0)));
    const [s1, s2, ph] = axis === 'x' ? [6.9, 17, 1] : [5.3, 14.5, 2.4];
    return `+i${axis === 'x' ? 'w' : 'h'}*${a}*(0.6*sin(${s1}*${time}+${ph})+${fast}*sin(${s2}*${time}))`;
  };
  const z = `max(1,${lerp(p.z0, p.z1)})`;
  const x = `max(0,min(iw*${lerp(p.cx0, p.cx1)}-iw/zoom/2${wobble('x')},iw-iw/zoom))`;
  const y = `max(0,min(ih*${lerp(p.cy0, p.cy1)}-ih/zoom/2${wobble('y')},ih-ih/zoom))`;
  const out = [`zoompan=z='${z}':x='${x}':y='${y}':d=${videoInput ? 1 : n}:s=${size.w}x${size.h}:fps=${fps}`];

  if (m.keystone) {
    // sample slightly inside the frame on one side, which reads as a change of viewing angle without black edges
    const a = f(m.keystone.amount);
    const q = easingExpr(m.easing, `min(1,on/${last})`, cam.curve).replace(/\bon\b/g, 'on');
    if (m.keystone.kind === 'orbit') {
      const [l, r] = m.keystone.reverse ? [`${a}*${q}`, `${a}*(1-${q})`] : [`${a}*(1-${q})`, `${a}*${q}`];
      out.push(`perspective=x0=0:y0='H*${l}':x1=W:y1='H*${r}':x2=0:y2='H-H*${l}':x3=W:y3='H-H*${r}':eval=frame`);
    } else {
      const lean = m.keystone.kind === 'tilt_up' ? `${a}*${q}` : `${a}*(1-${q})`;
      out.push(`perspective=x0='W*${lean}':y0=0:x1='W-W*${lean}':y1=0:x2=0:y2=H:x3=W:y3=H:eval=frame`);
    }
  }
  if (m.rotation || m.sway) {
    const rad = (d: number) => f((d * Math.PI) / 180);
    const seconds = f((last + 1) / fps);
    const angle = `${rad(m.rotation)}*min(1,t/${seconds})+${rad(m.sway)}*sin(4.1*t)*sin(1.7*t+1)`;
    const most = Math.abs(rad(m.rotation)) + Math.abs(rad(m.sway));
    // enlarge just enough that the rotated corners never show
    const grow = Math.cos(most) + Math.max(size.w / size.h, size.h / size.w) * Math.sin(most);
    out.push(`rotate=a='${angle}':ow=iw:oh=ih`, `crop=w=iw/${f(grow)}:h=ih/${f(grow)}`, `scale=${size.w}:${size.h}:flags=lanczos`);
  }
  if (m.whip) {
    const vertical = m.whip === 'up' || m.whip === 'down';
    const radius = Math.round(Math.min(size.w, size.h) * 0.04 * strength(cam));
    out.push(`dblur=angle=${vertical ? 90 : 0}:radius=${radius}:enable='lt(t,${f((last * 0.7) / fps)})'`);
  }
  if (m.motionBlur > 0) out.push(`tmix=frames=${2 + Math.round(m.motionBlur * 4)}`);
  return out;
}
