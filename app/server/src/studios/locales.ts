import type { ScriptContent } from './script.ts';
import { countWords } from './estimator.ts';

export interface Locale {
  code: string;
  name: string;
  bcp47: string;
  default_wpm: number;
  builtin: number;
}

// ---- language-mix heuristic -------------------------------------------------------------
// A deliberately small function-word check. It only flags obvious mismatches (e.g. an "English"
// script that is mostly Tagalog). It cannot judge naturalness; a human must still review.
const TL = new Set(
  `ang ng sa na at ay mga ako ikaw ka siya kami tayo kayo sila ko mo niya namin natin ninyo nila ito iyon iyan yan yun yung
   hindi di may mayroon wala para kung pero kasi lang din rin ba po opo naman pa dahil upang noong habang lahat bawat bakit
   paano ano sino saan kailan talaga sobra sana mag nag pag ni kay kina dito doon diyan nito niyon ngayon bukas kahapon
   pala nga daw raw muna kaya tapos tsaka saka lamang pang sapagkat subalit ngunit`.split(/\s+/),
);
const EN = new Set(
  `the a an is are was were be been and of to in on for with that this it you we they he she i have has had not but so because
   at by from as or if then than there their our your his her its my me us them who what when where why how do does did can
   could will would should about into over just very more most also all any some no yes one two`.split(/\s+/),
);

export interface Mix {
  tagalog: number;
  english: number;
  unclassified: number;
  classified: number;
  tagalogRatio: number | null; // tagalog / (tagalog + english), null when too little signal
}

export function detectMix(text: string): Mix {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’\-\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let tagalog = 0;
  let english = 0;
  for (const w of words) {
    const inTl = TL.has(w);
    const inEn = EN.has(w);
    if (inTl && !inEn) tagalog++;
    else if (inEn && !inTl) english++;
  }
  const classified = tagalog + english;
  return {
    tagalog,
    english,
    unclassified: words.length - classified,
    classified,
    tagalogRatio: classified >= 8 ? tagalog / classified : null,
  };
}

export function languageFitWarnings(lang: string, text: string): string[] {
  const m = detectMix(text);
  if (m.tagalogRatio === null) return [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (lang === 'en' && m.tagalogRatio > 0.25) return [`English script looks ${pct(m.tagalogRatio)} Tagalog by function words`];
  if (lang === 'tl' && m.tagalogRatio < 0.65) return [`Tagalog script looks ${pct(1 - m.tagalogRatio)} English by function words (heuristic; loanwords are normal, check it reads naturally)`];
  if (lang === 'taglish' && (m.tagalogRatio < 0.15 || m.tagalogRatio > 0.85)) {
    return [`Taglish script is ${pct(m.tagalogRatio)} Tagalog by function words; real code-switching usually mixes both (heuristic)`];
  }
  return [];
}

// ---- adaptation prompt (manual copy-paste LLM workflow) --------------------------------
const GUIDANCE: Record<string, string> = {
  en: 'Natural spoken English for narration: short sentences, everyday words, a clear hook.',
  tl: 'Natural conversational Filipino/Tagalog as a young adult would say it aloud. Adapt idioms and flow; do NOT translate word for word. Prefer common everyday words over obscure "deep" Tagalog. Established English loanwords are fine.',
  taglish:
    'Authentic everyday Taglish (Filipino-English code-switching) as spoken in casual Metro Manila conversation. Mostly Tagalog sentence structure with English for modern, technical or punchy terms; switch mid-sentence the way people really do. Do NOT translate word for word and do NOT force every other word into English.',
};

export function buildAdaptationPrompt(args: { target: Locale; baseLang: string; title: string; sections: { id: string; kind: string; text: string }[]; notes?: string }): string {
  const guide = GUIDANCE[args.target.code] ?? `Natural, spoken-language narration in ${args.target.name}, adapted culturally rather than translated literally.`;
  return [
    `You are adapting a faceless-video narration script from "${args.baseLang}" into "${args.target.name}" (${args.target.bcp47}).`,
    '',
    `Style: ${guide}`,
    '',
    'Rules:',
    '- Adapt idioms, hooks and calls to action so they sound natural; do not translate literally.',
    '- Keep every fact, number, date and proper name exactly as in the source. Do not add new claims.',
    '- Keep the same section ids and kinds, in the same order.',
    '- Keep each section about the same spoken length as the source.',
    '- If a word is likely to be mispronounced by a text-to-speech voice, add an optional "tts_text" with a phonetic respelling. Never put respellings in "text".',
    '- Return only JSON: {"sections":[{"id":"...","kind":"...","text":"...","tts_text":"(optional)"}]}',
    args.notes ? `\nExtra notes from the creator: ${args.notes}` : '',
    '',
    `Title: ${args.title}`,
    'Source sections:',
    JSON.stringify(args.sections, null, 2),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---- side-by-side comparison -----------------------------------------------------------
export interface CompareRow {
  id: string;
  kind: string;
  status: 'ok' | 'missing' | 'empty' | 'extra';
  base_text: string | null;
  lang_text: string | null;
  base_words: number;
  lang_words: number;
}

export function compareScripts(base: ScriptContent, lang: ScriptContent): { rows: CompareRow[]; missing: string[] } {
  const byId = new Map(lang.sections.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows: CompareRow[] = [];
  const missing: string[] = [];
  for (const b of base.sections) {
    const l = byId.get(b.id);
    seen.add(b.id);
    if (!l) missing.push(b.id);
    rows.push({
      id: b.id,
      kind: b.kind,
      status: !l ? 'missing' : l.text.trim() ? 'ok' : 'empty',
      base_text: b.text,
      lang_text: l?.text ?? null,
      base_words: countWords(b.text),
      lang_words: l ? countWords(l.text) : 0,
    });
  }
  for (const l of lang.sections) {
    if (!seen.has(l.id)) rows.push({ id: l.id, kind: l.kind, status: 'extra', base_text: null, lang_text: l.text, base_words: 0, lang_words: countWords(l.text) });
  }
  return { rows, missing };
}

// ---- pronunciation (TTS-only text) -----------------------------------------------------
export interface LexiconEntry {
  term: string;
  respelling: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyLexicon(text: string, entries: LexiconEntry[]): string {
  let out = text;
  for (const e of [...entries].sort((a, b) => b.term.length - a.term.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(e.term)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, () => e.respelling);
  }
  return out;
}

/** Text sent to TTS. An explicit per-section tts_text wins; otherwise the lexicon is applied to display text. Captions always use `text`. */
export function ttsText(section: { text: string; tts_text?: string }, entries: LexiconEntry[]): string {
  return section.tts_text?.trim() ? section.tts_text : applyLexicon(section.text, entries);
}
