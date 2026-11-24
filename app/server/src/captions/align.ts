import type { Silence } from '../media.ts';

// Script-anchored caption alignment. The CANONICAL text always comes from the approved script;
// audio only supplies timestamps. Nothing here ever copies ASR spelling into the caption text.

export interface ScriptWord {
  text: string; // display text with punctuation, exactly as in the script
  norm: string; // lowercase, punctuation stripped
  section_id: string;
}
export interface Timing {
  start: number;
  end: number;
}
export type Confidence = 'low' | 'medium' | 'high';

export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’]/g, "'");
}

export function tokenize(sections: { id: string; text: string }[]): ScriptWord[] {
  const out: ScriptWord[] = [];
  for (const s of sections) {
    for (const raw of s.text.split(/\s+/).filter(Boolean)) {
      const norm = normalizeWord(raw);
      if (norm) out.push({ text: raw, norm, section_id: s.id });
    }
  }
  return out;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const SOFT_PAUSE = /[,;:—–]["')\]]*$/;
export const endsSentence = (w: string) => SENTENCE_END.test(w);

function units(w: ScriptWord): number {
  const vowels = (w.norm.match(/[aeiouáéíóúàèìòùâêîôû]+/g) ?? []).length;
  return 1.5 * Math.max(1, vowels) + 0.5 * w.norm.length;
}
function pauseUnits(w: ScriptWord): number {
  return SENTENCE_END.test(w.text) ? 4 : SOFT_PAUSE.test(w.text) ? 2 : 0;
}

/** Distribute [from,to] across words by syllable-ish weight, leaving short gaps after commas. */
function spread(words: ScriptWord[], from: number, to: number, includeFinalPause: boolean): Timing[] {
  const w = words.map((x, i) => ({ speak: units(x), pause: i === words.length - 1 && !includeFinalPause ? 0 : pauseUnits(x) }));
  const total = w.reduce((n, x) => n + x.speak + x.pause, 0) || 1;
  const span = Math.max(0, to - from);
  let t = from;
  return w.map((x) => {
    const start = t;
    const end = start + (x.speak / total) * span;
    t = end + (x.pause / total) * span;
    return { start, end };
  });
}

export interface HeuristicResult {
  timings: Timing[];
  confidence: Confidence;
  method: 'silence-anchored' | 'proportional';
  note: string;
}

/**
 * Approximate word timings for narration audio when no word-boundary data exists.
 * Uses detected silences to pin sentence boundaries when their count matches, otherwise spreads
 * words proportionally across the speech window. Word-level accuracy is approximate; sentence-level
 * is good when silences line up. Confidence says which case applied.
 */
export function alignHeuristic(words: ScriptWord[], duration: number, silences: Silence[]): HeuristicResult {
  if (!words.length) return { timings: [], confidence: 'low', method: 'proportional', note: 'No words' };
  const sil = silences.map((s) => ({ start: s.start, end: Math.min(s.end, duration) })).filter((s) => s.end > s.start);
  let from = 0;
  let to = duration;
  const lead = sil.find((s) => s.start <= 0.05);
  if (lead) from = lead.end;
  const tail = sil.find((s) => s.end >= duration - 0.05 && s.start > from);
  if (tail) to = tail.start;
  const inner = sil.filter((s) => s.start > from + 0.05 && s.end < to - 0.05);

  const sentences: number[][] = [[]];
  words.forEach((w, i) => {
    sentences[sentences.length - 1].push(i);
    if (SENTENCE_END.test(w.text) && i < words.length - 1) sentences.push([]);
  });
  const gaps = sentences.length - 1;

  if (gaps > 0 && inner.length >= gaps) {
    // choose the `gaps` longest inner silences, back in time order, as sentence boundaries
    const chosen = [...inner].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, gaps).sort((a, b) => a.start - b.start);
    const timings: Timing[] = new Array(words.length);
    let cursor = from;
    sentences.forEach((idxs, si) => {
      const end = si < gaps ? chosen[si].start : to;
      spread(idxs.map((i) => words[i]), cursor, Math.max(end, cursor + 0.05), false).forEach((t, k) => (timings[idxs[k]] = t));
      if (si < gaps) cursor = chosen[si].end;
    });
    return { timings, confidence: inner.length === gaps ? 'medium' : 'low', method: 'silence-anchored', note: `Sentence boundaries pinned to ${gaps} detected pause(s); word times are approximate` };
  }
  return { timings: spread(words, from, to, false), confidence: 'low', method: 'proportional', note: gaps ? `Found ${inner.length} pause(s) for ${gaps} sentence break(s); fell back to proportional timing` : 'Proportional timing across the speech window' };
}

// ---- ASR-assisted alignment (whisper.cpp etc.): transfer timestamps onto the canonical script words ----
export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export interface AsrResult {
  timings: Timing[];
  matched: number;
  confidence: Confidence;
}

/**
 * Needleman-Wunsch between script words and ASR words. ASR spelling may be wrong (common for
 * Tagalog/Taglish): only its timestamps are used. Unmatched script words are interpolated.
 */
export function alignWithAsr(words: ScriptWord[], asr: AsrWord[], duration: number): AsrResult {
  const n = words.length;
  const m = asr.length;
  const norm = asr.map((a) => normalizeWord(a.word));
  const GAP = -0.6;
  const score = (i: number, j: number) => {
    const s = similarity(words[i].norm, norm[j]);
    return s >= 0.5 ? s * 2 - 0.5 : -1;
  };
  const H: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) H[i][0] = i * GAP;
  for (let j = 1; j <= m; j++) H[0][j] = j * GAP;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) H[i][j] = Math.max(H[i - 1][j - 1] + score(i - 1, j - 1), H[i - 1][j] + GAP, H[i][j - 1] + GAP);

  const hit: (Timing | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const sc = score(i - 1, j - 1);
    if (H[i][j] === H[i - 1][j - 1] + sc) {
      if (sc > 0) hit[i - 1] = { start: asr[j - 1].start, end: asr[j - 1].end };
      i--;
      j--;
    } else if (H[i][j] === H[i - 1][j] + GAP) i--;
    else j--;
  }
  const matched = hit.filter(Boolean).length;
  // interpolate runs of unmatched words between matched anchors
  const timings: Timing[] = new Array(n);
  let k = 0;
  while (k < n) {
    if (hit[k]) {
      timings[k] = hit[k]!;
      k++;
      continue;
    }
    let e = k;
    while (e < n && !hit[e]) e++;
    const from = k > 0 ? timings[k - 1].end : 0;
    const to = e < n ? hit[e]!.start : duration;
    spread(words.slice(k, e), from, Math.max(to, from + 0.05 * (e - k)), true).forEach((t, x) => (timings[k + x] = t));
    k = e;
  }
  return { timings: monotonic(timings, duration), matched, confidence: matched / Math.max(1, n) >= 0.8 ? 'high' : matched / Math.max(1, n) >= 0.5 ? 'medium' : 'low' };
}

/** Force non-decreasing, non-overlapping times with a minimum word length, clamped to the audio. */
export function monotonic(t: Timing[], duration: number): Timing[] {
  const MIN = 0.04;
  let prev = 0;
  return t.map((x) => {
    const start = Math.min(Math.max(x.start, prev), Math.max(0, duration - MIN));
    const end = Math.min(Math.max(x.end, start + MIN), Math.max(duration, start + MIN));
    prev = end;
    return { start: round(start), end: round(end) };
  });
}

export const round = (n: number) => Math.round(n * 1000) / 1000;
