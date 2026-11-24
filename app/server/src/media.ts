import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { EngineError } from './engine.ts';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};
export const EXT_FOR_MIME: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

export function ffprobeBinary(override?: string): string {
  if (override) return override;
  if (process.env.WANDER_FFPROBE) return process.env.WANDER_FFPROBE;
  for (const p of ['/opt/homebrew/opt/ffmpeg-full/bin/ffprobe', '/usr/local/opt/ffmpeg-full/bin/ffprobe']) if (existsSync(p)) return p;
  return 'ffprobe';
}

export function ffmpegBinary(ffprobeOverride?: string): string {
  const probe = ffprobeBinary(ffprobeOverride);
  return probe.includes('/') ? probe.replace(/ffprobe$/, 'ffmpeg') : 'ffmpeg';
}

/** Run a binary without a shell. Resolves with stdout/stderr; rejects with a short, human-readable message. */
export function run(bin: string, args: string[], opts: { timeout?: number; input?: string; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: opts.timeout ?? 120_000, maxBuffer: 64 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      if (err) {
        if (opts.signal?.aborted) return reject(new EngineError('CANCELLED', 'Cancelled'));
        const tail = String(stderr || err.message).trim().split('\n').slice(-4).join(' | ');
        return reject(new EngineError('TOOL_FAILED', `${bin.split('/').pop()} failed: ${tail}`));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif']);

export interface AudioProbe {
  duration: number;
  sampleRate: number;
  channels: number;
}

/** Verify a file contains decodable audio and measure its true duration. */
export async function probeAudio(file: string, bin: string): Promise<AudioProbe> {
  let out: string;
  try {
    out = (await run(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30_000 })).stdout;
  } catch {
    throw new EngineError('MEDIA_INVALID', 'File is not valid audio (ffprobe could not read it)');
  }
  const j = JSON.parse(out) as { streams?: { codec_type: string; sample_rate?: string; channels?: number; duration?: string }[]; format?: { duration?: string } };
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(j.format?.duration ?? a?.duration ?? 0);
  if (!a || !(duration > 0)) throw new EngineError('MEDIA_INVALID', 'No decodable audio stream with a measurable duration');
  return { duration, sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 };
}

export interface Silence {
  start: number;
  end: number;
}

/** Find silent stretches using ffmpeg's silencedetect; used to anchor sentence boundaries. */
export async function detectSilences(file: string, ffmpeg: string, noiseDb = -35, minSeconds = 0.12): Promise<Silence[]> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, '-f', 'null', '-'], { timeout: 60_000 });
  return parseSilence(stderr);
}

export function parseSilence(log: string): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: Infinity }); // silence running to end of file
  return out;
}

export interface Probe {
  kind: 'image' | 'video';
  width: number;
  height: number;
  duration?: number;
}

/** Verify a file is real, decodable media using ffprobe (never trust an extension). No shell involved. */
export function probeMedia(file: string, bin: string): Promise<Probe> {
  const ext = extname(file).toLowerCase();
  const expectVideo = VIDEO_EXT.has(ext);
  return new Promise((resolve, reject) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new EngineError('MEDIA_INVALID', 'File is not valid media (ffprobe could not read it)'));
      try {
        const j = JSON.parse(stdout) as { streams?: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string } };
        const v = j.streams?.find((s) => s.codec_type === 'video');
        if (!v || !v.width || !v.height) return reject(new EngineError('MEDIA_INVALID', 'No decodable image or video stream found'));
        const duration = j.format?.duration ? Number(j.format.duration) : undefined;
        if (expectVideo && !(duration && duration > 0)) return reject(new EngineError('MEDIA_INVALID', 'Video has no measurable duration'));
        resolve({ kind: expectVideo ? 'video' : 'image', width: v.width, height: v.height, duration: expectVideo ? duration : undefined });
      } catch {
        reject(new EngineError('MEDIA_INVALID', 'Unreadable ffprobe output'));
      }
    });
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
