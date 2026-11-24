import { EngineError } from '../engine.ts';
import { normalizeWord, round } from './align.ts';
import { endsSentence } from './align.ts';

export interface CaptionWord {
  text: string;
  start: number; // seconds on the narration timeline
  end: number;
  section_id: string;
  override?: boolean; // true when the creator deliberately changed the text from the script
}

export interface CaptionStyle {
  font_family: string;
  font_scale: number; // multiplier on the format's safe-zone font size
  bold: boolean;
  uppercase: boolean;
  color: string; // #RRGGBB
  stroke_color: string;
  stroke_width: number; // fraction of font size
  shadow: number; // 0..1
  pill: { enabled: boolean; color: string; opacity: number };
  active_word: { enabled: boolean; color: string; pop: number }; // pop: extra scale while the word is spoken, 0 = none
  animation: 'none' | 'fade' | 'pop';
}

export const DEFAULT_STYLE: CaptionStyle = {
  font_family: 'Arial Black',
  font_scale: 1,
  bold: false,
  uppercase: false,
  color: '#FFFFFF',
  stroke_color: '#000000',
  stroke_width: 0.08,
  shadow: 0.4,
  pill: { enabled: false, color: '#000000', opacity: 0.55 },
  active_word: { enabled: true, color: '#FFD400', pop: 0.12 },
  animation: 'fade',
};

export interface CaptionTrack {
  lang: string;
  method: 'heuristic' | 'asr-assisted' | 'tts-boundaries' | 'manual';
  confidence: 'low' | 'medium' | 'high';
  note?: string;
  audio_ref: string[]; // narration clip ids this timing was derived from
  duration: number; // narration timeline length the words were aligned to
  words: CaptionWord[];
  style: CaptionStyle;
}

const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const HEX = /^#[0-9a-fA-F]{6}$/;

export function validateStyle(s: unknown): CaptionStyle {
  if (!isObj(s)) throw bad('style must be an object');
  const num = (k: string, lo: number, hi: number, v: unknown) => {
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw bad(`style.${k} must be a number between ${lo} and ${hi}`);
  };
  if (typeof s.font_family !== 'string' || !s.font_family.trim() || /[,{}\\]/.test(s.font_family)) throw bad('style.font_family must be a plain font name');
  num('font_scale', 0.5, 2, s.font_scale);
  num('stroke_width', 0, 0.3, s.stroke_width);
  num('shadow', 0, 1, s.shadow);
  for (const k of ['bold', 'uppercase'] as const) if (typeof s[k] !== 'boolean') throw bad(`style.${k} must be boolean`);
  for (const k of ['color', 'stroke_color'] as const) if (typeof s[k] !== 'string' || !HEX.test(s[k] as string)) throw bad(`style.${k} must be #RRGGBB`);
  const pill = s.pill as Record<string, unknown>;
  if (!isObj(pill) || typeof pill.enabled !== 'boolean' || !HEX.test(String(pill.color))) throw bad('style.pill needs enabled and #RRGGBB color');
  num('pill.opacity', 0, 1, pill.opacity);
  const aw = s.active_word as Record<string, unknown>;
  if (!isObj(aw) || typeof aw.enabled !== 'boolean' || !HEX.test(String(aw.color))) throw bad('style.active_word needs enabled and #RRGGBB color');
  num('active_word.pop', 0, 0.5, aw.pop);
  if (!['none', 'fade', 'pop'].includes(s.animation as string)) throw bad('style.animation must be none, fade or pop');
  return s as unknown as CaptionStyle;
}

export function validateTrackShape(c: unknown): CaptionTrack {
  if (!isObj(c)) throw bad('Caption track must be an object');
  if (typeof c.lang !== 'string') throw bad('lang is required');
  if (!['heuristic', 'asr-assisted', 'tts-boundaries', 'manual'].includes(c.method as string)) throw bad('invalid method');
  if (!['low', 'medium', 'high'].includes(c.confidence as string)) throw bad('invalid confidence');
  if (!Array.isArray(c.audio_ref) || !c.audio_ref.every((x) => typeof x === 'string')) throw bad('audio_ref must be clip ids');
  if (typeof c.duration !== 'number' || !(c.duration >= 0)) throw bad('duration must be a number');
  if (!Array.isArray(c.words)) throw bad('words must be an array');
  let prevEnd = 0;
  c.words.forEach((w, i) => {
    if (!isObj(w) || typeof w.text !== 'string' || !w.text.trim() || typeof w.section_id !== 'string') throw bad(`Word ${i + 1} needs text and section_id`);
    if (typeof w.start !== 'number' || typeof w.end !== 'number' || !(w.start >= 0) || !(w.end >= w.start)) throw bad(`Word ${i + 1} ("${w.text}") has invalid timing`);
    if (w.start < prevEnd - 0.001) throw bad(`Word ${i + 1} ("${w.text}") overlaps the previous word`);
    if (w.end > (c.duration as number) + 0.25) throw bad(`Word ${i + 1} ("${w.text}") ends after the narration (${w.end}s > ${c.duration}s)`);
    prevEnd = w.end;
  });
  validateStyle(c.style);
  return c as unknown as CaptionTrack;
}

/**
 * Spelling guardrail: caption words must match the approved script word-for-word. Raw ASR guesses
 * can never replace approved Tagalog/Taglish spelling; a deliberate change must set override:true.
 */
export function checkAgainstScript(words: CaptionWord[], script: { id: string; text: string }[]): string[] {
  const expected = script.flatMap((s) => s.text.split(/\s+/).filter(Boolean).map((t) => ({ norm: normalizeWord(t), section: s.id, raw: t }))).filter((e) => e.norm);
  const problems: string[] = [];
  if (words.length !== expected.length && !words.some((w) => w.override)) problems.push(`Caption has ${words.length} words but the script has ${expected.length}`);
  const n = Math.min(words.length, expected.length);
  for (let i = 0; i < n && problems.length < 5; i++) {
    if (words[i].override) continue;
    if (normalizeWord(words[i].text) !== expected[i].norm) problems.push(`Word ${i + 1} is "${words[i].text}" but the approved script says "${expected[i].raw}" (set override: true to change it on purpose)`);
  }
  return problems;
}

export interface Segment {
  start: number;
  end: number;
  words: number[]; // indices into track.words
  text: string;
}

/** Group words into on-screen caption segments for a given words/characters budget. Breaks at sentence ends, long pauses, then commas near the limit. */
export function segmentWords(words: CaptionWord[], opts: { maxWords: number; maxChars: number; pauseBreak?: number }): Segment[] {
  const pauseBreak = opts.pauseBreak ?? 0.7;
  const segs: Segment[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ start: words[cur[0]].start, end: words[cur[cur.length - 1]].end, words: cur, text: cur.map((i) => words[i].text).join(' ') });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const chars = cur.length ? cur.reduce((n, k) => n + words[k].text.length + 1, 0) + w.text.length : w.text.length;
    if (cur.length && (cur.length >= opts.maxWords || chars > opts.maxChars || w.start - words[cur[cur.length - 1]].end > pauseBreak)) flush();
    cur.push(i);
    const soft = /[,;:—–]$/.test(w.text) && cur.length >= Math.max(2, Math.floor(opts.maxWords / 2));
    if (endsSentence(w.text) || soft) flush();
  }
  flush();
  return segs;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function timecode(sec: number, comma: boolean): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms % 1000, 3)}`;
}

/** Wrap a cue into at most two balanced lines of roughly `width` characters. */
function wrapTwoLines(text: string, width: number): string {
  if (text.length <= width) return text;
  const words = text.split(' ');
  let best = text;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) (bestDiff = diff), (best = `${a}\n${b}`);
  }
  return best;
}

function cues(words: CaptionWord[]) {
  return segmentWords(words, { maxWords: 12, maxChars: 84 }).map((s) => ({ start: s.start, end: Math.max(s.end, s.start + 0.3), text: wrapTwoLines(s.text, 42) }));
}

export function toSrt(words: CaptionWord[]): string {
  return cues(words).map((c, i) => `${i + 1}\n${timecode(c.start, true)} --> ${timecode(c.end, true)}\n${c.text}\n`).join('\n');
}

export function toVtt(words: CaptionWord[]): string {
  return `WEBVTT\n\n${cues(words).map((c) => `${timecode(c.start, false)} --> ${timecode(c.end, false)}\n${c.text}\n`).join('\n')}`;
}

export { round };
