import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CINEMATIC_MOVEMENTS, DIRECTIONS, EASINGS, MOVEMENTS, cameraMove, isClassicCamera, validateCamera } from '../src/render/camera.ts';
import { motionPlan, sceneClipArgs, sceneClipKey } from '../src/render/motion.ts';
import type { SceneClipSpec } from '../src/render/motion.ts';
import { validateStoryboardShape } from '../src/studios/storyboard.ts';
import { ffmpegBinary } from '../src/media.ts';

const focal = { x: 0.7, y: 0.35 };

test('every movement keeps its final framing inside the picture and on the subject', () => {
  for (const movement of MOVEMENTS) {
    for (const direction of [undefined, ...DIRECTIONS[movement]]) {
      const { plan: p } = cameraMove({ movement, intensity: 'strong', ...(direction ? { direction } : {}) }, focal, motionPlan);
      for (const [z, cx, cy] of [[p.z0, p.cx0, p.cy0], [p.z1, p.cx1, p.cy1]]) {
        assert.ok(z >= 1 && z <= 2.5, `${movement} zoom ${z}`);
        assert.ok(cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1, `${movement} centre`);
      }
      assert.ok(Math.abs(p.cx1 - focal.x) <= 0.5 / p.z1 + 1e-9 && Math.abs(p.cy1 - focal.y) <= 0.5 / p.z1 + 1e-9, `${movement} ${direction ?? ''} loses the subject`);
    }
  }
});

test('the new movements are not renamed zooms: each produces its own filters', () => {
  const spec: SceneClipSpec = { asset: { path: 'a.png', kind: 'image', width: 900, height: 1600, sha256: 'x' }, focal, camera: { movement: 'static' }, duration: 4, width: 1080, height: 1920, fps: 30 };
  const seen = new Set(CINEMATIC_MOVEMENTS.map((movement) => sceneClipArgs({ ...spec, camera: { movement } }, 'o.mp4').join(' ')));
  assert.equal(seen.size, CINEMATIC_MOVEMENTS.length);
});

test('classic cameras stay on the original path; any new setting leaves it', () => {
  assert.ok(isClassicCamera({ movement: 'pan', direction: 'up', intensity: 'strong' }));
  assert.ok(!isClassicCamera({ movement: 'dolly_in' }));
  assert.ok(!isClassicCamera({ movement: 'zoom', easing: 'ease_out' }));
  assert.ok(!isClassicCamera({ movement: 'zoom', intensity: 'custom', amount: 2 }));
});

test('settings are validated', () => {
  assert.doesNotThrow(() => validateCamera({ movement: 'orbit', direction: 'right_to_left', intensity: 'custom', amount: 2, easing: 'custom', curve: 2, start: { x: 0.2, y: 0.5 }, end_zoom: 1.5, rotation: -3, shake: 0.3, motion_blur: 0.5, move_seconds: 2, focal }));
  for (const wrong of [{ amount: 9 }, { rotation: 30 }, { start: { x: 2, y: 0 } }, { easing: 'bouncy' }, { end_zoom: 0.5 }]) assert.throws(() => validateCamera({ movement: 'zoom', ...wrong }));
  const scene = { title: 't', script_segment_id: 's', target_duration: 3, visual_description: 'v', asset_type: 'illustration', camera: { movement: 'pan', direction: 'sideways' } };
  assert.doesNotThrow(() => validateStoryboardShape({ scenes: [scene] }), 'odd directions in saved storyboards still load');
  assert.throws(() => validateStoryboardShape({ scenes: [{ ...scene, camera: { movement: 'zoom', amount: 99 } }] }), /amount/);
});

test('every easing and every extra renders with FFmpeg', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-cam-'));
  const img = join(dir, 'a.png');
  execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', img]);
  const base: SceneClipSpec = { asset: { path: img, kind: 'image', width: 640, height: 360, sha256: 'x' }, focal, camera: { movement: 'static' }, duration: 1, width: 240, height: 426, fps: 15 };
  const cameras = [
    ...EASINGS.map((easing) => ({ movement: 'dolly_in' as const, easing, curve: 2.5 })),
    ...CINEMATIC_MOVEMENTS.map((movement) => ({ movement })),
    { movement: 'pan' as const, easing: 'cinematic' as const, rotation: 5, shake: 0.5, motion_blur: 1, move_seconds: 0.5, start: { x: 0.3, y: 0.5 }, end: { x: 0.7, y: 0.5 }, start_zoom: 1.2, end_zoom: 1.4 },
  ];
  for (const [i, camera] of cameras.entries()) {
    const out = join(dir, `${i}.mp4`);
    execFileSync(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', '-y', ...sceneClipArgs({ ...base, camera }, out)]);
    assert.ok(statSync(out).size > 500, JSON.stringify(camera));
  }
  assert.notEqual(sceneClipKey({ ...base, camera: cameras[0] }), sceneClipKey({ ...base, camera: cameras[1] }));
});
