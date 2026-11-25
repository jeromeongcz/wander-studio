// Cinematic visual styles: a style is data (a colour grade, effects, and preferences for the writer); one filter
// builder turns the resolved numbers into FFmpeg filters. Atmospheric layers are generated here, so no outside footage
// or its licence is involved. Smoke is deliberately absent: the generated version looked like a pattern, not smoke. The older "folklore" effect (effects.ts, shown as "Dark folklore (classic)") is separate.
import { EngineError } from '../engine.ts';
import type { Camera } from './motion.ts';
import type { Movement } from './camera.ts';
import type { Transition } from './transitions.ts';

export const STYLE_IDS = ['documentary', 'dark_folklore', 'folklore', 'horror', 'adventure', 'fantasy', 'emotional', 'high_energy', 'minimal', 'custom'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

interface Range { min: number; max: number; neutral: number; label: string; group: 'Colour' | 'Effects' | 'Atmosphere' }
const colour = (label: string, min: number, max: number, neutral: number): Range => ({ label, min, max, neutral, group: 'Colour' });
const effect = (label: string, group: Range['group'] = 'Effects'): Range => ({ label, min: 0, max: 1, neutral: 0, group });

export const PARAMS = {
  brightness: colour('Brightness', -0.3, 0.3, 0),
  contrast: colour('Contrast', 0.6, 1.6, 1),
  saturation: colour('Saturation', 0, 2, 1),
  temperature: colour('Colour temperature (K, higher is cooler)', 3000, 11000, 6500),
  tint: colour('Tint (green to magenta)', -0.3, 0.3, 0),
  highlights: colour('Highlights', -0.15, 0.15, 0),
  shadows: colour('Shadows', -0.15, 0.15, 0),
  vignette: effect('Vignette'),
  grain: effect('Film grain'),
  flicker: effect('Flicker'),
  blur: effect('Blur'),
  glow: effect('Glow'),
  motion_blur: effect('Motion blur'),
  distortion: effect('Colour distortion'),
  light_leak: effect('Light leaks', 'Atmosphere'),
  fog: effect('Fog and mist', 'Atmosphere'),
  dust: effect('Dust', 'Atmosphere'),
  rays: effect('Light rays', 'Atmosphere'),
  moving_shadows: effect('Moving shadows', 'Atmosphere'),
} satisfies Record<string, Range>;
export type ParamName = keyof typeof PARAMS;

export const GRADINGS = ['none', 'earthy', 'moonlit', 'cold', 'warm', 'dreamy'] as const;
export const CAPTION_LOOKS = ['track', 'word'] as const; // "track": the approved caption style; "word": one big word at a time
export const AMBIENCES = ['none', 'drone', 'wind', 'wind_drone'] as const;

export type LookParams = Partial<Record<ParamName, number>> & {
  grading?: (typeof GRADINGS)[number];
  captions?: (typeof CAPTION_LOOKS)[number];
  ambience?: (typeof AMBIENCES)[number];
};
/** What is stored in an override or on a storyboard scene. */
export interface LookChoice {
  style: StyleId | 'none';
  params?: LookParams;
}
/** What the renderer gets: the style's values with the choices applied, neutral values left out. */
export type ResolvedLook = LookParams & { style: StyleId | 'none' };

export interface StyleDef {
  label: string;
  summary: string;
  params: LookParams;
  cameras: Movement[]; // preferences for the script writer and automatic drafts, never forced on a scene
  transitions: Transition[];
  pacing: string;
  audio: string;
  guidance?: string;
}

export const STYLES: Record<StyleId, StyleDef> = {
  documentary: { label: 'Cinematic Documentary', summary: 'Natural colour, controlled contrast, clean and subtle.', params: { contrast: 1.05, saturation: 0.97, vignette: 0.15 }, cameras: ['dolly_in', 'truck_right', 'ken_burns', 'pullback', 'static'], transitions: ['cut', 'dissolve', 'fade'], pacing: 'Measured, informative holds.', audio: 'Natural ambience, restrained music.' },
  dark_folklore: { label: 'Dark Folklore', summary: 'Horror-focused: deep shadows, drained colour, grain, flicker and a low drone.', params: { brightness: -0.025, contrast: 1.08, saturation: 0.6, temperature: 7600, shadows: 0.01, grading: 'moonlit', vignette: 0.55, grain: 0.45, flicker: 0.35, fog: 0.2, ambience: 'drone' }, cameras: ['dramatic_push_in', 'handheld', 'slow_reveal', 'static', 'impact_shake'], transitions: ['cut', 'fade', 'glitch', 'flash', 'film_burn'], pacing: 'Long unsettling holds broken by sudden fast reveals.', audio: 'Low drone, silence, sharp impacts.', guidance: 'Escalate unease by framing and distortion, not gore.' },
  folklore: {
    label: 'Folklore', summary: 'Mysterious and atmospheric: earthy greens and browns, amber light, mist.',
    params: { contrast: 1.03, saturation: 0.82, temperature: 6000, highlights: 0.03, shadows: 0.025, grading: 'earthy', vignette: 0.32, grain: 0.2, flicker: 0.12, fog: 0.35, ambience: 'wind' },
    cameras: ['dolly_in', 'tracking', 'pullback', 'slow_reveal', 'static', 'handheld'], transitions: ['cut', 'dissolve', 'fade', 'wipe', 'film_burn'],
    pacing: 'Gradual suspense, atmospheric holds, controlled reveals, a deliberate ending; faster cuts only during intense events.', audio: 'Forest ambience, wind, insects, distant animals, low drones; controlled impacts.',
    guidance: 'Philippine folklore and cultural context: use Filipino architecture, clothing, landscapes and objects only where the story supports them. No generic Western horror imagery. Invent no cultural details, and keep tradition, recorded history and fictional interpretation distinct. Mysterious, not automatically frightening.',
  },
  horror: { label: 'Horror & Suspense', summary: 'High contrast, darkness, slow reveals and selective distortion.', params: { brightness: -0.03, contrast: 1.14, saturation: 0.72, shadows: 0.005, grading: 'cold', vignette: 0.5, grain: 0.28, distortion: 0.2, moving_shadows: 0.3 }, cameras: ['slow_reveal', 'dramatic_push_in', 'handheld', 'static', 'tilt_up'], transitions: ['cut', 'fade', 'glitch', 'blur_dissolve'], pacing: 'Hold tension, then release it quickly.', audio: 'Sparse, tense, sudden hits.' },
  adventure: { label: 'Adventure', summary: 'Wide, rich and energetic.', params: { contrast: 1.1, saturation: 1.2, temperature: 5900, highlights: 0.03, vignette: 0.2, rays: 0.2 }, cameras: ['crane_up', 'tracking', 'orbit', 'pullback', 'whip_pan'], transitions: ['push', 'zoom_reveal', 'wipe', 'whip_pan', 'cut'], pacing: 'Forward motion with big reveals.', audio: 'Open ambience, driving music.' },
  fantasy: { label: 'Fantasy', summary: 'Dreamlike glow, rich colour, drifting light.', params: { saturation: 1.18, grading: 'dreamy', glow: 0.5, vignette: 0.25, dust: 0.35, rays: 0.25 }, cameras: ['dolly_in', 'orbit', 'crane_up', 'slow_reveal'], transitions: ['dissolve', 'light_leak', 'iris_in', 'blur_dissolve'], pacing: 'Flowing, with moments of wonder.', audio: 'Airy pads and soft magical accents.' },
  emotional: { label: 'Emotional & Inspirational', summary: 'Warm, soft and gentle.', params: { contrast: 0.98, saturation: 1.05, temperature: 5300, shadows: 0.03, grading: 'warm', glow: 0.2, vignette: 0.25 }, cameras: ['dolly_in', 'static', 'pullback', 'crane_up'], transitions: ['dissolve', 'fade', 'light_leak'], pacing: 'Unhurried, ending on an atmospheric hold.', audio: 'Warm music under the voice.' },
  high_energy: { label: 'High-Energy & Dynamic', summary: 'Punchy colour, motion blur and impact.', params: { contrast: 1.1, saturation: 1.25, motion_blur: 0.35, vignette: 0.15 }, cameras: ['whip_pan', 'impact_shake', 'dramatic_push_in', 'tracking'], transitions: ['whip_pan', 'push', 'motion_blur', 'flash', 'zoom_through', 'cut'], pacing: 'Fast, short holds.', audio: 'Driving rhythm, whooshes and hits.' },
  minimal: { label: 'Minimal Cinematic', summary: 'Clean, natural, almost no effects.', params: { contrast: 1.02 }, cameras: ['static', 'ken_burns', 'dolly_in'], transitions: ['cut', 'dissolve'], pacing: 'Calm and clear.', audio: 'Voice first.' },
  custom: { label: 'Custom', summary: 'Start neutral and set every value yourself.', params: {}, cameras: ['ken_burns', 'dolly_in', 'static'], transitions: ['cut', 'dissolve'], pacing: 'As you direct.', audio: 'As you direct.' },
};

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateLookParams(x: unknown, at = 'look.params'): LookParams {
  if (!isObj(x)) throw bad(`${at} must be an object`);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(x)) {
    const range = (PARAMS as Record<string, Range>)[key];
    const list: readonly string[] | undefined = { grading: GRADINGS, captions: CAPTION_LOOKS, ambience: AMBIENCES }[key as 'grading'];
    if (range) {
      if (typeof v !== 'number' || !(v >= range.min && v <= range.max)) throw bad(`${at}.${key} must be ${range.min} to ${range.max}`);
    } else if (list) {
      if (!list.includes(v as string)) throw bad(`${at}.${key} must be one of: ${list.join(', ')}`);
    } else throw bad(`${at} does not support: ${key}`);
    out[key] = v;
  }
  return out as LookParams;
}

export const isStyle = (s: unknown): s is StyleId | 'none' => s === 'none' || (STYLE_IDS as readonly string[]).includes(s as string);

export function validateLook(x: unknown, at = 'look'): LookChoice {
  if (!isObj(x) || !isStyle(x.style)) throw bad(`${at}.style must be one of: none, ${STYLE_IDS.join(', ')}`);
  const extra = Object.keys(x).filter((k) => k !== 'style' && k !== 'params');
  if (extra.length) throw bad(`${at} does not support: ${extra.join(', ')}`);
  return { style: x.style, ...(x.params !== undefined ? { params: validateLookParams(x.params, `${at}.params`) } : {}) };
}

/** The style's values with the choice's own on top. */
export function resolveLook(choice: LookChoice, extra: LookParams = {}): ResolvedLook {
  const merged: Record<string, unknown> = { ...(choice.style === 'none' ? {} : STYLES[choice.style].params), ...extra, ...choice.params };
  for (const [k, v] of Object.entries(merged)) {
    if ((PARAMS as Record<string, Range>)[k]?.neutral === v || v === 'none' || v === 'track') delete merged[k];
  }
  return { style: choice.style, ...merged } as ResolvedLook;
}

const f = (n: number) => Number(n.toFixed(4));

const GRADE: Record<string, string> = {
  earthy: 'colorbalance=rs=-0.03:gs=0.035:bs=-0.05:rm=0.03:gm=0.01:bm=-0.05:rh=0.08:gh=0.03:bh=-0.07',
  moonlit: 'colorbalance=rs=-0.08:gs=-0.01:bs=0.09:rm=-0.05:bm=0.05:rh=-0.02:bh=0.03',
  cold: 'colorbalance=rs=-0.04:bs=0.05:rm=-0.04:gm=0.01:bm=0.04',
  warm: 'colorbalance=rm=0.05:bm=-0.04:rh=0.06:gh=0.02:bh=-0.05',
  dreamy: 'colorbalance=rs=0.05:bs=0.08:rm=0.02:bm=0.04:rh=0.04:gh=0.01:bh=0.03',
};

/** Alpha-blended layers drawn small and scaled up, which is fast and keeps them soft. */
const LAYERS: Record<string, { scale: number; rgb: [number, number, number]; alpha: (a: number) => string }> = {
  moving_shadows: { scale: 12, rgb: [0, 0, 0], alpha: (a) => `${f(150 * a)}*clip(sin(X/W*3.1+T*0.55+1.7*sin(Y/H*2.3-T*0.35))*sin(Y/H*2.7+T*0.4+1.3*sin(X/W*3.9+T*0.2)),0,1)` },
  fog: { scale: 12, rgb: [196, 204, 208], alpha: (a) => `${f(185 * a)}*clip((Y/H-0.3)*1.5,0,1)*clip(0.6+0.4*sin(X/W*4.7+T*0.45+2*sin(Y/H*5.3-T*0.25))*sin(Y/H*9.1+1.5*sin(X/W*3.1+T*0.3)),0,1)` },
  rays: { scale: 8, rgb: [226, 233, 255], alpha: (a) => `${f(120 * a)}*pow(clip(1-Y/H*1.1,0,1),1.2)*pow(clip(sin(atan2(Y+0.25*H,X-0.85*W)*17+0.9*sin(T*0.5))*0.6+sin(atan2(Y+0.25*H,X-0.85*W)*31-T*0.35)*0.4,0,1),2)` },
  light_leak: { scale: 12, rgb: [255, 160, 70], alpha: (a) => `${f(190 * a)}*clip(0.55+0.45*sin(T*1.3),0,1)*exp(-6*(pow(X/W-(0.95+0.12*sin(T*0.7)),2)+0.4*pow(Y/H-(0.3+0.2*sin(T*0.45)),2)))` },
  dust: { scale: 5, rgb: [240, 232, 205], alpha: (a) => `${f(235 * a)}*gt(abs(mod(sin(floor(X+T*5+2*sin(Y/9+T))*12.9898+floor(Y+T*7)*78.233)*43758.5453,1)),0.9975)` },
};

/**
 * Filters for one scene. `main` runs on the picture; each entry of `layers` is a generated source to lay over it, and
 * `after` runs once they are on.
 */
export function lookFilters(look: ResolvedLook, size: { w: number; h: number }, fps: number, seconds: number) {
  const p = (k: ParamName) => look[k] ?? PARAMS[k].neutral;
  const short = Math.min(size.w, size.h);
  const main: string[] = [];
  if (look.blur) main.push(`gblur=sigma=${f(short * 0.008 * look.blur)}`);
  if (p('brightness') !== 0 || p('contrast') !== 1 || p('saturation') !== 1) main.push(`eq=brightness=${f(p('brightness'))}:contrast=${f(p('contrast'))}:saturation=${f(p('saturation'))}`);
  if (p('temperature') !== 6500) main.push(`colortemperature=temperature=${Math.round(p('temperature'))}:pl=0.6`);
  if (look.grading && GRADE[look.grading]) main.push(GRADE[look.grading]);
  if (p('tint')) main.push(`colorbalance=gm=${f(-p('tint'))}:rm=${f(p('tint') / 2)}:bm=${f(p('tint') / 2)}`);
  if (p('shadows') || p('highlights')) main.push(`curves=master='0/0 0.25/${f(0.25 + p('shadows'))} 0.75/${f(0.75 + p('highlights'))} 1/1'`);
  if (look.glow) main.push(`split[gs0][gs1];[gs1]gblur=sigma=${f(short * 0.02)}[gs2];[gs0][gs2]blend=c0_mode=screen:c0_opacity=${f(0.45 * look.glow)}`);

  const layers = (Object.keys(LAYERS) as ParamName[]).filter((name) => look[name]).map((name) => {
    const l = LAYERS[name];
    const [w, h] = [size.w, size.h].map((v) => Math.max(16, Math.round(v / l.scale / 2) * 2));
    return `color=c=black:s=${w}x${h}:r=${fps}:d=${f(seconds + 0.1)},format=rgba,geq=r='${l.rgb[0]}':g='${l.rgb[1]}':b='${l.rgb[2]}':a='${l.alpha(look[name]!)}',scale=${size.w}:${size.h}:flags=bilinear`;
  });

  const after: string[] = [];
  if (look.distortion) {
    const shift = Math.max(1, Math.round(short * 0.012 * look.distortion));
    after.push(`rgbashift=rh=${-shift}:bh=${shift}:enable='lt(mod(t,2.3),0.35)'`);
  }
  if (look.motion_blur) after.push(`tmix=frames=${2 + Math.round(look.motion_blur * 4)}`);
  if (look.vignette) after.push(`vignette=angle=${f(0.35 + 0.65 * look.vignette)}`);
  if (look.flicker) after.push(`eq=brightness='${f(0.06 * look.flicker)}*sin(2*PI*t*6.3)*sin(2*PI*t*1.7)':eval=frame`);
  if (look.grain) after.push(`noise=alls=${Math.max(1, Math.round(14 * look.grain))}:allf=t`);
  return { main, layers, after };
}

/** One FFmpeg `-vf` graph: the chain so far, then the look, then any `tail` filters that belong on top of it. */
export function withLook(chain: string[], look: ResolvedLook, size: { w: number; h: number }, fps: number, seconds: number, tail: string[] = []): string {
  const l = lookFilters(look, size, fps, seconds);
  let graph = [...chain, ...l.main].join(',');
  l.layers.forEach((layer, i) => {
    graph += `[m${i}];${layer}[l${i}];[m${i}][l${i}]overlay=format=auto:eof_action=repeat`;
  });
  return [graph, ...l.after, ...tail, 'format=yuv420p'].join(',');
}

export const cameraPreference = (style: StyleId | 'none' | undefined): Camera['movement'][] | undefined => (style && style !== 'none' ? STYLES[style].cameras : undefined);
