// Writes the base script from the approved research: narration plus a detailed visual brief for every beat.
// The result is a draft saved by actor 'ai'; only the person can submit and approve it.
import { EngineError } from '../engine.ts';
import type { Studio } from '../services.ts';
import { SECTION_KINDS, VISUAL_FIELDS } from '../studios/script.ts';
import type { ScriptCharacter, ScriptContent, ScriptSection, SectionKind } from '../studios/script.ts';
import type { PresetId } from '../studios/estimator.ts';
import { profileFor } from '../studios/storyboard.ts';
import type { ResearchContent } from '../studios/research.ts';
import { parseModelJson } from './topics.ts';

export const MIN_SECONDS = 15;
export const MAX_SECONDS = 600;
const BEAT_SECONDS = 4;
const MAX_SECTIONS = 150;

const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);

export function checkSeconds(n: unknown): number {
  const s = Number(n);
  if (!Number.isInteger(s) || s < MIN_SECONDS || s > MAX_SECONDS) throw bad(`Choose a length between ${MIN_SECONDS} and ${MAX_SECONDS} seconds`);
  return s;
}
export const beatsFor = (seconds: number) => Math.max(4, Math.round(seconds / BEAT_SECONDS));
/** Words that fit once the estimator's pauses (about 0.35 s per sentence and 0.3 s between sections) are taken out. */
export const wordBudget = (seconds: number, wpm: number) => Math.max(beatsFor(seconds) * 4, Math.floor(((seconds * 0.95 - beatsFor(seconds) * 0.65) * wpm) / 60));
export const presetFor = (seconds: number): PresetId => (seconds <= 30 ? 'short_lt30' : seconds <= 45 ? 'short_30_45' : seconds <= 60 ? 'short_45_60' : 'custom');

const FRAMING: Record<string, string> = {
  vertical_9x16: 'vertical 9:16 (keep the subject centred and tall; leave the lower third clear for captions)',
  horizontal_16x9: 'horizontal 16:9 (wide composition; subjects can sit left or right of centre)',
  square_1x1: 'square 1:1 (tight centred composition)',
};
const LANGUAGE: Record<string, string> = {
  en: 'English',
  tl: 'natural spoken Tagalog (Filipino)',
  taglish: 'natural spoken Taglish, the way Filipinos actually mix Tagalog and English',
};

export interface ScriptBrief {
  topic: string;
  angle?: string;
  category?: string;
  facts: { text: string; verified: boolean }[];
  lang: string;
  langName: string;
  seconds: number;
  words: number;
  formats: string[];
  notes?: string;
}

export function buildScriptPrompt(b: ScriptBrief): string {
  const { name, profile } = profileFor(b.category);
  const beats = beatsFor(b.seconds);
  return [
    `Write the script for a faceless narrated video about: ${b.topic}`,
    b.angle ? `Hook idea: ${b.angle}` : '',
    `Category: ${name}. Visual approach: ${profile.styles.join('; ')}.${profile.notes ? ` ${profile.notes}` : ''}`,
    '',
    `Length: about ${b.seconds} seconds. Write NO MORE THAN ${b.words} words of narration in total (about ${Math.max(4, Math.round(b.words / beats))} per section), split into about ${beats} sections of roughly ${BEAT_SECONDS} seconds each. Count the words before answering: going over makes the video too long.`,
    `Picture format: ${b.formats.map((f) => FRAMING[f] ?? f).join(' and ')}.`,
    `Narration language: ${LANGUAGE[b.lang] ?? b.langName}. Write every visual description in English.`,
    '',
    'Facts you may use (use ONLY these; never invent names, dates, numbers, quotes or events):',
    ...(b.facts.length ? b.facts.map((f, i) => `${i + 1}. [${f.verified ? 'verified' : 'NOT verified: attribute or hedge it, e.g. "records say", "the story goes"'}] ${f.text}`) : ['(none listed: stay general and do not state specific facts)']),
    '',
    'Rules:',
    '- The first section is the "hook" and grabs attention in one sentence. End with a "cta" section.',
    '- "text" is exactly what the narrator says: spoken language, no stage directions, no emojis, no markdown.',
    '- Every section is one picture. Its "visual" is the production bible for drawing or sourcing that picture, so be very detailed and concrete:',
    '  - "setting": place, time of day, period, weather, architecture or landscape, foreground, middle ground and background.',
    '  - "characters": who is on screen, using the exact names from your character list ("none" if nobody).',
    '  - "action": what each character is doing, their pose, gesture, facial expression and movement, and anything else that moves.',
    '  - "shot": shot size, angle, composition and camera movement.',
    '  - "mood": lighting source and direction, colour palette, atmosphere.',
    '  - "props": important objects and their condition.',
    '- List every recurring character once in "characters", with age, build, face, hair, clothing, colours and signature items, so each scene draws them the same way. Descriptions must not rely on resembling a real living person.',
    '- Visuals are illustrations or reconstructions: do not show invented details as documented fact, and keep it suitable for a general audience (no gore).',
    '- Keep names, places and period details consistent between sections.',
    b.notes ? `\nExtra notes from the creator: ${b.notes}` : '',
    '',
    'Return only JSON, with no text before or after:',
    '{"title":"","characters":[{"name":"","description":""}],"sections":[{"kind":"hook|intro|main|payoff|cta","text":"","delivery_note":"","visual":{"setting":"","characters":"","action":"","shot":"","mood":"","props":""}}]}',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

const clean = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Check a model answer and turn it into script content. Anything unusable is an error with the reason; nothing is padded or invented. */
export function parseScriptAnswer(answer: string, o: { title: string; lang: string; seconds: number }): ScriptContent {
  const j = parseModelJson(answer) as { title?: unknown; characters?: unknown; sections?: unknown };
  if (!j || !Array.isArray(j.sections)) throw bad('The answer has no "sections" list');
  if (j.sections.length > MAX_SECTIONS) throw bad(`The answer has too many sections (more than ${MAX_SECTIONS})`);
  const problems: string[] = [];
  const sections: ScriptSection[] = [];
  j.sections.forEach((raw: any, i: number) => {
    const text = clean(raw?.text, 700);
    const visual = Object.fromEntries(VISUAL_FIELDS.map((k) => [k, clean(raw?.visual?.[k], 900)]).filter(([, v]) => v));
    if (!text) problems.push(`Section ${i + 1} has no narration`);
    else if (!visual.setting || !visual.action) problems.push(`Section ${i + 1} is missing its setting or action description`);
    else {
      const kind = (SECTION_KINDS as readonly string[]).includes(raw?.kind) ? (raw.kind as SectionKind) : 'main';
      const note = clean(raw?.delivery_note, 200);
      sections.push({ id: `s${i + 1}`, kind, text, ...(note ? { delivery_note: note } : {}), visual });
    }
  });
  if (problems.length) throw bad('The script came back incomplete', problems.slice(0, 8));
  if (sections.length < 2) throw bad('The script came back too short');
  sections[0].kind = 'hook';
  const characters: ScriptCharacter[] = (Array.isArray(j.characters) ? j.characters : []).slice(0, 20).map((c: any) => ({ name: clean(c?.name, 80), description: clean(c?.description, 900) })).filter((c) => c.name && c.description);
  return { title: clean(j.title, 160) || o.title, lang: o.lang, preset: presetFor(o.seconds), target_seconds: o.seconds, sections, characters };
}

export class ScriptWriter {
  s: Studio;
  private writing = new Set<string>();
  constructor(studio: Studio) {
    this.s = studio;
  }

  private brief(scriptId: string, o: { seconds: unknown; notes?: string }): ScriptBrief {
    const art = this.s.engine.get(scriptId);
    if (art.kind !== 'script_base') throw bad('Scripts are written on the base script');
    const seconds = checkSeconds(o.seconds);
    const project = this.s.engine.getProject(art.project_id);
    const research = this.s.engine.list(art.project_id, { kind: 'research' })[0];
    if (research.state !== 'approved') throw new EngineError('NOT_READY', 'Approve the topic first: the script is written from the approved research');
    const r = this.s.engine.getContent(research.id) as unknown as ResearchContent;
    const lang = project.languages[0] ?? 'en';
    return {
      topic: r.topic,
      angle: r.angle,
      category: project.category ?? r.category,
      facts: (r.claims ?? []).filter((c) => c.text?.trim() && c.status !== 'speculation').map((c) => ({ text: c.text.trim(), verified: c.status === 'verified' })),
      lang,
      langName: this.s.getLocale(lang)?.name ?? lang,
      seconds,
      words: wordBudget(seconds, this.s.wpm(lang).wpm),
      formats: (project.settings.formats as string[] | undefined) ?? ['vertical_9x16'],
      notes: o.notes?.trim().slice(0, 600) || undefined,
    };
  }

  prompt(scriptId: string, o: { seconds: unknown; notes?: string }): string {
    return buildScriptPrompt(this.brief(scriptId, o));
  }

  private guard(scriptId: string, reopen?: boolean) {
    const a = this.s.engine.get(scriptId);
    if (a.state === 'approved' && !reopen) throw new EngineError('PROTECTED', `${a.label} is approved; pass reopen to replace it (the approved version stays in history)`);
  }

  private store(scriptId: string, b: ScriptBrief, answer: string, reopen?: boolean) {
    const content = parseScriptAnswer(answer, { title: b.topic, lang: b.lang, seconds: b.seconds });
    const saved = this.s.save(scriptId, content, { actor: 'ai', reopen });
    return { ...saved, sections: content.sections.length };
  }

  /** Ask Claude Code (with no tools) for a script and save it as a draft. */
  async generate(scriptId: string, o: { seconds: unknown; notes?: string; reopen?: boolean }) {
    const b = this.brief(scriptId, o);
    this.guard(scriptId, o.reopen); // before spending a run
    if (this.writing.has(scriptId)) throw new EngineError('BUSY', 'This script is already being written');
    this.writing.add(scriptId);
    try {
      const answer = await this.s.research.bridge.ask(buildScriptPrompt(b), { noTools: true });
      return this.store(scriptId, b, answer, o.reopen);
    } finally {
      this.writing.delete(scriptId);
    }
  }

  /** Manual path: paste the JSON answer from any AI. Same checks. */
  importText(scriptId: string, o: { text: unknown; seconds: unknown; reopen?: boolean }) {
    if (typeof o.text !== 'string' || !o.text.trim()) throw bad('Paste the answer to import');
    if (o.text.length > 600_000) throw bad('That answer is too long to import');
    const b = this.brief(scriptId, o);
    this.guard(scriptId, o.reopen);
    return this.store(scriptId, b, o.text, o.reopen);
  }
}
