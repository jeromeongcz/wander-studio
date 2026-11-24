#!/usr/bin/env node
// Wander AI Director preflight: read-only environment check. Installs and downloads nothing.
import { execSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

const run = (c) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const results = [];
// Prefer an ffmpeg with libass: FFMPEG_DIR env, then Homebrew ffmpeg-full (keg-only), then PATH.
const candidates = [process.env.FFMPEG_DIR, '/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin'].filter((d) => d && fs.existsSync(d + '/ffmpeg'));
const FF = candidates[0] ? candidates[0] + '/ffmpeg' : 'ffmpeg';
const FP = candidates[0] ? candidates[0] + '/ffprobe' : 'ffprobe';
const check = (name, level, ok, detail, fix) => results.push({ name, level, ok, detail, fix });

const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node >= 22', 'required', nodeMajor >= 22, process.version, 'brew install node');
check('FFmpeg', 'required', !!run(`command -v ${FF}`), run(`${FF} -version | head -1`) ?? 'not found', 'brew install ffmpeg');
check('ffprobe', 'required', !!run(`command -v ${FP}`), run(`${FP} -version | head -1`) ?? 'not found', 'installed with ffmpeg');
const ffFilters = run(`${FF} -hide_banner -filters 2>/dev/null`);
check('FFmpeg subtitles/libass', 'required', !!ffFilters && /^\s*\S+\s+(subtitles|ass)\s/m.test(ffFilters), ffFilters ? `subtitles/ass present (${FF})` : 'ffmpeg missing', 'use a ffmpeg build with libass');

const ramGB = os.totalmem() / 2 ** 30;
check('RAM >= 8GB', 'required', ramGB >= 8, `${ramGB.toFixed(1)} GB`, '');
const df = run(`df -k "${process.cwd()}" | tail -1`);
const freeGB = df ? Number(df.split(/\s+/)[3]) / 1048576 : 0;
check('Free disk >= 20GB', 'required', freeGB >= 20, `${freeGB.toFixed(0)} GB free`, '');

const fonts = [os.homedir() + '/Library/Fonts', '/Library/Fonts', '/System/Library/Fonts', './templates/fonts']
  .flatMap((d) => { try { return fs.readdirSync(d); } catch { return []; } })
  .filter((f) => /\.(ttf|otf|ttc)$/i.test(f));
check('Caption-capable fonts', 'required', fonts.length > 0, `${fonts.length} font files visible`, 'bundle OFL fonts in templates/fonts');

check('Piper TTS', 'optional', !!run('command -v piper'), run('command -v piper') ?? 'not found', 'optional offline TTS');
check('whisper.cpp', 'optional', !!(run('command -v whisper-cli') || run('command -v whisper-cpp')), (run('command -v whisper-cli') ?? run('command -v whisper-cpp') ?? 'not found'), 'optional alignment; model download needs confirmation');
check('Ollama', 'optional', !!run('command -v ollama'), run('command -v ollama') ?? 'not found', 'optional local LLM; manual copy-paste mode otherwise');
const gpu = run('system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model"');
check('GPU (informational)', 'optional', true, gpu ?? 'unknown', 'local image/video generation stays optional');

let failed = 0;
for (const r of results) {
  const mark = r.ok ? 'OK  ' : r.level === 'required' ? 'FAIL' : 'skip';
  if (!r.ok && r.level === 'required') failed++;
  console.log(`[${mark}] ${r.name.padEnd(28)} ${r.detail}${!r.ok && r.fix ? `  -> ${r.fix}` : ''}`);
}
process.exit(failed ? 1 : 0);
