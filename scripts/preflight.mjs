#!/usr/bin/env node
// Wander AI Director preflight: read-only environment check for macOS, Windows and Linux. Installs and downloads nothing.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { join } from 'node:path';
import { NODE_REQUIREMENT, requireSupportedNode } from './runtime.mjs';

// Check Node in plain JS before loading an app module written in TypeScript.
if (!requireSupportedNode()) process.exit(1);
const { ffmpegBinary, ffprobeBinary } = await import('../app/server/src/media.ts');
const { findTool, pathLookup, systemFontDirs } = await import('../app/server/src/platform.ts');

const run = (bin, args) => { try { return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).toString().trim(); } catch { return null; } };
const where = (name) => { const found = findTool(name); return found !== name ? found : (run(pathLookup(), [name])?.split(/\r?\n/)[0] ?? null); };
const results = [];
const check = (name, level, ok, detail, fix) => results.push({ name, level, ok, detail, fix });
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const installFfmpeg = win ? 'winget install Gyan.FFmpeg' : mac ? 'brew install ffmpeg-full' : 'install ffmpeg with libass and librsvg';

check(NODE_REQUIREMENT, 'required', true, process.version, win ? 'winget install OpenJS.NodeJS.LTS' : 'brew install node');
const FF = ffmpegBinary();
const version = run(FF, ['-version'])?.split(/\r?\n/)[0];
check('FFmpeg', 'required', !!version, version ?? 'not found', installFfmpeg);
check('ffprobe', 'required', !!run(ffprobeBinary(), ['-version']), run(ffprobeBinary(), ['-version']) ? 'found' : 'not found', 'installed with FFmpeg');
const filters = run(FF, ['-hide_banner', '-filters']) ?? '';
const ass = /^\s*\S+\s+(subtitles|ass)\s/m.test(filters);
check('FFmpeg subtitles/libass', 'required', ass, ass ? 'present' : 'missing', installFfmpeg);
if (!mac) {
  const svg = /\b(lib)?rsvg\b/.test(run(FF, ['-hide_banner', '-decoders']) ?? '') || !!run('rsvg-convert', ['--version']);
  check('SVG support (pictures)', 'optional', svg, svg ? 'available' : 'not found', 'storyboard pictures need FFmpeg with librsvg, or rsvg-convert');
}

const ramGB = os.totalmem() / 2 ** 30;
check('RAM >= 8GB', 'required', ramGB >= 7.5, `${ramGB.toFixed(1)} GB`, '');
const disk = fs.statfsSync(process.cwd());
const freeGB = (disk.bavail * disk.bsize) / 2 ** 30;
check('Free disk >= 20GB', 'required', freeGB >= 20, `${freeGB.toFixed(0)} GB free`, '');

const fonts = [...systemFontDirs(), ...(mac ? ['/System/Library/Fonts'] : []), join('templates', 'fonts')]
  .flatMap((d) => { try { return fs.readdirSync(d, { recursive: !mac && !win }); } catch { return []; } })
  .filter((f) => /\.(ttf|otf|ttc)$/i.test(f));
check('Caption-capable fonts', 'required', fonts.length > 0, `${fonts.length} font files visible`, 'add .ttf files to templates/fonts');

check('Claude Code', 'optional', !!where('claude'), where('claude') ?? 'not found', 'needed for research, scripts and pictures');
check('Edge TTS', 'optional', !!where('edge-tts'), where('edge-tts') ?? 'not found', 'pipx install edge-tts');
check('Piper TTS', 'optional', !!where('piper'), where('piper') ?? 'not found', 'optional offline TTS');
check('whisper.cpp', 'optional', !!where('whisper-cli'), where('whisper-cli') ?? 'not found', 'optional alignment; model download needs confirmation');

let failed = 0;
for (const r of results) {
  const mark = r.ok ? 'OK  ' : r.level === 'required' ? 'FAIL' : 'skip';
  if (!r.ok && r.level === 'required') failed++;
  console.log(`[${mark}] ${r.name.padEnd(28)} ${r.detail}${!r.ok && r.fix ? `  -> ${r.fix}` : ''}`);
}
process.exit(failed ? 1 : 0);
