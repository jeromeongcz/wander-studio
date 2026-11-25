import { findTool } from '../platform.ts';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import { run } from '../media.ts';
import type { AsrWord } from './align.ts';

/** Known whisper.cpp model sizes, shown BEFORE any download. Nothing is ever downloaded automatically. */
export const WHISPER_MODELS = [
  { file: 'ggml-tiny.bin', sizeMB: 75, ramMB: 390, note: 'Fastest, least accurate. Fine for timestamps only.' },
  { file: 'ggml-base.bin', sizeMB: 142, ramMB: 500, note: 'Good balance for timestamp alignment.' },
  { file: 'ggml-small.bin', sizeMB: 466, ramMB: 1000, note: 'Better for Tagalog/Taglish; slower.' },
].map((m) => ({ ...m, license: 'MIT (OpenAI Whisper weights, converted for whisper.cpp)', source: 'https://huggingface.co/ggerganov/whisper.cpp' }));

export function whisperStatus(cfg?: { bin?: string; model?: string }) {
  const bin = cfg?.bin ?? findTool('whisper-cli');
  return {
    binary: existsSync(bin) ? bin : null,
    model: cfg?.model && existsSync(cfg.model) ? cfg.model : null,
    ready: existsSync(bin) && !!cfg?.model && existsSync(cfg.model),
    models: WHISPER_MODELS,
    note: 'Alignment uses whisper only for timestamps; caption spelling always stays anchored to your approved script. Download a model yourself after reviewing size and license, then set its path.',
  };
}

/** Parse whisper.cpp `-oj` JSON (one token per entry when run with -ml 1 -sow) into word timings. */
export function parseWhisperJson(json: string): AsrWord[] {
  const j = JSON.parse(json) as { transcription?: { offsets?: { from: number; to: number }; text?: string }[] };
  return (j.transcription ?? []).flatMap((t) => {
    const word = (t.text ?? '').trim();
    if (!word || /^\[.*\]$/.test(word) || !t.offsets) return [];
    return [{ word, start: t.offsets.from / 1000, end: t.offsets.to / 1000 }];
  });
}

export async function runWhisper(args: { ffmpeg: string; bin: string; model: string; clip: string; lang: string }): Promise<AsrWord[]> {
  const dir = await mkdtemp(join(tmpdir(), 'wander-whisper-'));
  try {
    const wav = join(dir, 'in.wav');
    await run(args.ffmpeg, ['-v', 'error', '-y', '-i', args.clip, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeout: 60_000 });
    const prefix = join(dir, 'out');
    const language = args.lang === 'tl' || args.lang === 'taglish' ? 'tl' : args.lang === 'en' ? 'en' : 'auto';
    await run(args.bin, ['-m', args.model, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', prefix, '-l', language], { timeout: 600_000 });
    return parseWhisperJson(await readFile(`${prefix}.json`, 'utf8'));
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('TOOL_FAILED', `whisper alignment failed: ${(e as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
