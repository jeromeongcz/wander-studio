import { createHash } from 'node:crypto';
import { EngineError } from '../engine.ts';
import type { CaptionStyle, CaptionWord } from '../captions/track.ts';
import type { PlacementOverride } from '../captions/ass.ts';
import type { MixSpec } from '../audio/mix.ts';
import type { Camera, Rect } from './motion.ts';
import type { FormatSpec } from './formats.ts';
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
  transition_in: { type: string; duration: number };
}

/** Engine-agnostic composition: everything a renderer needs, no references back into the database. */
export interface Timeline {
  version: 1;
  effects?: 'folklore'; // scene effect style; absent = clean
  lang: string;
  format: { id: string; width: number; height: number; fps: number; bitrate?: string };
  duration: number;
  scenes: TimelineScene[];
  captions: { enabled: boolean; style: CaptionStyle; words: CaptionWord[]; placement: PlacementOverride[]; mode?: 'word' };
  audio: { chunks: { clip_id: string; rel_path: string; start: number; duration: number }[]; narration_total: number; mix: MixSpec; music: { clip_id: string; rel_path: string }[]; sfx: { clip_id: string; rel_path: string }[] };
  overrides: Record<string, { crop?: Rect; caption_y_pct?: number }>;
  source: Record<string, string | null | Record<string, string | null>>;
}

export const TAIL_SECONDS = 0.4;
const TRANSITION_SECONDS = 0.4;

export interface BuildInput {
  lang: string;
  format: FormatSpec;
  scenes: (SceneIn & { scene_id: string; title: string; camera: Camera; transition_in?: string })[];
  assets: Map<string, TimelineScene['asset'] & { focal: { x: number; y: number } }>;
  timelineWords: { section_id: string; start: number; end: number }[];
  narration: Timeline['audio'];
  captionWords: CaptionWord[];
  style: CaptionStyle;
  overrides: Timeline['overrides'];
  source: Timeline['source'];
}

export function buildTimeline(i: BuildInput): Timeline {
  const total = i.narration.narration_total + TAIL_SECONDS;
  const times = computeSceneTimes(i.scenes, i.timelineWords, total);
  const scenes: TimelineScene[] = i.scenes.map((s, k) => {
    const a = i.assets.get(s.scene_id) ?? null;
    const t = times[k];
    const type = k === 0 ? 'cut' : (s.transition_in ?? 'cut');
    const prev = times[k - 1];
    const dur = type === 'cut' ? 0 : Math.min(TRANSITION_SECONDS, 0.4 * Math.min(t.duration, prev ? prev.duration : t.duration));
    return {
      scene_id: s.scene_id,
      index: k,
      title: s.title,
      start: t.start,
      duration: t.duration,
      timing_source: t.source,
      asset: a ? { id: a.id, sha256: a.sha256, rel_path: a.rel_path, kind: a.kind, width: a.width, height: a.height } : null,
      focal: a?.focal ?? { x: 0.5, y: 0.5 },
      camera: s.camera,
      transition_in: { type, duration: Math.round(dur * 1000) / 1000 },
    };
  });
  const placement: PlacementOverride[] = scenes.flatMap((s) => {
    const y = i.overrides[s.scene_id]?.caption_y_pct;
    return y === undefined ? [] : [{ from: s.start, to: s.start + s.duration, y_pct: y }];
  });
  return {
    version: 1,
    lang: i.lang,
    format: { id: i.format.id, width: i.format.width, height: i.format.height, fps: i.format.fps, bitrate: i.format.bitrate },
    duration: Math.round(total * 1000) / 1000,
    scenes,
    captions: { enabled: i.captionWords.length > 0, style: i.style, words: i.captionWords, placement },
    audio: i.narration,
    overrides: i.overrides,
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
  return c as unknown as Timeline;
}
