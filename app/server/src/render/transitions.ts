// Scene transitions: which exist, which settings each accepts, and the FFmpeg graph for one boundary.
// A transition runs over the last moments before the next scene's narration starts, so it never changes the video's
// length or moves the sound.
import { EngineError } from '../engine.ts';
import { EASINGS, easingExpr } from './camera.ts';
import type { Easing } from './camera.ts';

export const CLASSIC_TRANSITIONS = ['cut', 'fade', 'dissolve', 'slide', 'zoom', 'wipe'] as const;
export const NEW_TRANSITIONS = [
  'whip_pan', 'motion_blur', 'zoom_through', 'zoom_reveal', 'flash', 'light_leak', 'radial', 'iris_in', 'iris_out', 'push',
  'match_cut', 'glitch', 'film_burn', 'blur_dissolve', 'mask_reveal',
] as const;
export const TRANSITIONS = [...CLASSIC_TRANSITIONS, ...NEW_TRANSITIONS] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const TRANSITION_INTENSITIES = ['subtle', 'medium', 'strong'] as const;
export const TRANSITION_SOUNDS = ['whoosh', 'impact'] as const;
export const TRANSITION_OVERLAYS = ['flash', 'light_leak', 'film_burn'] as const;
const SIDES = ['left', 'right', 'up', 'down'] as const;

/** Directions a type accepts; the first is its default. */
export const TRANSITION_DIRECTIONS: Partial<Record<Transition, readonly string[]>> = {
  slide: SIDES, wipe: SIDES, push: SIDES, whip_pan: SIDES, motion_blur: SIDES, mask_reveal: ['right', 'left', 'down', 'up'], light_leak: ['right', 'left'],
};
export const EASABLE: readonly Transition[] = ['fade', 'slide', 'wipe', 'push', 'whip_pan', 'motion_blur', 'mask_reveal', 'zoom_reveal', 'match_cut'];
export const COLORED: readonly Transition[] = ['fade', 'flash', 'light_leak'];

export const MIN_TRANSITION = 0.1;
export const MAX_TRANSITION = 2;
export const DEFAULT_SECONDS: Record<Transition, number> = {
  cut: 0, fade: 0.4, dissolve: 0.4, slide: 0.4, wipe: 0.4, zoom: 0.4,
  whip_pan: 0.35, motion_blur: 0.4, zoom_through: 0.45, zoom_reveal: 0.5, flash: 0.3, light_leak: 0.7, radial: 0.5, iris_in: 0.5, iris_out: 0.5,
  push: 0.45, match_cut: 0.2, glitch: 0.35, film_burn: 0.7, blur_dissolve: 0.6, mask_reveal: 0.6,
};

export interface TransitionSpec {
  type: Transition;
  duration?: number; // requested seconds; the timeline shortens it when the scenes are too short
  direction?: string;
  intensity?: (typeof TRANSITION_INTENSITIES)[number];
  easing?: Easing;
  color?: string; // #RRGGBB
  blur?: number; // 0..1, extra blur while the transition runs
  sound?: (typeof TRANSITION_SOUNDS)[number];
  overlay?: (typeof TRANSITION_OVERLAYS)[number];
}
export const TRANSITION_KEYS = ['type', 'duration', 'direction', 'intensity', 'easing', 'color', 'blur', 'sound', 'overlay'];

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateTransition(x: unknown, at = 'transition'): TransitionSpec {
  if (!isObj(x) || !(TRANSITIONS as readonly string[]).includes(x.type as string)) throw bad(`${at}.type must be one of: ${TRANSITIONS.join(', ')}`);
  const extra = Object.keys(x).filter((k) => !TRANSITION_KEYS.includes(k));
  if (extra.length) throw bad(`${at} does not support: ${extra.join(', ')}`);
  const type = x.type as Transition;
  const out: Record<string, unknown> = { type };
  const given = (k: string) => x[k] !== undefined;
  if (type === 'cut') {
    const no = TRANSITION_KEYS.filter((k) => k !== 'type' && k !== 'sound' && given(k));
    if (no.length) throw bad(`A cut has no ${no.join(' or ')}`);
  }
  const oneOf = (k: string, list: readonly string[], why: string) => {
    if (!given(k)) return;
    if (!list.includes(x[k] as string)) throw bad(list.length ? `${at}.${k} must be one of: ${list.join(', ')}` : why);
    out[k] = x[k];
  };
  const range = (k: string, lo: number, hi: number) => {
    if (!given(k)) return;
    if (typeof x[k] !== 'number' || !((x[k] as number) >= lo && (x[k] as number) <= hi)) throw bad(`${at}.${k} must be ${lo} to ${hi}`);
    out[k] = x[k];
  };
  range('duration', MIN_TRANSITION, MAX_TRANSITION);
  oneOf('direction', TRANSITION_DIRECTIONS[type] ?? [], `${type} has no direction`);
  oneOf('intensity', TRANSITION_INTENSITIES, '');
  oneOf('easing', EASABLE.includes(type) ? EASINGS.filter((e) => e !== 'custom') : [], `${type} has no easing setting`);
  oneOf('sound', TRANSITION_SOUNDS, '');
  oneOf('overlay', TRANSITION_OVERLAYS, '');
  range('blur', 0, 1);
  if (given('color')) {
    if (!COLORED.includes(type) && x.overlay === undefined) throw bad(`${type} has no colour setting`);
    if (typeof x.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x.color)) throw bad(`${at}.color must look like #RRGGBB`);
    out.color = x.color;
  }
  return out as unknown as TransitionSpec;
}

const f = (n: number) => Number(n.toFixed(4));
const K = { subtle: 0.6, medium: 1, strong: 1.5 } as const;

export interface Boundary {
  index: number;
  prev: string; // label of everything composed so far
  next: string; // label of the incoming scene clip
  spec: TransitionSpec;
  seconds: number; // 0 for a cut
  start: number; // when the incoming scene's narration begins
  size: { w: number; h: number };
  fps: number;
  focal?: { from: { x: number; y: number }; to: { x: number; y: number } }; // subject positions in the frame, for match cuts
}

// ---- custom xfade expressions: P runs 1 -> 0, A is the outgoing picture, B the incoming one ----
const sample = (who: 'a' | 'b', x: string, y: string) => `if(eq(PLANE,0),${who}0(${x},${y}),if(eq(PLANE,1),${who}1(${x},${y}),${who}2(${x},${y})))`;

function slideExpr(dir: string, e: string) {
  const vertical = dir === 'up' || dir === 'down';
  const [pos, size] = vertical ? ['Y', 'H'] : ['X', 'W'];
  const forward = dir === 'left' || dir === 'up';
  const at = (who: 'a' | 'b', p: string) => (vertical ? sample(who, 'X', p) : sample(who, p, 'Y'));
  const moved = forward ? `${pos}+${size}*${e}` : `${pos}-${size}*${e}`;
  return forward
    ? `if(lt(${moved},${size}),${at('a', moved)},${at('b', `${moved}-${size}`)})`
    : `if(gte(${moved},0),${at('a', moved)},${at('b', `${moved}+${size}`)})`;
}
function wipeExpr(dir: string, e: string) {
  if (dir === 'left') return `if(lt(X,W*(1-${e})),A,B)`;
  if (dir === 'right') return `if(gt(X,W*${e}),A,B)`;
  if (dir === 'up') return `if(lt(Y,H*(1-${e})),A,B)`;
  return `if(gt(Y,H*${e}),A,B)`;
}
function maskExpr(dir: string, e: string) {
  const along = { right: 'X/W', left: '(1-X/W)', down: 'Y/H', up: '(1-Y/H)' }[dir as (typeof SIDES)[number]];
  const across = dir === 'up' || dir === 'down' ? 'X/W' : 'Y/H';
  const w = `clip((${e}*1.47-(${along}+0.35*${across}))/0.12,0,1)`;
  return `A*(1-${w})+B*${w}`;
}
function zoomRevealExpr(e: string) {
  const s = `(1.45-0.45*${e})`;
  return `A*(1-${e})+(${sample('b', `(X-W/2)/${s}+W/2`, `(Y-H/2)/${s}+H/2`)})*${e}`;
}
function matchExpr(focal: Boundary['focal'], e: string) {
  const dx = (focal?.to.x ?? 0.5) - (focal?.from.x ?? 0.5);
  const dy = (focal?.to.y ?? 0.5) - (focal?.from.y ?? 0.5);
  const z = Math.min(1.5, Math.max(1.06, 1 / (1 - 2 * Math.min(0.33, Math.max(Math.abs(dx), Math.abs(dy))))));
  const room = (1 - 1 / z) / 2;
  const clamp = (v: number) => f(Math.max(-room, Math.min(room, v)));
  const s = `(${f(z)}-${f(z - 1)}*${e})`;
  // the incoming picture starts with its subject where the outgoing one was, then settles into its own framing
  return `A*(1-${e})+(${sample('b', `(X-W/2)/${s}+W/2+W*${clamp(dx)}*(1-${e})`, `(Y-H/2)/${s}+H/2+H*${clamp(dy)}*(1-${e})`)})*${e}`;
}

/** The xfade part: a built-in mode, or an expression when the move needs its own easing or shape. */
function xfadeMode(b: Boundary): string {
  const { type, easing, color } = b.spec;
  const dir = b.spec.direction ?? TRANSITION_DIRECTIONS[type]?.[0] ?? 'left';
  const e = (fallback: Easing) => easingExpr(easing ?? fallback, '(1-P)');
  const custom = (expr: string) => `custom:expr='${expr}'`;
  switch (type) {
    case 'fade':
      if (easing) return custom(`A*(1-${e('linear')})+B*${e('linear')}`);
      return color?.toLowerCase() === '#000000' ? 'fadeblack' : color?.toLowerCase() === '#ffffff' ? 'fadewhite' : 'fade';
    case 'dissolve': return 'dissolve';
    case 'slide': return easing ? custom(slideExpr(dir, e('linear'))) : `slide${dir}`;
    case 'wipe': return easing ? custom(wipeExpr(dir, e('linear'))) : `wipe${dir}`;
    case 'zoom': case 'zoom_through': return 'zoomin';
    case 'push': return custom(slideExpr(dir, e('ease_in_out')));
    case 'whip_pan': return custom(slideExpr(dir, e('cinematic')));
    case 'motion_blur': return easing ? custom(slideExpr(dir, e('linear'))) : `smooth${dir}`;
    case 'mask_reveal': return custom(maskExpr(dir, e('ease_in_out')));
    case 'zoom_reveal': return custom(zoomRevealExpr(e('ease_out')));
    case 'match_cut': return custom(matchExpr(b.focal, e('ease_out')));
    case 'radial': return 'radial';
    case 'iris_in': return 'circleclose';
    case 'iris_out': return 'circleopen';
    case 'flash': case 'light_leak': case 'film_burn': case 'blur_dissolve': case 'glitch': return 'fade';
    default: return 'fade';
  }
}

const during = (a: number, b: number) => `enable='gte(t,${f(a)})*lt(t,${f(b)})'`;

/** Timed filters that run over the composed picture while the transition happens. */
function timedEffects(b: Boundary, a: number, end: number): string[] {
  const { type } = b.spec;
  const k = K[b.spec.intensity ?? 'medium'];
  const short = Math.min(b.size.w, b.size.h);
  const t = end - a;
  const out: string[] = [];
  const vertical = ['up', 'down'].includes(b.spec.direction ?? '');
  const smear = (amount: number) => out.push(`dblur=angle=${vertical ? 90 : 0}:radius=${Math.max(1, Math.round(short * amount * k))}:${during(a + t * 0.15, end - t * 0.15)}`);
  const soften = (amount: number) => {
    const sigma = f(Math.max(0.5, short * amount * k));
    out.push(`gblur=sigma=${sigma}:${during(a, end)}`, `gblur=sigma=${f(sigma * 1.4)}:${during(a + t * 0.3, end - t * 0.3)}`);
  };
  if (type === 'whip_pan') smear(0.06);
  if (type === 'motion_blur') smear(0.035);
  if (type === 'push') smear(0.008);
  if (type === 'zoom_through') soften(0.006);
  if (type === 'blur_dissolve') soften(0.012);
  if (b.spec.blur) {
    if (TRANSITION_DIRECTIONS[type]) smear(0.08 * b.spec.blur);
    else soften(0.02 * b.spec.blur);
  }
  if (type === 'glitch') {
    const on = `enable='gte(t,${f(a)})*lt(t,${f(end)})*lt(mod(n,4),3)'`;
    out.push(`rgbashift=rh=${-Math.round(short * 0.02 * k)}:bh=${Math.round(short * 0.02 * k)}:gv=${Math.round(short * 0.006 * k)}:${on}`, `noise=alls=${Math.min(80, Math.round(40 * k))}:allf=t:${on}`);
  }
  return out;
}

const OVERLAY_COLOR = { flash: '#FFFFFF', light_leak: '#FFAA50', film_burn: '#FF7828' } as const;

/** A generated light layer for flash, light leak and film burn; drawn small and scaled up, which also keeps it soft. */
function overlaySource(kind: keyof typeof OVERLAY_COLOR, b: Boundary, a: number, seconds: number): string {
  const k = K[b.spec.intensity ?? 'medium'];
  const hex = b.spec.color ?? OVERLAY_COLOR[kind];
  const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const w = Math.max(16, Math.round(b.size.w / 12) * 2);
  const h = Math.max(16, Math.round(b.size.h / 12) * 2);
  const d = f(seconds);
  const bell = `sin(PI*clip(T/${d},0,1))`;
  const sweep = b.spec.direction === 'left' ? `(1.2-1.4*T/${d})` : `(-0.2+1.4*T/${d})`;
  let alpha: string;
  let green = `${g}`;
  if (kind === 'flash') alpha = `${f(Math.min(255, 245 * k))}*pow(${bell},2)`;
  else if (kind === 'light_leak') alpha = `${f(Math.min(255, 215 * k))}*${bell}*exp(-5*(pow(X/W-${sweep},2)+0.35*pow(Y/H-0.35,2)))`;
  else {
    // warped, unequal waves give irregular patches; they eat in from one side before covering the frame
    const blobs = `(sin(X/W*4.3+2.4*sin(Y/H*3.1+T*2.3)+T*3)*sin(Y/H*3.7+1.9*sin(X/W*5.3-T*3.1))+0.35*sin(X/W*11+Y/H*6+3*sin(Y/H*9-T*4)))`;
    const edge = `pow(1-X/W,1.5)`;
    alpha = `255*${bell}*clip(0.55*${blobs}+1.5*${edge}+${f(1.5 * k)}*pow(${bell},3)-0.9,0,1)`;
    green = `clip(${g}+70*${blobs}+60*${edge},0,255)`;
  }
  return `color=c=black:s=${w}x${h}:r=${b.fps}:d=${d},format=rgba,geq=r='${r}':g='${green}':b='${bl}':a='${alpha}',scale=${b.size.w}:${b.size.h}:flags=bilinear,setpts=PTS-STARTPTS+${f(a)}/TB[o${b.index}]`;
}

/** The filter chains for one boundary and the label of the result. */
export function boundaryFilters(b: Boundary): { filters: string[]; out: string } {
  const { index: i, fps } = b;
  const out = `x${i}`;
  if (b.spec.type === 'cut') {
    // A true hard cut: two pieces joined end to end, with no blending filter. The frame counts reproduce the timing
    // of the one-frame fade used before, so older videos come out the same.
    const keep = Math.round(Number(Math.max(0, b.start - 1 / fps).toFixed(4)) * fps) + 1;
    return {
      filters: [
        `[${b.prev}]trim=end_frame=${keep},setpts=PTS-STARTPTS[a${i}]`,
        `[${b.next}]trim=start_frame=1,setpts=PTS-STARTPTS[b${i}]`,
        `[a${i}][b${i}]concat=n=2:v=1:a=0,settb=AVTB,fps=${fps}[${out}]`,
      ],
      out,
    };
  }
  const t = b.seconds > 0 ? b.seconds : 1 / fps;
  const offset = Math.max(0, b.start - t);
  const end = offset + t;
  const chain = [`xfade=transition=${xfadeMode(b)}:duration=${t.toFixed(4)}:offset=${offset.toFixed(4)}`, ...timedEffects(b, offset, end)];
  const own = b.spec.type === 'flash' || b.spec.type === 'light_leak' || b.spec.type === 'film_burn' ? b.spec.type
    // a fade through a colour other than black or white is that colour washing over the change
    : b.spec.type === 'fade' && b.spec.color && !['#000000', '#ffffff'].includes(b.spec.color.toLowerCase()) ? 'flash' : null;
  const layers = [...new Set([own, b.spec.overlay].filter(Boolean))] as (keyof typeof OVERLAY_COLOR)[];
  if (!layers.length) return { filters: [`[${b.prev}][${b.next}]${chain.join(',')}[${out}]`], out };
  const filters = [`[${b.prev}][${b.next}]${chain.join(',')}[t${i}]`];
  let label = `t${i}`;
  layers.forEach((kind, n) => {
    const layer = { ...b, index: i * 10 + n };
    const result = n === layers.length - 1 ? out : `t${i}_${n}`;
    filters.push(overlaySource(kind, layer, offset, t), `[${label}][o${layer.index}]overlay=eof_action=pass:format=auto,format=yuv420p,settb=AVTB,fps=${fps}[${result}]`);
    label = result;
  });
  return { filters, out };
}
