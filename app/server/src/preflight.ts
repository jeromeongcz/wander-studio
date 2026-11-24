import { statfs } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { EngineError } from './engine.ts';
import type { AppConfig } from './config.ts';
import { ffmpegBinary, ffprobeBinary, run } from './media.ts';

export interface Check {
  name: string;
  level: 'required' | 'optional';
  ok: boolean;
  detail: string;
  fix?: string;
}

const NEED_FILTERS = ['ass', 'subtitles', 'zoompan', 'xfade', 'sidechaincompress', 'silencedetect', 'adelay', 'amix'];
let gpuCache: string | null | undefined;

async function gpuInfo(): Promise<string | null> {
  if (gpuCache !== undefined) return gpuCache;
  if (process.platform !== 'darwin') return (gpuCache = null);
  try {
    const { stdout } = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType'], { timeout: 15_000 });
    gpuCache = stdout.match(/Chipset Model:\s*(.+)/)?.[1]?.trim() ?? null;
  } catch {
    gpuCache = null;
  }
  return gpuCache;
}

/** Read-only environment check. Never installs or downloads anything. */
export async function runPreflight(config: AppConfig, opts: { needBytes?: number; fontsOk?: () => { ok: boolean; detail: string } } = {}): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const ff = ffmpegBinary(config.ffprobePath);
  const fp = ffprobeBinary(config.ffprobePath);
  let version = '';
  try {
    version = (await run(ff, ['-version'], { timeout: 10_000 })).stdout.split('\n')[0];
    add({ name: 'FFmpeg', level: 'required', ok: true, detail: version });
  } catch {
    add({ name: 'FFmpeg', level: 'required', ok: false, detail: 'not found', fix: 'brew install ffmpeg-full' });
  }
  try {
    await run(fp, ['-version'], { timeout: 10_000 });
    add({ name: 'ffprobe', level: 'required', ok: true, detail: 'found' });
  } catch {
    add({ name: 'ffprobe', level: 'required', ok: false, detail: 'not found', fix: 'installed with ffmpeg' });
  }
  if (version) {
    const filters = (await run(ff, ['-hide_banner', '-filters'], { timeout: 15_000 }).catch(() => ({ stdout: '' }))).stdout;
    const missing = NEED_FILTERS.filter((f) => !new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(filters));
    add({ name: 'FFmpeg filters', level: 'required', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all required filters present', fix: missing.length ? 'use ffmpeg-full (needs libass)' : undefined });
    const enc = (await run(ff, ['-hide_banner', '-encoders'], { timeout: 15_000 }).catch(() => ({ stdout: '' }))).stdout;
    const hasX264 = /\blibx264\b/.test(enc);
    const hasAac = /\baac\b/.test(enc);
    add({ name: 'Encoders (H.264 + AAC)', level: 'required', ok: hasX264 && hasAac, detail: `libx264 ${hasX264 ? 'yes' : 'NO'}, aac ${hasAac ? 'yes' : 'NO'}`, fix: !hasX264 || !hasAac ? 'use an FFmpeg build with libx264' : undefined });
  }
  try {
    await mkdir(config.root, { recursive: true });
    const s = await statfs(config.root);
    const free = Number(s.bavail) * Number(s.bsize);
    const need = opts.needBytes ?? 2 * 1024 ** 3;
    add({ name: 'Disk space', level: 'required', ok: free >= need, detail: `${(free / 1024 ** 3).toFixed(1)} GB free, ${(need / 1024 ** 3).toFixed(1)} GB needed`, fix: free < need ? 'free disk space or prune the cache (POST /cache/prune)' : undefined });
  } catch (e) {
    add({ name: 'Disk space', level: 'required', ok: false, detail: `could not read disk space: ${(e as Error).message}` });
  }
  const totalGB = totalmem() / 1024 ** 3;
  add({ name: 'Memory', level: 'required', ok: totalGB >= 4, detail: `${totalGB.toFixed(1)} GB total, ${(freemem() / 1024 ** 3).toFixed(1)} GB currently free`, fix: totalGB < 4 ? 'rendering needs at least 4 GB of RAM' : undefined });
  if (opts.fontsOk) {
    const f = opts.fontsOk();
    add({ name: 'Caption font', level: 'required', ok: f.ok, detail: f.detail, fix: f.ok ? undefined : 'add an open-licensed .ttf to templates/fonts' });
  }
  const gpu = await gpuInfo();
  add({ name: 'GPU (informational)', level: 'optional', ok: true, detail: gpu ?? 'not detected', fix: 'Local AI image/video generation stays optional; nothing here needs a GPU' });
  return { ok: checks.every((c) => c.ok || c.level === 'optional'), checks };
}

/** Throws EngineError('PREFLIGHT') with readable diagnostics if a heavy job cannot run safely. */
export async function requireHealthy(config: AppConfig, opts: Parameters<typeof runPreflight>[1] = {}) {
  const r = await runPreflight(config, opts);
  if (!r.ok) {
    const bad = r.checks.filter((c) => !c.ok && c.level === 'required');
    throw new EngineError('PREFLIGHT', `Environment check failed: ${bad.map((b) => `${b.name} (${b.detail})`).join('; ')}`, bad);
  }
  return r;
}
