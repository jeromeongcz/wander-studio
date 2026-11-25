import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARAMS, STYLES, STYLE_IDS, resolveLook, validateLook } from '../src/render/styles.ts';
import type { ParamName } from '../src/render/styles.ts';
import { sceneClipArgs, sceneClipKey } from '../src/render/motion.ts';
import type { SceneClipSpec } from '../src/render/motion.ts';
import { buildTimeline, validateTimelineShape } from '../src/render/timeline.ts';
import type { BuildInput } from '../src/render/timeline.ts';
import { applyEffects } from '../src/render/effects.ts';
import { parseFormat } from '../src/render/formats.ts';
import { DEFAULT_STYLE } from '../src/captions/track.ts';
import { ffmpegBinary } from '../src/media.ts';

test('folklore and dark folklore are separate styles with their own character', () => {
  const [folk, dark] = [resolveLook({ style: 'folklore' }), resolveLook({ style: 'dark_folklore' })];
  assert.notDeepEqual(folk, dark);
  assert.ok(dark.vignette! > folk.vignette! && dark.grain! > folk.grain! && dark.saturation! < folk.saturation!);
  assert.equal(folk.grading, 'earthy');
  assert.equal(folk.ambience, 'wind');
  assert.equal(dark.ambience, 'drone');
});

test('choices go on top of the preset; neutral values disappear; wrong values are refused', () => {
  assert.deepEqual(resolveLook({ style: 'minimal', params: { contrast: 1, grain: 0.3 } }), { style: 'minimal', grain: 0.3 });
  assert.deepEqual(resolveLook({ style: 'none' }), { style: 'none' });
  for (const style of STYLE_IDS) assert.doesNotThrow(() => validateLook({ style, params: STYLES[style].params }));
  for (const wrong of [{ style: 'noir' }, { style: 'folklore', params: { grain: 5 } }, { style: 'folklore', params: { smoke: 1 } }, { style: 'folklore', params: { grading: 'pink' } }, { style: 'folklore', extra: 1 }]) assert.throws(() => validateLook(wrong));
});

const input = (extra: Partial<BuildInput> = {}, scene: Partial<BuildInput['scenes'][number]> = {}): BuildInput => ({
  lang: 'en', format: parseFormat('vertical_9x16'),
  scenes: [0, 1].map((i) => ({ scene_id: `s${i}`, script_segment_id: `x${i}`, target_duration: 4, title: `S${i}`, camera: { movement: 'static' as const }, ...scene })),
  assets: new Map(), timelineWords: [], narration: { chunks: [], narration_total: 7.6, mix: {}, music: [], sfx: [] }, captionWords: [], style: DEFAULT_STYLE, overrides: {}, source: {}, ...extra,
});

test('style precedence: scene, then the person’s storyboard, then the video, then generated, then the project direction', () => {
  const direction_look = { style: 'documentary' as const };
  const style = (extra: Partial<BuildInput>, scene = {}) => buildTimeline(input(extra, scene)).scenes[0].look?.style;
  assert.equal(style({}), undefined, 'no style chosen: nothing is applied');
  assert.equal(style({ direction_look }), 'documentary');
  const ai = { look: { style: 'horror' as const }, origin: { look: 'ai' as const } };
  assert.equal(style({ direction_look }, ai), 'horror');
  assert.equal(style({ direction_look, overrides_all: { look: { style: 'folklore' } } }, ai), 'folklore');
  const mine = { look: { style: 'fantasy' as const }, origin: { look: 'user' as const } };
  assert.equal(style({ overrides_all: { look: { style: 'folklore' } } }, mine), 'fantasy');
  assert.equal(style({ overrides: { s0: { look: { style: 'minimal' } } } }, mine), 'minimal');
  // generated extra effects join a weaker style, and a stronger choice leaves them out
  const extra = { look: { params: { fog: 0.9 } }, origin: { look: 'ai' as const } };
  assert.equal(buildTimeline(input({ direction_look }, extra)).scenes[0].look?.fog, 0.9);
  assert.equal(buildTimeline(input({ overrides_all: { look: { style: 'minimal' } } }, extra)).scenes[0].look?.fog, undefined);
});

test('a video-wide style sets ambience and, only when asked, one-word captions; classic folklore replaces it', () => {
  const tl = buildTimeline(input({ overrides_all: { look: { style: 'folklore', params: { captions: 'word' } } }, captionWords: [] }));
  assert.deepEqual(tl.look, { style: 'folklore', ambience: 'wind' });
  assert.equal(tl.captions.mode, 'word');
  assert.equal(buildTimeline(input({ overrides_all: { look: { style: 'dark_folklore' } } })).captions.mode, undefined);
  assert.doesNotThrow(() => validateTimelineShape(tl));
  const classic = applyEffects(buildTimeline(input({ direction_look: { style: 'folklore' }, overrides: { s1: { look: { style: 'minimal' } } } })), 'folklore');
  assert.equal(classic.look, undefined);
  assert.equal(classic.scenes[0].look, undefined);
  assert.equal(classic.scenes[1].look?.style, 'minimal');
});

test('every style and effect changes the rendered picture, on stills and on stock video', { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-look-'));
  const ff = (args: string[]) => execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 26 });
  const img = join(dir, 'a.png');
  const vid = join(dir, 'v.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x568', '-frames:v', '1', img]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=10:duration=1', '-pix_fmt', 'yuv420p', vid]);
  const base: SceneClipSpec = { asset: { path: img, kind: 'image', width: 320, height: 568, sha256: 'x' }, focal: { x: 0.5, y: 0.5 }, camera: { movement: 'pan', intensity: 'strong' }, duration: 3, width: 240, height: 426, fps: 10 };
  const frames = (spec: SceneClipSpec) => {
    const out = join(dir, 'o.mp4');
    ff(sceneClipArgs(spec, out));
    assert.ok(statSync(out).size > 500);
    return ff(['-i', out, '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()).join();
  };
  const plain = frames(base);
  const looks = [...STYLE_IDS.filter((s) => s !== 'custom').map((style) => resolveLook({ style })), ...(Object.keys(PARAMS) as ParamName[]).map((k) => resolveLook({ style: 'custom', params: { [k]: PARAMS[k].neutral === PARAMS[k].max ? PARAMS[k].min : PARAMS[k].max } }))];
  for (const look of looks) {
    const out = frames({ ...base, look });
    assert.notEqual(out, plain, JSON.stringify(look));
    assert.equal(out.split(',').length, 30, 'same number of frames');
    assert.notEqual(sceneClipKey({ ...base, look }), sceneClipKey(base));
  }
  const video: SceneClipSpec = { ...base, asset: { ...base.asset, path: vid, kind: 'video' }, duration: 1 };
  assert.notEqual(frames({ ...video, look: resolveLook({ style: 'folklore' }) }), frames(video));
});
