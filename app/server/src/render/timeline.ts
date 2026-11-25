import { createHash } from 'node:crypto';
import { EngineError } from '../engine.ts';
import type { CaptionStyle, CaptionWord } from '../captions/track.ts';
import type { PlacementOverride } from '../captions/ass.ts';
import type { MixSpec } from '../audio/mix.ts';
import type { Camera, Rect } from './motion.ts';
import type { FormatSpec } from './formats.ts';
import { PRECEDENCE, checkDirectionOverride, resolveLayers, storyboardSource } from './resolve.ts';
import { resolveLook } from './styles.ts';
import type { LookChoice, LookParams, ResolvedLook } from './styles.ts';
import type { DirectionOverride, Source, TransitionChoice } from './resolve.ts';
import { DEFAULT_SECONDS } from './transitions.ts';
import type { TransitionSpec } from './transitions.ts';
import type { Scene, Transition } from '../studios/storyboard.ts';
import { computeSceneTimes } from './timing.ts';
import type { SceneIn } from './timing.ts';

export interface TimelineScene {
  scene_id: string;
  index: number;
  title: string;
  start: number;
  duration: number;
  timing_source: 'audio' | 'estimate';
  asset: { id: string; sha256: string; rel_path: string; kind: 'image' | 'video'; width: number; height: number } | null;
  focal: { x: number; y: number };
  camera: Camera;
  transition_in: { type: string; duration: number } & Partial<Omit<TransitionSpec, 'type' | 'duration'>>;
  look?: ResolvedLook;
  /** Present only for values that come from a Compose & Render override. */
  sources?: { camera?: Source; transition?: Source; look?: Source };
}

/** Engine-agnostic composition: everything a renderer needs, no references back into the database. */
export interface Timeline {
  version: 1;
  effects?: 'folklore'; // the classic scene effect; absent = clean
  look?: { style: LookChoice['style']; ambience?: LookParams['ambience'] }; // the video-wide cinematic style
  lang: string;
  format: { id: string; width: number; height: number; fps: number; bitrate?: string };
  duration: number;
  scenes: TimelineScene[];
  captions: { enabled: boolean; style: CaptionStyle; words: CaptionWord[]; placement: PlacementOverride[]; mode?: 'word' };
  audio: { chunks: { clip_id: string; rel_path: string; start: number; duration: number }[]; narration_total: number; mix: MixSpec; music: { clip_id: string; rel_path: string }[]; sfx: { clip_id: string; rel_path: string }[] };
  overrides: Record<string, DirectionOverride & { crop?: Rect; caption_y_pct?: number }>;
  overrides_all?: DirectionOverride; // camera and transition for the whole video
  source: Record<string, string | null | Record<string, string | null>>;
}

export const TAIL_SECONDS = 0.4;

export interface BuildInput {
  lang: string;
  format: FormatSpec;
  scenes: (SceneIn & { scene_id: string; title: string; camera: Camera; transition_in?: string; transition_settings?: Scene['transition_settings']; look?: Scene['look']; origin?: Scene['origin']; draft?: boolean })[];
  assets: Map<string, TimelineScene['asset'] & { focal: { x: number; y: number } }>;
  timelineWords: { section_id: string; start: number; end: number }[];
  narration: Timeline['audio'];
  captionWords: CaptionWord[];
  style: CaptionStyle;
  overrides: Timeline['overrides'];
  overrides_all?: DirectionOverride;
  direction_look?: LookChoice; // the project's Cinematic Direction choice
  source: Timeline['source'];
}

const OVERRIDES: Source[] = ['scene_override', 'composition_override'];

/** One scene's camera, incoming transition and style after precedence, with where each came from. */
export function direct(i: BuildInput, s: BuildInput['scenes'][number]) {
  const own = i.overrides[s.scene_id];
  const all = i.overrides_all;
  const camera = resolveLayers<Camera>({ scene_override: own?.camera, [storyboardSource(s, 'camera')]: s.camera, composition_override: all?.camera, default: s.camera });
  const stored: TransitionChoice | undefined = s.transition_in ? { ...s.transition_settings, type: s.transition_in as Transition } : undefined;
  const transition = resolveLayers<TransitionChoice>({ scene_override: own?.transition, [storyboardSource(s, 'transition')]: stored, composition_override: all?.transition, default: { type: 'cut' } });
  return { camera, transition, look: directLook(i, s) };
}

/** The scene's visual style. The strongest layer that names a style wins; a storyboard scene may add effects to a weaker one. */
function directLook(i: BuildInput, s: BuildInput['scenes'][number]): { value: ResolvedLook; source: Source } | undefined {
  const from = storyboardSource(s, 'look');
  const named = s.look?.style ? { style: s.look.style, params: s.look.params } : undefined;
  const hit = resolveLayers<LookChoice | null>({ scene_override: i.overrides[s.scene_id]?.look, [from]: named, composition_override: i.overrides_all?.look, direction: i.direction_look, default: null });
  const additions = !named && s.look?.params && (!hit.value || PRECEDENCE.indexOf(hit.source) > PRECEDENCE.indexOf(from)) ? s.look.params : undefined;
  if (!hit.value && !additions) return undefined;
  const value = resolveLook(hit.value ?? { style: 'none' }, additions);
  // nothing to apply: leave the scene exactly as it would be without a style
  return Object.keys(value).length > 1 || value.style !== 'none' ? { value, source: hit.value ? hit.source : from } : undefined;
}

export function buildTimeline(i: BuildInput): Timeline {
  const total = i.narration.narration_total + TAIL_SECONDS;
  const times = computeSceneTimes(i.scenes, i.timelineWords, total);
  const scenes: TimelineScene[] = i.scenes.map((s, k) => {
    const a = i.assets.get(s.scene_id) ?? null;
    const t = times[k];
    const { camera, transition, look } = direct(i, s);
    const type = k === 0 ? 'cut' : transition.value.type;
    const prev = times[k - 1];
    const { type: _t, duration: wanted, ...settings } = k === 0 ? { type: 'cut' as const, duration: undefined } : transition.value;
    const dur = type === 'cut' ? 0 : Math.min(wanted ?? DEFAULT_SECONDS[type], 0.4 * Math.min(t.duration, prev ? prev.duration : t.duration));
    const sources = {
      ...(OVERRIDES.includes(camera.source) ? { camera: camera.source } : {}),
      ...(k > 0 && OVERRIDES.includes(transition.source) ? { transition: transition.source } : {}),
      ...(look && OVERRIDES.includes(look.source) ? { look: look.source } : {}),
    };
    return {
      scene_id: s.scene_id,
      index: k,
      title: s.title,
      start: t.start,
      duration: t.duration,
      timing_source: t.source,
      asset: a ? { id: a.id, sha256: a.sha256, rel_path: a.rel_path, kind: a.kind, width: a.width, height: a.height } : null,
      focal: a?.focal ?? { x: 0.5, y: 0.5 },
      camera: camera.value,
      ...(look ? { look: look.value } : {}),
      transition_in: { type, duration: Math.round(dur * 1000) / 1000, ...settings },
      ...(Object.keys(sources).length ? { sources } : {}),
    };
  });
  const placement: PlacementOverride[] = scenes.flatMap((s) => {
    const y = i.overrides[s.scene_id]?.caption_y_pct;
    return y === undefined ? [] : [{ from: s.start, to: s.start + s.duration, y_pct: y }];
  });
  const wide = i.overrides_all?.look ?? i.direction_look;
  const wideLook = wide ? resolveLook(wide) : undefined;
  return {
    version: 1,
    lang: i.lang,
    format: { id: i.format.id, width: i.format.width, height: i.format.height, fps: i.format.fps, bitrate: i.format.bitrate },
    duration: Math.round(total * 1000) / 1000,
    scenes,
    captions: { enabled: i.captionWords.length > 0, style: i.style, words: i.captionWords, placement, ...(wideLook?.captions === 'word' ? { mode: 'word' as const } : {}) },
    ...(wideLook ? { look: { style: wideLook.style, ...(wideLook.ambience ? { ambience: wideLook.ambience } : {}) } } : {}),
    audio: i.narration,
    overrides: i.overrides,
    ...(i.overrides_all && Object.keys(i.overrides_all).length ? { overrides_all: i.overrides_all } : {}),
    source: i.source,
  };
}

/** Content hash of what affects the rendered pixels and sound (not build metadata). */
export function timelineHash(t: Timeline): string {
  const { source: _s, ...rest } = t;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 24);
}

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateTimelineShape(c: unknown): Timeline {
  if (!isObj(c) || c.version !== 1) throw bad('Timeline must be an object with version 1');
  if (typeof c.lang !== 'string') throw bad('lang is required');
  const f = c.format as Record<string, unknown>;
  if (!isObj(f) || typeof f.id !== 'string' || typeof f.width !== 'number' || typeof f.height !== 'number' || typeof f.fps !== 'number') throw bad('format needs id, width, height, fps');
  if (typeof c.duration !== 'number' || !(c.duration > 0)) throw bad('duration must be positive');
  if (!Array.isArray(c.scenes) || !c.scenes.length) throw bad('Timeline needs scenes');
  let prevEnd = 0;
  for (const [k, s] of (c.scenes as Record<string, unknown>[]).entries()) {
    if (typeof s.start !== 'number' || typeof s.duration !== 'number' || !(s.duration > 0) || s.start < prevEnd - 0.01) throw bad(`Scene ${k + 1} has invalid timing`);
    prevEnd = s.start + s.duration;
  }
  if (!isObj(c.captions) || !isObj(c.audio) || !isObj(c.overrides)) throw bad('captions, audio and overrides are required');
  for (const o of Object.values(c.overrides)) checkDirectionOverride(o);
  if (c.overrides_all !== undefined) checkDirectionOverride(c.overrides_all);
  return c as unknown as Timeline;
}
