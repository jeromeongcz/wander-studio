// Compatibility guarantee for the cinematic expansion: a composition that uses none of the new options must produce the
// same cache keys, captions and sound graph as it did before. The all-cut composition still uses the original
// FFmpeg arguments; the blended composition includes constant-rate normalization for FFmpeg 7 compatibility.
// Only re-record the fixture (UPDATE_GOLDEN=1) for a deliberate change with a real-render regression test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneClipArgs, sceneClipKey } from '../src/render/motion.ts';
import type { Camera, SceneClipSpec } from '../src/render/motion.ts';
import { buildTimeline, timelineHash } from '../src/render/timeline.ts';
import type { BuildInput, Timeline } from '../src/render/timeline.ts';
import { applyEffects, impactTimes } from '../src/render/effects.ts';
import { RenderService } from '../src/render/service.ts';
import { parseFormat, safeZoneFor } from '../src/render/formats.ts';
import { buildAss } from '../src/captions/ass.ts';
import { DEFAULT_STYLE } from '../src/captions/track.ts';
import { buildMixGraph } from '../src/audio/mix.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'render-golden.json');
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 20);

const CAMERAS: Camera[] = [
  { movement: 'static' },
  ...(['left_to_right', 'right_to_left', 'up', 'down'] as const).map((direction) => ({ movement: 'pan' as const, direction })),
  { movement: 'pan' },
  ...(['in', 'out'] as const).flatMap((direction) => [{ movement: 'zoom' as const, direction }, { movement: 'ken_burns' as const, direction }]),
  { movement: 'parallax' },
];
const SIZES = [[1080, 1920], [1920, 1080], [1080, 1080]] as const;

function clips() {
  const out: Record<string, string> = {};
  const add = (name: string, s: SceneClipSpec) => (out[name] = `${sceneClipKey(s)} ${sha(sceneClipArgs(s, 'out.mp4'))}`);
  const base: SceneClipSpec = { asset: { path: 'in.png', kind: 'image', width: 1600, height: 1200, sha256: 'abc' }, focal: { x: 0.62, y: 0.4 }, camera: { movement: 'static' }, duration: 5.3, width: 1080, height: 1920, fps: 30 };
  for (const [width, height] of SIZES)
    for (const c of CAMERAS)
      for (const intensity of [undefined, 'subtle', 'medium', 'strong'] as const) {
        const camera = { ...c, ...(intensity ? { intensity } : {}) };
        const name = `${width}x${height} ${camera.movement} ${camera.direction ?? '-'} ${intensity ?? '-'}`;
        add(name, { ...base, width, height, camera });
        add(`${name} folklore`, { ...base, width, height, camera, effects: 'folklore' });
      }
  add('final folklore shot', { ...base, effects: 'folklore', glitch: true });
  add('cropped', { ...base, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } });
  add('stock video', { ...base, asset: { ...base.asset, path: 'in.mp4', kind: 'video' } });
  return out;
}

function input(): BuildInput {
  const types = [undefined, 'cut', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'];
  const words = types.flatMap((_, i) => [0, 1].map((k) => ({ section_id: `s${i}`, start: i * 3 + k * 1.2, end: i * 3 + k * 1.2 + 1, text: k ? 'Maynila.' : 'Sabi', })));
  return {
    lang: 'en',
    format: parseFormat('vertical_9x16'),
    scenes: types.map((t, i) => ({ scene_id: `scene${i}`, script_segment_id: `s${i}`, target_duration: 3, title: `Scene ${i}`, camera: CAMERAS[i], ...(t ? { transition_in: t } : {}) })),
    assets: new Map(types.map((_, i) => [`scene${i}`, { id: `a${i}`, sha256: `h${i}`, rel_path: `projects/p/a${i}.png`, kind: 'image' as const, width: 1080, height: 1920, focal: { x: 0.5, y: 0.45 } }])),
    timelineWords: words,
    narration: { chunks: [{ clip_id: 'n', rel_path: 'projects/p/n.wav', start: 0, duration: 21 }], narration_total: 21, mix: {}, music: [], sfx: [] },
    captionWords: words,
    style: DEFAULT_STYLE,
    overrides: { scene2: { caption_y_pct: 0.6 }, scene3: { crop: { x: 0, y: 0, w: 0.8, h: 0.8 } } },
    source: { storyboard: 'v1', audio: 'v2', caption: 'v3' },
  };
}

/** The final FFmpeg graph, captured by standing a recording script in for ffmpeg. */
async function composeArgs(tl: Timeline) {
  const dir = mkdtempSync(join(tmpdir(), 'wander-golden-'));
  const bin = join(dir, 'record.sh');
  writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.args"\n');
  chmodSync(bin, 0o755);
  const svc = new RenderService(null as never, null as never, null as never, { root: dir, maxImportBytes: 0, maxRemoteBytes: 0 });
  svc.ffmpeg = bin;
  await (svc as any).compose(tl, tl.scenes.map((_, i) => `c${i}.mp4`), 'mix.wav', 'clean', 'out.mp4');
  return readFileSync(`${bin}.args`, 'utf8');
}

async function snapshot() {
  const clean = buildTimeline(input());
  const folklore = applyEffects(clean, 'folklore');
  const format = parseFormat('vertical_9x16');
  const ass = (tl: Timeline) => buildAss({ words: tl.captions.words, style: tl.captions.style, format, zone: safeZoneFor(format), placement: tl.captions.placement, mode: tl.captions.mode });
  const mix = buildMixGraph({ narration: [{ path: 'n.wav', start: 0 }], music: [{ path: 'm.wav', spec: { clip_id: 'm', loop: true, fade_in: 1, fade_out: 2 } }], sfx: [{ path: 'x.wav', spec: { clip_id: 'x', at: 4 } }], spec: {}, duration: 21.4 });
  return {
    clips: clips(),
    timeline: { clean: sha(clean), folklore: sha(folklore), cleanHash: timelineHash(clean), folkloreHash: timelineHash(folklore) },
    captions: { clean: sha(ass(clean)), folklore: sha(ass(folklore)) },
    compose: process.platform === 'win32' ? null : { clean: await composeArgs(clean), folklore: await composeArgs(folklore) },
    sound: { mix: mix.filter, impacts: impactTimes(folklore) },
  };
}

test('existing compositions keep the recorded graph, timestamps, captions and cache keys', async () => {
  const now = await snapshot();
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 1)}\n`);
  }
  const then = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (now.compose === null) then.compose = null;
  assert.deepEqual(JSON.parse(JSON.stringify(now)), then);
});
