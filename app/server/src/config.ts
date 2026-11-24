import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TtsConfig } from './audio/tts.ts';

export interface AppConfig {
  /** Application root: holds projects/, shared_assets/ and cache/. */
  root: string;
  /** Override ffprobe binary (default: Homebrew ffmpeg-full, then PATH). */
  ffprobePath?: string;
  /** Injectable fetch for provider calls (tests mock this; production uses global fetch). */
  fetchFn?: typeof fetch;
  /** TTS binary overrides (Piper models, edge-tts path). Nothing is downloaded automatically. */
  tts?: Omit<TtsConfig, 'ffmpeg'>;
  /** Optional whisper.cpp alignment: binary and a model file YOU downloaded. */
  whisper?: { bin?: string; model?: string };
  /** Directories scanned for caption fonts (TTF/OTF). */
  fontDirs?: string[];
  maxImportBytes: number;
  maxRemoteBytes: number;
}

export function defaultRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function resolveConfig(c: Partial<AppConfig> = {}): AppConfig {
  return { root: c.root ?? defaultRoot(), ffprobePath: c.ffprobePath, fetchFn: c.fetchFn, tts: c.tts, whisper: c.whisper, fontDirs: c.fontDirs, maxImportBytes: c.maxImportBytes ?? 2 * 1024 ** 3, maxRemoteBytes: c.maxRemoteBytes ?? 25 * 1024 ** 2 };
}
