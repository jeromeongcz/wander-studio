import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { PRECEDENCE, resolveLayers, storyboardSource, validateCameraOverride, validateTransitionOverride } from '../src/render/resolve.ts';
import type { Source } from '../src/render/resolve.ts';
import { buildTimeline, validateTimelineShape } from '../src/render/timeline.ts';
import type { BuildInput } from '../src/render/timeline.ts';
import { applyEffects, folkloreCamera } from '../src/render/effects.ts';
import { sceneClipArgs, sceneClipKey } from '../src/render/motion.ts';
import { parseFormat } from '../src/render/formats.ts';
import { DEFAULT_STYLE } from '../src/captions/track.ts';

test('precedence: the strongest layer that has a value wins', () => {
  assert.deepEqual([...PRECEDENCE], ['scene_override', 'storyboard_user', 'composition_override', 'ai', 'draft', 'direction', 'default']);
  PRECEDENCE.forEach((top, i) => {
    const layers = Object.fromEntries(PRECEDENCE.slice(i).map((s) => [s, s])) as Record<Source, string>;
    assert.deepEqual(resolveLayers<string>({ ...layers, default: 'default' }), { value: top, source: top });
  });
  assert.deepEqual(resolveLayers<string>({ ai: undefined, default: 'd' }), { value: 'd', source: 'default' });
});

test('storyboard origin: untouched drafts are drafts; anything else is the person’s', () => {
  assert.equal(storyboardSource({ draft: true }, 'camera'), 'draft');
  assert.equal(storyboardSource({}, 'camera'), 'storyboard_user');
  assert.equal(storyboardSource({ draft: true, origin: { camera: 'user' } }, 'camera'), 'storyboard_user');
  assert.equal(storyboardSource({ draft: true, origin: { camera: 'user' } }, 'transition'), 'draft');
  assert.equal(storyboardSource({ origin: { transition: 'ai' } }, 'transition'), 'ai');
});

test('only values the renderer can execute are accepted', () => {
  assert.deepEqual(validateCameraOverride({ movement: 'zoom', direction: 'out' }), { movement: 'zoom', direction: 'out' });
  assert.throws(() => validateCameraOverride({ movement: 'dolly_in' }), /movement must be one of/);
  assert.throws(() => validateCameraOverride({ movement: 'zoom', direction: 'up' }), /direction/);
  assert.throws(() => validateCameraOverride({ movement: 'static', direction: 'in' }), /no direction/);
  assert.throws(() => validateCameraOverride({ movement: 'pan', easing: 'linear' }), /does not support: easing/);
  assert.deepEqual(validateTransitionOverride({ type: 'slide', duration: 0.8 }), { type: 'slide', duration: 0.8 });
  assert.throws(() => validateTransitionOverride({ type: 'glitch' }), /type must be one of/);
  assert.throws(() => validateTransitionOverride({ type: 'cut', duration: 0.5 }), /no duration/);
  assert.throws(() => validateTransitionOverride({ type: 'fade', duration: 9 }), /duration must be/);
  assert.throws(() => validateTransitionOverride({ type: 'fade', direction: 'left' }), /does not support: direction/);
});

const input = (extra: Partial<BuildInput> = {}, scene: Partial<BuildInput['scenes'][number]> = {}): BuildInput => ({
  lang: 'en',
  format: parseFormat('vertical_9x16'),
  scenes: [0, 1, 2].map((i) => ({ scene_id: `s${i}`, script_segment_id: `x${i}`, target_duration: 4, title: `S${i}`, camera: { movement: 'zoom' as const, direction: 'in' }, transition_in: 'dissolve', draft: true, ...scene })),
  assets: new Map(),
  timelineWords: [0, 1, 2].map((i) => ({ section_id: `x${i}`, start: i * 4, end: i * 4 + 3 })),
  narration: { chunks: [], narration_total: 11.6, mix: {}, music: [], sfx: [] },
  captionWords: [],
  style: DEFAULT_STYLE,
  overrides: {},
  source: {},
  ...extra,
});

test('video-wide settings replace automatic draft values but not the person’s', () => {
  const wide = { camera: { movement: 'static' as const }, transition: { type: 'wipe' as const, duration: 1 } };
  const drafts = buildTimeline(input({ overrides_all: wide }));
  assert.deepEqual(drafts.scenes.map((s) => s.camera.movement), ['static', 'static', 'static']);
  assert.deepEqual(drafts.scenes.map((s) => s.transition_in), [{ type: 'cut', duration: 0 }, { type: 'wipe', duration: 1 }, { type: 'wipe', duration: 1 }]);
  assert.deepEqual(drafts.scenes[0].sources, { camera: 'composition_override' });
  const mine = buildTimeline(input({ overrides_all: wide, overrides: { s1: { camera: { movement: 'parallax' } } } }, { draft: false }));
  assert.deepEqual(mine.scenes.map((s) => s.camera.movement), ['zoom', 'parallax', 'zoom']);
  assert.equal(mine.scenes[2].transition_in.type, 'dissolve');
  assert.equal(mine.scenes[0].sources, undefined);
});

test('the classic folklore style keeps its look, except where the person overrode a scene', () => {
  const tl = buildTimeline(input({ overrides: { s1: { camera: { movement: 'static' }, transition: { type: 'fade' } } } }));
  const fx = applyEffects(tl, 'folklore');
  assert.deepEqual(fx.scenes[1].camera, { movement: 'static' });
  assert.equal(fx.scenes[1].transition_in.type, 'fade');
  assert.deepEqual(fx.scenes[2].camera, folkloreCamera(2, 3));
  assert.equal(fx.scenes[2].transition_in.type, 'cut');
  // a chosen camera is one continuous move, with its own cache entry
  const spec = { asset: { path: 'a.png', kind: 'image' as const, width: 800, height: 800, sha256: 'x' }, focal: { x: 0.5, y: 0.5 }, camera: { movement: 'static' as const }, duration: 9, width: 320, height: 320, fps: 15, effects: 'folklore' as const };
  assert.ok(sceneClipArgs(spec, 'o.mp4').join(' ').includes('if(lt(on,'));
  assert.ok(!sceneClipArgs({ ...spec, hold: true }, 'o.mp4').join(' ').includes('if(lt(on,'));
  assert.notEqual(sceneClipKey(spec), sceneClipKey({ ...spec, hold: true }));
});

test('a stored composition with an unusable override is rejected', () => {
  const tl = buildTimeline(input());
  assert.doesNotThrow(() => validateTimelineShape(tl));
  assert.throws(() => validateTimelineShape({ ...tl, overrides: { s1: { camera: { movement: 'spin' } } } }), /movement/);
  assert.throws(() => validateTimelineShape({ ...tl, overrides_all: { transition: { type: 'nope' } } }), /type/);
});

test('the server records who set a storyboard camera and ignores what the client claims', async () => {
  const app = buildApi(new Engine(openDb()));
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  const p = await call('POST', '/projects', { name: 'Origins', languages: ['en'], formats: ['vertical_9x16'] });
  const all = (await call('GET', `/projects/${p.json.id}`)).json.artifacts as { id: string; kind: string }[];
  const sb = all.find((a) => a.kind === 'storyboard')!.id;
  const scene = { title: 'One', script_segment_id: 'h', target_duration: 3, visual_description: 'v', asset_type: 'illustration', camera: { movement: 'zoom' }, transition_in: 'cut', draft: true };
  const save = async (change: object) => {
    const cur = (await call('GET', `/artifacts/${sb}`)).json.content;
    const r = await call('PUT', `/artifacts/${sb}/content`, { content: { scenes: [{ ...(cur?.scenes[0] ?? scene), ...change }] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { saved: r.json, scene: (await call('GET', `/artifacts/${sb}`)).json.content.scenes[0] };
  };
  assert.equal((await save({})).scene.origin, undefined);
  const claimed = await save({ origin: { camera: 'ai' } });
  assert.equal(claimed.saved.changed, false, 'a claimed origin alone changes nothing');
  assert.deepEqual((await save({ camera: { movement: 'pan' } })).scene.origin, { camera: 'user' });
  assert.deepEqual((await save({ title: 'Two', origin: undefined })).scene.origin, { camera: 'user' }, 'kept when the client drops it');
  assert.deepEqual((await save({ transition_in: 'fade' })).scene.origin, { camera: 'user', transition: 'user' });
  assert.equal((await call('PUT', `/artifacts/${sb}/content`, { content: { scenes: [{ ...scene, origin: { camera: 'nobody' } }] } })).status, 422);
});
