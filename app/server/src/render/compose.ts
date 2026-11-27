// The video graph of the final pass: scene clips joined by their transitions.
import { parseFormat } from './formats.ts';
import { coverCrop } from './motion.ts';
import { boundaryFilters } from './transitions.ts';
import type { TransitionSpec } from './transitions.ts';
import type { Timeline, TimelineScene } from './timeline.ts';

/** Where a scene's subject sits in the output frame, 0..1. */
function subject(tl: Timeline, s: TimelineScene) {
  if (!s.asset) return { x: 0.5, y: 0.5 };
  const crop = coverCrop({ w: s.asset.width, h: s.asset.height }, { w: tl.format.width, h: tl.format.height }, s.focal, tl.overrides[s.scene_id]?.crop);
  const rel = (v: number, size: number, from: number, len: number) => Math.min(1, Math.max(0, (v * size - from) / len));
  return { x: rel(s.focal.x, s.asset.width, crop.x, crop.w), y: rel(s.focal.y, s.asset.height, crop.y, crop.h) };
}

/** Filter chains for inputs 0..n-1 (one per scene clip); `out` is the label of the joined picture. */
export function videoGraph(tl: Timeline): { filters: string[]; out: string } {
  const { fps, width, height } = parseFormat(tl.format.id, { fps: tl.format.fps });
  // Normalize after resetting timestamps: FFmpeg 7 can clear frame-rate metadata in setpts.
  const filters: string[] = tl.scenes.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,setsar=1,fps=${fps}[s${i}]`);
  let last = 's0';
  for (let i = 1; i < tl.scenes.length; i++) {
    const s = tl.scenes[i];
    const { duration, ...settings } = s.transition_in;
    const b = boundaryFilters({
      index: i,
      prev: last,
      next: `s${i}`,
      spec: settings as TransitionSpec,
      seconds: duration,
      start: s.start,
      size: { w: width, h: height },
      fps,
      ...(settings.type === 'match_cut' ? { focal: { from: subject(tl, tl.scenes[i - 1]), to: subject(tl, s) } } : {}),
    });
    filters.push(...b.filters);
    last = b.out;
  }
  return { filters, out: last };
}
