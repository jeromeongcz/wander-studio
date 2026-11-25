import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLITCH_SECONDS, applyEffects, folkloreCamera, impactTimes } from '../src/render/effects.ts';
import { sceneClipArgs, sceneClipKey } from '../src/render/motion.ts';
import type { SceneClipSpec } from '../src/render/motion.ts';
import { buildAss, isKeyword } from '../src/captions/ass.ts';
import { DEFAULT_STYLE } from '../src/captions/track.ts';
import { parseFormat, safeZoneFor } from '../src/render/formats.ts';
import { ffmpegBinary } from '../src/media.ts';

const scene = (i: number, start: number, duration: number) => ({ scene_id: `s${i}`, index: i, title: `Scene ${i}`, start, duration, timing_source: 'audio' as const, asset: null, focal: { x: 0.5, y: 0.5 }, camera: { movement: 'static' as const }, transition_in: { type: 'dissolve', duration: 0.4 } });
const timeline = () => ({ version: 1 as const, lang: 'en', format: { id: 'vertical_9x16', width: 1080, height: 1920, fps: 30 }, duration: 12, scenes: [scene(0, 0, 4), scene(1, 4, 5), scene(2, 9, 3)], captions: { enabled: true, style: DEFAULT_STYLE, words: [], placement: [] }, audio: { chunks: [], narration_total: 11.6, mix: {}, music: [], sfx: [] }, overrides: {}, source: {} });

test('folklore style: every shot moves, cuts are hard, hits are selective; clean timelines are untouched', () => {
  const t = timeline();
  assert.equal(applyEffects(t, undefined), t);
  const f = applyEffects(t, 'folklore');
  assert.equal(f.effects, 'folklore');
  assert.ok(f.scenes.every((s) => s.camera.movement !== 'static' && s.transition_in.type === 'cut' && s.transition_in.duration === 0));
  assert.equal(f.captions.mode, 'word');
  assert.equal(folkloreCamera(0, 9).intensity, 'strong');
  assert.equal(folkloreCamera(8, 9).intensity, 'strong');
  assert.deepEqual(impactTimes(f), [4, 9, 12 - GLITCH_SECONDS]);
  assert.equal(t.scenes[0].camera.movement, 'static', 'the storyboard timeline is not changed in place');
});

test('one-word captions: uppercase italic, one event per word, names and numbers in red', () => {
  const w = (text: string, start: number, section_id = 'a') => ({ text, start, end: start + 0.3, section_id });
  const words = [w('Sabi', 0), w('ng', 0.4), w('Maynila,', 0.8), w('noong', 1.2), w('1603.', 1.6), w('Dumating', 2.2, 'b')];
  assert.deepEqual(words.map((_, i) => isKeyword(words, i)), [false, false, true, false, true, false], 'a capital that only starts a sentence is not a name');
  const format = parseFormat('vertical_9x16');
  const ass = buildAss({ words, style: DEFAULT_STYLE, format, zone: safeZoneFor(format), mode: 'word' });
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.equal(events.length, words.length);
  assert.match(events[2], /\\i1.*}MAYNILA$/);
  assert.match(events[2], /\\c&H00241EE0&/);
  assert.match(events[0], /\\c&H00FFFFFF&/);
});

test('an effects scene clip really renders, with extra framings and the glitch, and has its own cache key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-fx-'));
  const img = join(dir, 'a.png');
  execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', img]);
  const clean: SceneClipSpec = { asset: { path: img, kind: 'image', width: 640, height: 360, sha256: 'x' }, focal: { x: 0.5, y: 0.5 }, camera: { movement: 'zoom', direction: 'in' }, duration: 7, width: 320, height: 180, fps: 15 };
  const fx: SceneClipSpec = { ...clean, effects: 'folklore', glitch: true };
  assert.notEqual(sceneClipKey(clean), sceneClipKey(fx));
  const args = sceneClipArgs(fx, join(dir, 'fx.mp4'));
  const chain = args[args.indexOf('-vf') + 1];
  for (const part of ['if(lt(on,', 'vignette', 'noise=', 'rgbashift']) assert.ok(chain.includes(part), part);
  assert.ok(!sceneClipArgs(clean, 'x.mp4').join(' ').includes('vignette'));
  execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.ok(existsSync(join(dir, 'fx.mp4')) && statSync(join(dir, 'fx.mp4')).size > 1000);
});
