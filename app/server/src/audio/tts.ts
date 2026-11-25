import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import { ffmpegBinary, run } from '../media.ts';

export interface TtsVoice {
  id: string;
  name: string;
  locale?: string;
}

export interface TtsTerms {
  online: boolean;
  freeTier: string;
  requiresKey: boolean;
  commercialUse: string;
  privacy: string;
  termsUrl?: string;
}

export interface TtsProvider {
  id: string;
  name: string;
  terms: TtsTerms;
  /** Honest capability note shown in the UI, e.g. which languages are actually supported. */
  languages: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  voices(): Promise<TtsVoice[]>;
  /** Write a 44.1kHz mono PCM WAV to outWav. */
  synthesize(args: { text: string; voice: string; rate?: number; outWav: string }): Promise<void>;
}

export interface TtsConfig {
  ffmpeg?: string;
  /** Override binary locations (tests point these at stubs). */
  sayBin?: string;
  piper?: { bin?: string; models?: Record<string, string> };
  edge?: { bin?: string };
}

async function toWav(ffmpeg: string, input: string, out: string) {
  await run(ffmpeg, ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out], { timeout: 60_000 });
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'wander-tts-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tools installed with uv/pipx/Homebrew are often not on the server's PATH, so look in the usual places first. */
export function resolveBin(name: string, override?: string): string {
  if (override) return override;
  for (const dir of [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) if (existsSync(join(dir, name))) return join(dir, name);
  return name;
}

const which = async (bin: string) => {
  try {
    await run('/usr/bin/which', [bin], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export function macosSay(cfg: TtsConfig): TtsProvider {
  const bin = cfg.sayBin ?? 'say';
  const ffmpeg = ffmpegBinary(cfg.ffmpeg);
  return {
    id: 'macos-say',
    name: 'macOS built-in voices (say)',
    languages: 'Whatever voices are installed; check the list. Stock macOS has English voices but no Filipino voice.',
    terms: { online: false, freeTier: 'Free, offline, no key', requiresKey: false, commercialUse: 'Unclear: Apple does not state commercial terms for generated speech. Verify before monetizing.', privacy: 'Runs fully on this Mac' },
    async available() {
      if (process.platform !== 'darwin' && !cfg.sayBin) return { ok: false, detail: 'Only available on macOS' };
      return (await which(bin)) || existsSync(bin) ? { ok: true, detail: 'say found' } : { ok: false, detail: 'say not found' };
    },
    async voices() {
      const { stdout } = await run(bin, ['-v', '?'], { timeout: 15_000 });
      return stdout.split('\n').flatMap((l) => {
        const m = l.match(/^(.+?)\s{2,}([a-z]{2,3}_[A-Z0-9]+)\s/);
        return m ? [{ id: m[1].trim(), name: m[1].trim(), locale: m[2] }] : [];
      });
    },
    async synthesize({ text, voice, rate, outWav }) {
      await withTmp(async (dir) => {
        const aiff = join(dir, 'out.aiff');
        const args = ['-v', voice, '-o', aiff];
        if (rate) args.push('-r', String(Math.round(rate)));
        args.push('-f', '-'); // text on stdin: no shell, no argument-length or leading-dash surprises
        await run(bin, args, { input: text, timeout: 120_000 });
        await toWav(ffmpeg, aiff, outWav);
      });
    },
  };
}

export function piper(cfg: TtsConfig): TtsProvider {
  const bin = cfg.piper?.bin ?? 'piper';
  const models = cfg.piper?.models ?? {};
  const ffmpeg = ffmpegBinary(cfg.ffmpeg);
  return {
    id: 'piper',
    name: 'Piper (offline neural TTS)',
    languages: 'Depends on the voice models YOU provide. No model is downloaded automatically.',
    terms: { online: false, freeTier: 'Free, offline, no key', requiresKey: false, commercialUse: 'Per voice model license; read each model card before commercial use.', privacy: 'Runs fully on this Mac', termsUrl: 'https://github.com/rhasspy/piper' },
    async available() {
      if (!(existsSync(bin) || (await which(bin)))) return { ok: false, detail: 'piper binary not found' };
      return Object.keys(models).length ? { ok: true, detail: `models configured for: ${Object.keys(models).join(', ')}` } : { ok: false, detail: 'piper found but no voice models configured' };
    },
    async voices() {
      return Object.entries(models).map(([id, path]) => ({ id, name: id, locale: path }));
    },
    async synthesize({ text, voice, outWav }) {
      const model = models[voice];
      if (!model || !existsSync(model)) throw new EngineError('PROVIDER_ERROR', `No Piper model configured for voice "${voice}"`);
      await withTmp(async (dir) => {
        const raw = join(dir, 'out.wav');
        await run(bin, ['--model', model, '--output_file', raw], { input: text, timeout: 180_000 });
        await toWav(ffmpeg, raw, outWav);
      });
    },
  };
}

const EDGE_SUGGESTED: TtsVoice[] = [
  { id: 'fil-PH-BlessicaNeural', name: 'Blessica (Filipino, female)', locale: 'fil-PH' },
  { id: 'fil-PH-AngeloNeural', name: 'Angelo (Filipino, male)', locale: 'fil-PH' },
  { id: 'en-PH-RosaNeural', name: 'Rosa (Philippine English, female)', locale: 'en-PH' },
  { id: 'en-PH-JamesNeural', name: 'James (Philippine English, male)', locale: 'en-PH' },
  { id: 'en-US-AriaNeural', name: 'Aria (US English, female)', locale: 'en-US' },
];

/** Parse `edge-tts --list-voices` (a text table) into voices. Exported for tests. */
export function parseEdgeVoices(table: string): TtsVoice[] {
  const out: TtsVoice[] = [];
  for (const line of table.split('\n')) {
    const m = line.match(/^(([a-z]{2,3}-[A-Za-z]{2,4})-(\w+?)Neural)\s+(Male|Female)\b/);
    if (m) out.push({ id: m[1], name: `${m[3]} (${m[4].toLowerCase()})`, locale: m[2] });
  }
  return out;
}

export function edgeTts(cfg: TtsConfig): TtsProvider {
  const bin = resolveBin('edge-tts', cfg.edge?.bin);
  const ffmpeg = ffmpegBinary(cfg.ffmpeg);
  let cache: { at: number; voices: TtsVoice[] } | null = null;
  return {
    id: 'edge-tts',
    name: 'Microsoft Edge TTS (online, via edge-tts CLI)',
    languages: 'Strong Filipino (fil-PH) and Philippine English (en-PH) voices, plus 300+ others. Needs internet.',
    terms: {
      online: true,
      freeTier: 'Free, no key, but an unofficial endpoint that can change or be rate-limited without notice',
      requiresKey: false,
      commercialUse: 'Not an official public API; Microsoft terms apply. Verify before commercial use.',
      privacy: 'The text you synthesize is sent to Microsoft servers.',
    },
    async available() {
      return existsSync(bin) || (await which(bin)) ? { ok: true, detail: `edge-tts CLI found (${bin}); network still required` } : { ok: false, detail: 'edge-tts CLI not installed (uv tool install edge-tts)' };
    },
    async voices() {
      if (cache && Date.now() - cache.at < 10 * 60_000) return cache.voices;
      try {
        // Only fetches Microsoft's public voice catalogue; none of your text is sent.
        const v = parseEdgeVoices((await run(bin, ['--list-voices'], { timeout: 30_000 })).stdout);
        if (v.length) {
          cache = { at: Date.now(), voices: v };
          return v;
        }
      } catch {
        /* offline or not installed: fall back to the voices we know exist */
      }
      return EDGE_SUGGESTED;
    },
    async synthesize({ text, voice, rate, outWav }) {
      if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/.test(voice)) throw new EngineError('VALIDATION', 'Edge voice ids look like fil-PH-BlessicaNeural');
      await withTmp(async (dir) => {
        const textFile = join(dir, 'in.txt');
        const mp3 = join(dir, 'out.mp3');
        await writeFile(textFile, text, 'utf8');
        const pct = rate ? Math.max(-50, Math.min(100, Math.round((rate / 175 - 1) * 100))) : 0; // rate given as words/min, 175 ~ neutral
        try {
          await run(bin, ['--voice', voice, `--rate=${pct >= 0 ? '+' : ''}${pct}%`, '--file', textFile, '--write-media', mp3, '--no-progress'], { timeout: 180_000 });
        } catch (e) {
          throw new EngineError('PROVIDER_ERROR', `Edge TTS could not produce audio (check your internet connection): ${(e as Error).message}`);
        }
        await toWav(ffmpeg, mp3, outWav);
      });
    },
  };
}

export class TtsRegistry {
  private map = new Map<string, TtsProvider>();
  constructor(cfg: TtsConfig = {}) {
    for (const p of [macosSay(cfg), piper(cfg), edgeTts(cfg)]) this.map.set(p.id, p);
  }
  list() {
    return [...this.map.values()];
  }
  get(id: string): TtsProvider {
    const p = this.map.get(id);
    if (!p) throw new EngineError('NOT_FOUND', `Unknown TTS provider ${id}`);
    return p;
  }
}
