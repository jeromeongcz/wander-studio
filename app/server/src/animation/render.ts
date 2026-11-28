import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { renderAsync } from '@resvg/resvg-js';
import { EngineError } from '../engine.ts';
import { ffmpegBinary, ffprobeBinary, run } from '../media.ts';
import { createChromiumRasterizer } from './chromium.ts';
import type { ChromiumRasterizer } from './chromium.ts';

export const ANIMATED_SVG_PRESETS = {
  draft: { shortEdge: 360, fps: 15 },
  preview: { shortEdge: 480, fps: 24 },
  balanced: { shortEdge: 720, fps: 24 },
  professional: { shortEdge: 1080, fps: 30 },
  ultra: { shortEdge: 2160, fps: 30 },
} as const;

export type AnimatedRenderPreset = keyof typeof ANIMATED_SVG_PRESETS;
export type AnimatedSvgBackend = 'chromium' | 'resvg' | 'librsvg';
export type AnimatedSvgBackendPreference = AnimatedSvgBackend | 'auto';
type Rasterizer = ChromiumRasterizer & { backend: 'chromium' | 'resvg' };

/** Resolve deployment configuration without downloading or starting a browser. */
export function animatedSvgRenderPreference(override?: unknown): AnimatedSvgBackendPreference {
  const preference = override ?? process.env.WANDER_ANIMATION_RENDERER ?? 'auto';
  if (preference !== 'auto' && preference !== 'librsvg' && preference !== 'chromium' && preference !== 'resvg') {
    throw new EngineError('ANIMATION_RENDERER', 'Choose auto, chromium, resvg, or librsvg for animated SVG rendering.');
  }
  return preference;
}

/** A specifically requested backend must never silently reuse a different backend's output. */
export function animatedSvgRenderCacheMatches(cached: unknown, preferred: AnimatedSvgBackendPreference): boolean {
  return (cached === 'chromium' || cached === 'resvg' || cached === 'librsvg') && (preferred === 'auto' || preferred === cached);
}

export interface RasterOptions {
  outputPath: string;
  width: number;
  height: number;
  /** Must throw on any untrusted or unsupported SVG. Called for every frame, before rasterization. */
  assertSafeSvg: (svg: string) => unknown;
  ffprobeOverride?: string;
  /** Defaults to env WANDER_ANIMATION_RENDERER or auto (Chromium, then resvg if it cannot start). */
  backend?: AnimatedSvgBackendPreference;
  /** An installed sandbox-capable Chromium, or env WANDER_CHROMIUM. Default uses Playwright's browser. */
  chromiumExecutable?: string;
  onBackend?: (backend: AnimatedSvgBackend) => void;
  signal?: AbortSignal;
}

export interface AnimatedSvgRenderOptions extends RasterOptions {
  fps: number;
  durationSeconds: number;
  /** Deterministic, static SVG at t = frame index / fps. No native SVG animation or scripts. */
  frameAt: (seconds: number) => string;
  onProgress?: (progress: { stage: 'frames' | 'encoding' | 'verifying'; completed: number; total: number }) => void;
}

export interface AnimatedSvgRenderResult {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  backend: AnimatedSvgBackend;
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_SEQUENCE_BYTES = 512 * 1024 * 1024;
const MAX_PIXEL_FRAMES = 6_000_000_000;
const MAX_DURATION_SECONDS = 60;
const RENDER_TIMEOUT = 20 * 60_000;

function validateDimensions(width: number, height: number): void {
  if (![width, height].every((n) => Number.isInteger(n) && n >= 32 && n <= 3840 && n % 2 === 0)
    || width * height > 3840 * 2160) {
    throw new EngineError('ANIMATION_DIMENSIONS', 'Use even dimensions between 32 and 3840 pixels, up to 4K.');
  }
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('CANCELLED', 'Animated SVG render cancelled.');
}

function checkFrame(svg: string, validate: RasterOptions['assertSafeSvg']): number {
  if (typeof svg !== 'string') throw new EngineError('ANIMATION_FRAME', 'The renderer received a non-SVG frame.');
  const bytes = Buffer.byteLength(svg);
  if (bytes === 0 || bytes > MAX_FRAME_BYTES) throw new EngineError('ANIMATION_SIZE', 'One SVG frame exceeds the 2 MiB limit.');
  validate(svg);
  return bytes;
}

function createResvgRasterizer(options: RasterOptions, signal: AbortSignal): Rasterizer {
  return {
    backend: 'resvg',
    capture: async (svg) => {
      checkSignal(signal);
      const image = await renderAsync(svg);
      checkSignal(signal);
      if (image.width !== options.width || image.height !== options.height) {
        throw new EngineError('ANIMATION_FRAME', 'The rendered SVG frame has unexpected dimensions.');
      }
      return image.asPng();
    },
    close: async () => {},
  };
}

async function createRasterizer(options: RasterOptions, signal: AbortSignal): Promise<Rasterizer | undefined> {
  const preference = animatedSvgRenderPreference(options.backend);
  if (preference === 'librsvg') return undefined;
  if (preference === 'resvg') return createResvgRasterizer(options, signal);
  try {
    const rasterizer = await createChromiumRasterizer({
      width: options.width, height: options.height, executablePath: options.chromiumExecutable ?? process.env.WANDER_CHROMIUM, signal,
    });
    return { ...rasterizer, backend: 'chromium' };
  } catch (err) {
    if (preference === 'auto' && err instanceof EngineError && err.code === 'ANIMATION_CHROMIUM_UNAVAILABLE') return createResvgRasterizer(options, signal);
    throw err;
  }
}

function reportBackend(options: RasterOptions, rasterizer: Rasterizer | undefined): AnimatedSvgBackend {
  const backend = rasterizer?.backend ?? 'librsvg';
  try { options.onBackend?.(backend); } catch { /* Reporting cannot interrupt a render. */ }
  return backend;
}

function rasterArgs(width: number, height: number): string[] {
  // Render vector paths at the target resolution, not at the source SVG's intrinsic size.
  return ['-vcodec', 'librsvg', '-width', String(width), '-height', String(height), '-keep_ar', '1'];
}

function rasterFilter(width: number, height: number): string {
  return `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

function runEncoder(bin: string, args: string[], signal: AbortSignal, onFrame: (frame: number) => void, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd });
    let stderr = '';
    let stdout = '';
    let spawnError: Error | undefined;
    const kill = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    child.on('error', (err) => { spawnError = err; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = (lines.pop() ?? '').slice(-2048);
      for (const line of lines) {
        const match = /^frame=(\d+)\s*$/.exec(line);
        if (match) onFrame(Number(match[1]));
      }
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(new EngineError('CANCELLED', 'Animated SVG render cancelled or timed out.'));
      if (code !== 0 || spawnError) {
        const tail = (stderr.trim() || spawnError?.message || `exit ${code}`).split('\n').slice(-5).join(' | ');
        const unavailable = /unknown decoder|decoder.*not found/i.test(tail);
        return reject(new EngineError(unavailable ? 'ANIMATION_RENDERER_UNAVAILABLE' : 'ANIMATION_RENDER_FAILED',
          unavailable ? 'This FFmpeg build lacks the librsvg decoder required for animated SVG. Install an FFmpeg build with librsvg enabled.' : `${basename(bin)}: ${tail}`));
      }
      resolve();
    });
  });
}

async function validateEncoded(file: string, options: AnimatedSvgRenderOptions, frames: number, signal: AbortSignal): Promise<number> {
  const probe = await run(ffprobeBinary(options.ffprobeOverride),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeout: 30_000 });
  type Probe = {
    streams?: { codec_type: string; codec_name: string; width: number; height: number; nb_frames: string; avg_frame_rate: string; pix_fmt: string; sample_aspect_ratio: string }[];
    format?: { format_name: string; duration: string };
  };
  let parsed: Probe;
  try { parsed = JSON.parse(probe.stdout) as Probe; }
  catch { throw new EngineError('ANIMATION_VIDEO_INVALID', 'The encoded clip could not be verified as an MP4.'); }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams[0];
  const [num, den] = (video?.avg_frame_rate ?? '').split('/').map(Number);
  const duration = Number(parsed?.format?.duration);
  const expected = frames / options.fps;
  if (!video || streams.length !== 1 || !parsed?.format?.format_name?.split(',').includes('mp4')
    || video.codec_type !== 'video' || video.codec_name !== 'h264' || video.width !== options.width || video.height !== options.height || video.sample_aspect_ratio !== '1:1'
    || video.pix_fmt !== 'yuv420p' || Number(video.nb_frames) !== frames || num / den !== options.fps || !Number.isFinite(duration)
    || Math.abs(duration - expected) > 0.002) {
    throw new EngineError('ANIMATION_VIDEO_INVALID', 'The encoded clip did not match the requested dimensions, timing or H.264 format.');
  }
  return duration;
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

async function validatePng(file: string, width: number, height: number): Promise<void> {
  const handle = await open(file);
  try {
    const bytes = Buffer.alloc(24);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || !bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)
      || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
      throw new EngineError('ANIMATION_FRAME', 'The rendered preview is not a PNG with the requested dimensions.');
    }
  } finally { await handle.close(); }
}

/**
 * Rasterize validated SVG frames with sandboxed Chromium, resvg, or FFmpeg/librsvg and encode one silent H.264 clip.
 * Each isolated frame is resolved from exact timestamps; no frame executes generated JS or SMIL.
 * The validation callback must reject external resource references before calling this library.
 */
export async function renderAnimatedSvg(options: AnimatedSvgRenderOptions): Promise<AnimatedSvgRenderResult> {
  const { width, height, fps, durationSeconds } = options;
  validateDimensions(width, height);
  if (![15, 24, 30, 60].includes(fps) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new EngineError('ANIMATION_TIMING', 'Use 15, 24, 30, or 60 FPS and a scene duration of up to 60 seconds.');
  }
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  if (width * height * frames > MAX_PIXEL_FRAMES) {
    throw new EngineError('ANIMATION_BUDGET', 'This scene exceeds the CPU rendering budget. Shorten it or choose a lower resolution or frame rate.');
  }
  const signal = AbortSignal.any([AbortSignal.timeout(RENDER_TIMEOUT), ...(options.signal ? [options.signal] : [])]);
  checkSignal(signal);
  const outputPath = resolve(options.outputPath);
  if (!/\.mp4$/i.test(outputPath)) throw new EngineError('ANIMATION_OUTPUT', 'Export a scene to an .mp4 file.');
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  const work = await mkdtemp(join(outputDir, '.wander-svg-'));
  const notify = (stage: 'frames' | 'encoding' | 'verifying', completed: number) => {
    // A UI listener is observational and must not break a local render job.
    try { options.onProgress?.({ stage, completed, total: frames }); } catch { /* ignore listener errors */ }
  };
  let rasterizer: Rasterizer | undefined;
  try {
    rasterizer = await createRasterizer(options, signal);
    const backend = reportBackend(options, rasterizer);
    const extension = rasterizer ? 'png' : 'svg';
    let bytes = 0;
    notify('frames', 0);
    for (let i = 0; i < frames; i++) {
      checkSignal(signal);
      const svg = options.frameAt(i / fps);
      checkFrame(svg, options.assertSafeSvg);
      const data = rasterizer ? await rasterizer.capture(svg) : svg;
      bytes += Buffer.byteLength(data);
      if (bytes > MAX_SEQUENCE_BYTES) {
        throw new EngineError('ANIMATION_BUDGET', 'Generated frames exceed the 512 MiB temporary-storage budget.');
      }
      await writeFile(join(work, `frame_${String(i).padStart(6, '0')}.${extension}`), data, { mode: 0o600 });
      notify('frames', i + 1);
    }
    await rasterizer?.close();
    const temp = join(work, 'encoded.mp4');
    notify('encoding', 0);
    await runEncoder(ffmpegBinary(options.ffprobeOverride), [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-filter_threads', '1',
      '-protocol_whitelist', 'file,pipe', '-f', 'image2', '-framerate', String(fps), '-start_number', '0',
      ...(backend === 'librsvg' ? rasterArgs(width, height) : []),
      '-i', `frame_%06d.${extension}`, '-frames:v', String(frames),
      '-vf', `${rasterFilter(width, height)},format=yuv420p`,
      '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
      '-movflags', '+faststart', temp,
    ], signal, (frame) => notify('encoding', Math.min(frames, frame)), work);
    checkSignal(signal);
    notify('verifying', frames);
    const verifiedDuration = await validateEncoded(temp, options, frames, signal);
    checkSignal(signal);
    await rename(temp, outputPath);
    return { outputPath, width, height, fps, frames, durationSeconds: verifiedDuration, backend };
  } finally {
    await rasterizer?.close();
    await rm(work, { recursive: true, force: true });
  }
}

/** Use the same vector rasterizer and scaling as MP4 export for storyboard thumbnails. */
export async function renderAnimatedSvgFrame(options: RasterOptions & { svg: string }): Promise<string> {
  const { svg, width, height } = options;
  checkSignal(options.signal);
  validateDimensions(width, height);
  checkFrame(svg, options.assertSafeSvg);
  const outputPath = resolve(options.outputPath);
  if (!/\.png$/i.test(outputPath)) throw new EngineError('ANIMATION_OUTPUT', 'Export a frame to a .png file.');
  await mkdir(dirname(outputPath), { recursive: true });
  const work = await mkdtemp(join(dirname(outputPath), '.wander-svg-'));
  let rasterizer: Rasterizer | undefined;
  try {
    const output = join(work, 'frame.png');
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
    rasterizer = await createRasterizer(options, signal);
    reportBackend(options, rasterizer);
    if (rasterizer) {
      await writeFile(output, await rasterizer.capture(svg), { mode: 0o600 });
    } else {
      const input = join(work, 'frame.svg');
      await writeFile(input, svg, { encoding: 'utf8', mode: 0o600 });
      await runEncoder(ffmpegBinary(options.ffprobeOverride), [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe',
        ...rasterArgs(width, height), '-i', input, '-frames:v', '1',
        '-vf', `${rasterFilter(width, height)},format=rgb24`, '-c:v', 'png', '-threads', '1', '-update', '1', output,
      ], signal, () => {}, work);
    }
    await validatePng(output, width, height);
    checkSignal(signal);
    await rename(output, outputPath);
    return outputPath;
  } finally {
    await rasterizer?.close();
    await rm(work, { recursive: true, force: true });
  }
}
