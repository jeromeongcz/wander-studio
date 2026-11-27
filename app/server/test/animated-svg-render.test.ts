import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ffmpegBinary } from '../src/media.ts';
import { renderAnimatedSvg, renderAnimatedSvgFrame } from '../src/animation/render.ts';

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

for (const backend of ['librsvg', 'chromium'] as const) test(`renders and probes real H.264 frames and a storyboard PNG with ${backend}`, {
  skip: backend === 'librsvg' ? !canRender : !process.env.WANDER_TEST_CHROMIUM, timeout: 60_000,
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

test('auto reports the librsvg fallback, while explicit Chromium fails closed if unavailable', { skip: !canRender, timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-svg-fallback-'));
  try {
    const options = {
      outputPath: join(root, 'frame.png'), chromiumExecutable: join(root, 'no-such-browser'), width: 96, height: 128,
      svg: frame(0), assertSafeSvg: fixtureValidator,
    };
    let backend: string | undefined;
    await renderAnimatedSvgFrame({ ...options, backend: 'auto', onBackend: (value) => { backend = value; } });
    assert.equal(backend, 'librsvg');
    await assert.rejects(renderAnimatedSvgFrame({ ...options, backend: 'chromium' }), {
      code: 'ANIMATION_CHROMIUM_UNAVAILABLE',
    });
    assert.deepEqual(await readdir(root), ['frame.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
