import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegBinary } from '../src/media.ts';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { animatedSvgRenderCacheMatches, animatedSvgRenderPreference, renderAnimatedSvg, renderAnimatedSvgFrame } from '../src/animation/render.ts';

const ffmpeg = ffmpegBinary();
const canRender = (() => {
  try {
    return execFileSync(ffmpeg, ['-hide_banner', '-decoders'], { stdio: ['ignore', 'pipe', 'ignore'] }).includes('librsvg');
  } catch {
    return false;
  }
})();

function frame(seconds: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 128"><defs><linearGradient id="sky"><stop stop-color="#081826"/><stop offset="1" stop-color="#34635e"/></linearGradient></defs><path d="M0 0H96V128H0Z" fill="url(#sky)"/><g transform="translate(${Math.round(60 * seconds)} 0)"><path d="M11 82C7 64 15 59 22 63C37 73 18 91 11 82Z" fill="#f8a739"/></g></svg>`;
}

// These tests use only our verified, hand-built fixture, not model or imported SVG content.
const fixtureValidator = (svg: string) => assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);

for (const backend of ['librsvg', 'chromium', 'resvg'] as const) test(`renders and probes real H.264 frames and a storyboard PNG with ${backend}`, {
  skip: backend === 'librsvg' ? !canRender : backend === 'chromium' && !process.env.WANDER_TEST_CHROMIUM, timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-svg-test-'));
  try {
    const times: number[] = [];
    const stages = new Set<string>();
    const outputPath = join(root, 'motion.mp4');
    const result = await renderAnimatedSvg({
      outputPath, width: 96, height: 128, durationSeconds: 0.5, fps: 24, backend,
      assertSafeSvg: fixtureValidator,
      frameAt: (t) => { times.push(t); return frame(t); },
      onProgress: ({ stage }) => stages.add(stage),
    });
    assert.deepEqual(result, { outputPath, frames: 12, fps: 24, width: 96, height: 128, durationSeconds: 0.5, backend });
    assert.deepEqual(times, Array.from({ length: 12 }, (_, index) => index / 24));
    assert.deepEqual([...stages], ['frames', 'encoding', 'verifying']);
    const raw = execFileSync(ffmpeg, [
      '-v', 'error', '-i', outputPath, '-vf', 'select=eq(n\\,0)+eq(n\\,11)', '-fps_mode', 'passthrough',
      '-frames:v', '2', '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    const size = 96 * 128 * 3;
    assert.equal(raw.byteLength, 2 * size);
    const center = (pixels: Buffer) => {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 3) {
        if (pixels[i]! > 180 && pixels[i + 1]! > 90 && pixels[i + 2]! < 100) { sum += (i / 3) % 96; count++; }
      }
      assert.ok(count >= 25, 'lantern region remains visible in decoded output');
      return sum / count;
    };
    assert.ok(center(raw.subarray(size)) - center(raw.subarray(0, size)) > 24, 'rendered motion displaced illustration');
    const thumbnail = await renderAnimatedSvgFrame({
      outputPath: join(root, 'storyboard.png'), width: 96, height: 128, svg: frame(0), assertSafeSvg: fixtureValidator, backend,
    });
    assert.deepEqual((await readFile(thumbnail)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual((await readdir(root)).sort(), ['motion.mp4', 'storyboard.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancels immediately; cleans stages when any frame fails required validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-svg-fail-'));
  const outputPath = join(root, 'should-not-exist.mp4');
  try {
    const base = { outputPath, backend: 'librsvg' as const, width: 96, height: 128, fps: 24, durationSeconds: 0.5, frameAt: frame };
    await assert.rejects(renderAnimatedSvg({ ...base, assertSafeSvg: fixtureValidator, signal: AbortSignal.abort() }), {
      code: 'CANCELLED',
    });
    let validated = 0;
    await assert.rejects(renderAnimatedSvg({
      ...base,
      assertSafeSvg: (svg) => {
        fixtureValidator(svg);
        if (++validated === 2) throw new Error('fixture validation stop');
      },
    }), /fixture validation stop/);
    assert.equal(validated, 2);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto reports the resvg fallback, while explicit Chromium fails closed if unavailable', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-svg-fallback-'));
  try {
    const options = {
      outputPath: join(root, 'frame.png'), chromiumExecutable: join(root, 'no-such-browser'), width: 96, height: 128,
      svg: frame(0), assertSafeSvg: fixtureValidator,
    };
    let backend: string | undefined;
    await renderAnimatedSvgFrame({ ...options, backend: 'auto', onBackend: (value) => { backend = value; } });
    assert.equal(backend, 'resvg');
    await assert.rejects(renderAnimatedSvgFrame({ ...options, backend: 'chromium' }), {
      code: 'ANIMATION_CHROMIUM_UNAVAILABLE',
    });
    assert.deepEqual(await readdir(root), ['frame.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backend matching permits verified auto output, not a different explicit backend or unknown legacy metadata', () => {
  assert.equal(animatedSvgRenderPreference('librsvg'), 'librsvg');
  assert.throws(() => animatedSvgRenderPreference('unavailable'), { code: 'ANIMATION_RENDERER' });
  assert.equal(animatedSvgRenderCacheMatches('librsvg', 'auto'), true);
  assert.equal(animatedSvgRenderCacheMatches('resvg', 'auto'), true);
  assert.equal(animatedSvgRenderCacheMatches('chromium', 'chromium'), true);
  assert.equal(animatedSvgRenderCacheMatches('librsvg', 'chromium'), false);
  assert.equal(animatedSvgRenderCacheMatches(undefined, 'auto'), false);
});

test('Storyboard serves a PNG, queues a verified fallback MP4, preserves it on strict renderer failure, and reuses it in auto mode', {
  skip: !canRender, timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-svg-api-render-'));
  const db = openDb();
  const engine = new Engine(db);
  const app = buildApi(engine, { root });
  const variables = ['WANDER_ANIMATION_RENDERER', 'WANDER_CHROMIUM'] as const;
  const prior = variables.map(key => process.env[key]);
  try {
    process.env.WANDER_ANIMATION_RENDERER = 'auto';
    process.env.WANDER_CHROMIUM = join(root, 'missing-sandboxed-chromium');
    const created = await app.inject({ method: 'POST', url: '/projects', payload: {
      name: 'Renderer fixture', category: 'History', formats: ['vertical_9x16'], languages: ['en'],
    } });
    assert.equal(created.statusCode, 201, created.body);
    const storyboard = engine.list(created.json<{id:string}>().id).find(row => row.kind === 'storyboard');
    assert.ok(storyboard);
    engine.saveVersion(storyboard.id, { scenes: [{ scene_id: 'renderer-fixture', title: 'Lantern', script_segment_id: 'intro',
      target_duration: 0.2, visual_description: 'Lantern swings', asset_type: 'image', camera: { movement: 'static', intensity: 'subtle' },
    }] });
    const route = `/artifacts/${storyboard.id}/animated-svg/0`;
    const imported = await app.inject({ method: 'POST', url: `${route}/import`, payload: {
      svg: frame(0).replace('<g transform=', '<g id="lantern" transform='),
      animation: { duration: 0.2, tracks: [{ target: 'lantern', property: 'translate', keys: [{ time: 0, value: [0, 0] }, { time: 0.2, value: [10, 0] }] }] },
    } });
    assert.equal(imported.statusCode, 200, imported.body);
    const { revision } = imported.json<{revision:string}>();
    const preview = await app.inject({ method: 'GET', url: `${route}/preview?revision=${revision}&time=0.1` });
    assert.equal(preview.statusCode, 200, preview.headers['content-type'] === 'application/json' ? preview.body : 'Storyboard preview returns a PNG');
    assert.equal(preview.headers['content-type'], 'image/png');
    assert.deepEqual([preview.rawPayload.readUInt32BE(16), preview.rawPayload.readUInt32BE(20)], [360, 640]);
    const approved = await app.inject({ method: 'POST', url: `${route}/approve`, payload: { revision } });
    assert.equal(approved.statusCode, 200, approved.body);
    type Job = {state: string; message: string; result?: {video?: {backend?:string; frames?:number; durationSeconds?:number}}; error?: {code:string}};
    const render = async () => {
      const requested = await app.inject({ method: 'POST', url: `${route}/render`, payload: { revision, preset: 'draft' } });
      assert.equal(requested.statusCode, 202, requested.body);
      const { id } = requested.json<{job:{id:string}}>().job;
      let job: Job | undefined;
      for (let i = 0; i < 200; i++) {
        const status = await app.inject({ method: 'GET', url: `/jobs/${id}` });
        assert.equal(status.statusCode, 200, status.body);
        job = status.json<Job>();
        if (!['queued', 'running'].includes(job.state)) return job;
        await wait(25);
      }
      throw new Error(`Render did not finish: ${JSON.stringify(job)}`);
    };
    const exported = await render();
    assert.equal(exported.state, 'succeeded', JSON.stringify(exported));
    assert.deepEqual(exported.result?.video, { width: 360, height: 640, fps: 15, backend: 'librsvg', frames: 3, durationSeconds: 0.2 });
    const firstVideo = await app.inject({ method: 'GET', url: `${route}/video?revision=${revision}` });
    assert.equal(firstVideo.statusCode, 200);
    assert.equal(firstVideo.headers['content-type'], 'video/mp4');
    process.env.WANDER_ANIMATION_RENDERER = 'chromium';
    const strict = await render();
    assert.equal(strict.state, 'failed', JSON.stringify(strict));
    assert.equal(strict.error?.code, 'ANIMATION_CHROMIUM_UNAVAILABLE');
    const retained = await app.inject({ method: 'GET', url: `${route}/video?revision=${revision}` });
    assert.equal(retained.statusCode, 200);
    assert.deepEqual(retained.rawPayload, firstVideo.rawPayload);
    process.env.WANDER_ANIMATION_RENDERER = 'auto';
    const cached = await render();
    assert.equal(cached.state, 'succeeded', JSON.stringify(cached));
    assert.deepEqual(cached.result?.video, exported.result?.video);
    if (process.env.WANDER_TEST_CHROMIUM) {
      process.env.WANDER_ANIMATION_RENDERER = 'chromium';
      if (prior[1] === undefined) delete process.env.WANDER_CHROMIUM;
      else process.env.WANDER_CHROMIUM = prior[1];
      const browserPreview = await app.inject({ method: 'GET', url: `${route}/preview?revision=${revision}&time=0.1` });
      assert.equal(browserPreview.statusCode, 200);
      assert.deepEqual([browserPreview.rawPayload.readUInt32BE(16), browserPreview.rawPayload.readUInt32BE(20)], [360, 640]);
      const browserExport = await render();
      assert.equal(browserExport.state, 'succeeded', JSON.stringify(browserExport));
      assert.deepEqual(browserExport.result?.video, { ...exported.result?.video, backend: 'chromium' });
    }
  } finally {
    variables.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
