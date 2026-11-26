import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SECONDS, EASABLE, TRANSITIONS, TRANSITION_DIRECTIONS, validateTransition } from '../src/render/transitions.ts';
import type { TransitionSpec } from '../src/render/transitions.ts';
import { videoGraph } from '../src/render/compose.ts';
import type { Timeline } from '../src/render/timeline.ts';
import { validateStoryboardShape } from '../src/studios/storyboard.ts';
import { ffmpegBinary } from '../src/media.ts';

const FPS = 15;
/** Three scenes of 1.6 s (a whole number of frames); both later boundaries use the transition under test. */
const timeline = (spec: TransitionSpec, seconds: number, starts = [0, 1.6, 3.2]) =>
  ({
    format: { id: 'custom_240x426_15', width: 240, height: 426, fps: FPS },
    overrides: {},
    scenes: starts.map((start, index) => ({ scene_id: `s${index}`, index, start, duration: 1.6, asset: null, focal: { x: 0.5, y: 0.5 }, transition_in: index ? { ...spec, duration: seconds } : { type: 'cut', duration: 0 } })),
  }) as unknown as Timeline;

function render(tl: Timeline, dir: string) {
  const total = 4.8;
  const inputs = tl.scenes.flatMap((s, i) => {
    const preroll = i === 0 ? 0 : s.transition_in.duration || 1 / FPS;
    const frames = Math.round((s.duration + preroll) * FPS);
    return ['-f', 'lavfi', '-i', `testsrc=size=240x426:rate=${FPS}:duration=${(frames / FPS).toFixed(4)},hue=h=${i * 120},format=yuv420p`];
  });
  const g = videoGraph(tl);
  const out = execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', g.filters.join(';'), '-map', `[${g.out}]`, '-t', String(total), '-pix_fmt', 'yuv420p', '-f', 'framemd5', '-'], { cwd: dir, maxBuffer: 1 << 26 });
  return out.toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

test('settings are accepted only where the transition can use them', () => {
  assert.deepEqual(validateTransition({ type: 'push', direction: 'up', easing: 'ease_in', intensity: 'strong', blur: 0.4, sound: 'whoosh' }).type, 'push');
  assert.deepEqual(validateTransition({ type: 'cut', sound: 'impact' }), { type: 'cut', sound: 'impact' });
  for (const wrong of [{ type: 'radial', direction: 'left' }, { type: 'radial', easing: 'linear' }, { type: 'cut', blur: 0.2 }, { type: 'slide', color: '#ffffff' }, { type: 'flash', color: 'red' }, { type: 'fade', sound: 'boom' }, { type: 'fade', overlay: 'confetti' }]) {
    assert.throws(() => validateTransition(wrong), `${JSON.stringify(wrong)} should be refused`);
  }
  const scene = { title: 't', script_segment_id: 's', target_duration: 3, visual_description: 'v', asset_type: 'illustration', camera: { movement: 'static' }, transition_in: 'whip_pan', transition_settings: { direction: 'up', duration: 0.5 } };
  assert.doesNotThrow(() => validateStoryboardShape({ scenes: [scene] }));
  assert.throws(() => validateStoryboardShape({ scenes: [{ ...scene, transition_in: 'radial' }] }), /no direction/);
});

test('a cut is joined end to end, with no blend filter', () => {
  const g = videoGraph(timeline({ type: 'cut' }, 0)).filters.join(';');
  assert.ok(g.includes('concat=n=2') && !g.includes('xfade'));
});

test('slide, wipe and push are different pictures, and direction changes the result', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-tr-'));
  const of = (spec: TransitionSpec) => render(timeline(spec, 0.6), dir).join();
  const seen = new Set([of({ type: 'slide' }), of({ type: 'slide', direction: 'up' }), of({ type: 'wipe' }), of({ type: 'wipe', direction: 'right' }), of({ type: 'push' })]);
  assert.equal(seen.size, 5);
});

test('every transition renders, keeps the length, and differs from a plain cut', { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-tr-'));
  const cut = render(timeline({ type: 'cut' }, 0), dir);
  assert.equal(cut.length, 72);
  for (const type of TRANSITIONS.filter((t) => t !== 'cut')) {
    const spec: TransitionSpec = { type, ...(TRANSITION_DIRECTIONS[type] ? { direction: TRANSITION_DIRECTIONS[type]!.at(-1) } : {}), ...(EASABLE.includes(type) ? { easing: 'ease_in_out' } : {}), blur: 0.3, overlay: 'flash' };
    const plain = render(timeline({ type }, Math.min(0.6, DEFAULT_SECONDS[type])), dir);
    assert.equal(plain.length, cut.length, `${type} length`);
    assert.notDeepEqual(plain, cut, type);
    assert.equal(render(timeline(spec, 0.5), dir).length, cut.length, `${type} with settings`);
  }
});
