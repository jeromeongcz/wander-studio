import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface AppConfig {
  /** Application root: holds projects/, shared_assets/ and cache/. */
  root: string;
  /** Override ffprobe binary (default: Homebrew ffmpeg-full, then PATH). */
  ffprobePath?: string;
  /** Injectable fetch for provider calls (tests mock this; production uses global fetch). */
  fetchFn?: typeof fetch;
  maxImportBytes: number;
  maxRemoteBytes: number;
}

export function defaultRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function resolveConfig(c: Partial<AppConfig> = {}): AppConfig {
  return { root: c.root ?? defaultRoot(), ffprobePath: c.ffprobePath, fetchFn: c.fetchFn, maxImportBytes: c.maxImportBytes ?? 2 * 1024 ** 3, maxRemoteBytes: c.maxRemoteBytes ?? 25 * 1024 ** 2 };
}
