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
