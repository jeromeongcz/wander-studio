import { EngineError } from '../engine.ts';

export interface MixSpec {
  narration_gain_db?: number;
  music?: { clip_id: string; start?: number; gain_db?: number; fade_in?: number; fade_out?: number; loop?: boolean }[];
  sfx?: { clip_id: string; at: number; gain_db?: number }[];
  ducking?: { enabled: boolean; amount?: number; release_ms?: number };
}

export interface MixInput {
  path: string;
  start?: number; // seconds on the timeline (narration chunks and sfx)
}

const bad = (m: string) => new EngineError('VALIDATION', m);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateMixShape(m: unknown): MixSpec {
  if (m === undefined) return {};
  if (!isObj(m)) throw bad('mix must be an object');
  const num = (k: string, v: unknown, lo: number, hi: number) => {
    if (v !== undefined && (typeof v !== 'number' || !(v >= lo && v <= hi))) throw bad(`${k} must be a number between ${lo} and ${hi}`);
  };
  num('mix.narration_gain_db', m.narration_gain_db, -40, 12);
  for (const [i, x] of ((m.music as unknown[]) ?? []).entries()) {
    if (!isObj(x) || typeof x.clip_id !== 'string') throw bad(`music[${i}] needs clip_id`);
    num(`music[${i}].gain_db`, x.gain_db, -60, 12);
    num(`music[${i}].start`, x.start, 0, 3600);
    num(`music[${i}].fade_in`, x.fade_in, 0, 30);
    num(`music[${i}].fade_out`, x.fade_out, 0, 30);
  }
  for (const [i, x] of ((m.sfx as unknown[]) ?? []).entries()) {
    if (!isObj(x) || typeof x.clip_id !== 'string' || typeof x.at !== 'number') throw bad(`sfx[${i}] needs clip_id and at`);
    num(`sfx[${i}].gain_db`, x.gain_db, -60, 12);
  }
  if (m.ducking !== undefined) {
    const d = m.ducking;
    if (!isObj(d) || typeof d.enabled !== 'boolean') throw bad('ducking needs enabled');
    num('ducking.amount', d.amount, 1, 20);
    num('ducking.release_ms', d.release_ms, 50, 3000);
  }
  return m as MixSpec;
}

/**
 * Build the audio filter graph that produces the final mix. Pure function: returns ffmpeg input
 * paths in order plus a filter_complex string and the output label. Narration chunks are placed at
 * their start times; music is looped/trimmed to the video length, faded, and ducked under narration
 * with a sidechain compressor; sfx are placed at fixed times.
 */
export function buildMixGraph(args: {
  narration: { path: string; start: number }[];
  music: { path: string; spec: NonNullable<MixSpec['music']>[number] }[];
  sfx: { path: string; spec: NonNullable<MixSpec['sfx']>[number] }[];
  spec: MixSpec;
  duration: number;
}): { inputs: string[]; filter: string; out: string } {
  const { narration, music, sfx, spec, duration } = args;
  const inputs: string[] = [];
  const parts: string[] = [];
  const dur = duration.toFixed(3);
  const fmt = 'aformat=sample_rates=44100:channel_layouts=stereo';

  const nLabels: string[] = [];
  narration.forEach((n, i) => {
    inputs.push(n.path);
    const ms = Math.round(n.start * 1000);
    parts.push(`[${inputs.length - 1}:a]${fmt},adelay=${ms}|${ms}[n${i}]`);
    nLabels.push(`[n${i}]`);
  });
  if (!nLabels.length) throw bad('No narration to mix');
  const gain = spec.narration_gain_db ? `,volume=${spec.narration_gain_db}dB` : '';
  parts.push(`${nLabels.join('')}amix=inputs=${nLabels.length}:normalize=0:duration=longest,apad=whole_dur=${dur},atrim=0:${dur}${gain}[narr]`);

  const bed: string[] = ['[narr]'];
  if (music.length) {
    const duck = spec.ducking?.enabled !== false; // ducking on by default when music is present
    parts.push(`[narr]asplit=2[narr_mix][narr_sc]`);
    bed[0] = '[narr_mix]';
    music.forEach((m, i) => {
      inputs.push(m.path);
      const idx = inputs.length - 1;
      const s = m.spec;
      const delay = Math.round((s.start ?? 0) * 1000);
      const chain = [fmt];
      if (s.loop) chain.push('aloop=loop=-1:size=2147483647');
      chain.push(`atrim=0:${Math.max(0.1, duration - (s.start ?? 0)).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
      if (s.fade_in) chain.push(`afade=t=in:st=0:d=${s.fade_in}`);
      if (s.fade_out) chain.push(`afade=t=out:st=${Math.max(0, duration - (s.start ?? 0) - s.fade_out).toFixed(3)}:d=${s.fade_out}`);
      chain.push(`volume=${s.gain_db ?? -14}dB`, `adelay=${delay}|${delay}`);
      parts.push(`[${idx}:a]${chain.join(',')}[m${i}]`);
    });
    const ml = music.map((_, i) => `[m${i}]`);
    parts.push(`${ml.join('')}amix=inputs=${ml.length}:normalize=0:duration=longest[musicbed]`);
    if (duck) {
      const amount = spec.ducking?.amount ?? 8;
      parts.push(`[musicbed][narr_sc]sidechaincompress=threshold=0.03:ratio=${amount}:attack=20:release=${spec.ducking?.release_ms ?? 400}[ducked]`);
      bed.push('[ducked]');
    } else bed.push('[musicbed]');
  }
  sfx.forEach((x, i) => {
    inputs.push(x.path);
    const ms = Math.round(x.spec.at * 1000);
    parts.push(`[${inputs.length - 1}:a]${fmt},volume=${x.spec.gain_db ?? -6}dB,adelay=${ms}|${ms}[s${i}]`);
    bed.push(`[s${i}]`);
  });
  parts.push(`${bed.join('')}amix=inputs=${bed.length}:normalize=0:duration=longest,apad=whole_dur=${dur},atrim=0:${dur},alimiter=limit=0.95[aout]`);
  return { inputs, filter: parts.join(';'), out: '[aout]' };
}
