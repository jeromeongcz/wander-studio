import { EngineError } from '../engine.ts';

// The "publishing kit": titles, description, tags, chapters, pinned-comment ideas, thumbnail hooks.
// Without a runtime LLM this is built from the approved script by deterministic templates (never inventing
// facts), plus a copy-paste prompt for a model of your choice. Everything is editable before use.

export interface KitContent {
  title_options: string[];
  description: string;
  tags: string[];
  hashtags: string[];
  chapters: { t: number; label: string }[];
  pinned_comment_ideas: string[];
  thumbnail_hooks: string[];
  notes: string[];
  generated_by: 'template' | 'manual';
}

export interface KitInput {
  lang: string;
  projectName: string;
  topic: string;
  category?: string;
  sections: { id: string; kind: string; text: string }[];
  isShort: boolean;
  durationSeconds: number;
  /** first word time per section, for long-form chapters */
  sectionStarts?: { id: string; start: number }[];
  credits?: string[];
}

const STOP = new Set('a an the and or of to in on for with is are was were be this that it its as at by from about into your you we they he she i my our their do does did how what why when who'.split(' '));

const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
const firstSentence = (t: string) => (t.trim().match(/^.*?[.!?…](?=\s|$)/)?.[0] ?? t).trim();
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
const pretty = (k: string) => ({ hook: 'Intro', intro: 'Background', main: 'The story', payoff: 'The answer', cta: 'Wrap up', other: 'More' }[k] ?? k);

const PINNED: Record<string, string[]> = {
  en: ['What surprised you most? Tell us in the comments!', 'Did you know this already? Let us know below.', 'Want more like this? Follow and tell us what to cover next.'],
  tl: ['Ano ang pinaka-nakakagulat para sa iyo? Sabihin sa comments!', 'Alam mo na ba ito? I-share ang iyong sagot sa ibaba.', 'Gusto mo pa ng ganito? Mag-follow at sabihin kung ano ang susunod.'],
  taglish: ["Ano ang pinaka-surprising sa'yo? Comment mo na!", "Alam mo na ba 'to? Share mo sa comments.", "Gusto mo pa ng ganito? Follow ka at sabihin mo kung ano next."],
};

export function generateKit(i: KitInput): KitContent {
  const hook = i.sections.find((s) => s.kind === 'hook')?.text ?? i.sections[0]?.text ?? '';
  const main = i.sections.find((s) => s.kind === 'main')?.text ?? '';
  const cta = i.sections.find((s) => s.kind === 'cta')?.text ?? '';
  const secs = Math.max(1, Math.round(i.durationSeconds));
  const titles = [...new Set([trunc(firstSentence(hook), 70), i.topic ? (i.isShort ? `${i.topic} in ${secs} seconds` : i.topic) : '', i.topic && main ? trunc(`${i.topic}: ${firstSentence(main)}`, 70) : ''].filter(Boolean))];

  const tagSet = new Set<string>();
  for (const w of [...words(i.topic), ...words(i.category ?? ''), ...words(i.projectName)]) tagSet.add(w);
  if (i.topic.trim()) tagSet.add(i.topic.trim().toLowerCase());
  const tags: string[] = [];
  let len = 0;
  for (const t of tagSet) {
    if (t.length > 30 || len + t.length + 1 > 450) continue;
    tags.push(t);
    len += t.length + 1;
    if (tags.length >= 15) break;
  }
  const camel = (s: string) => s.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('').replace(/[^\p{L}\p{N}]/gu, '');
  const hashtags = [...new Set([...(i.isShort ? ['#Shorts'] : []), ...words(i.topic).slice(0, 2).map((w) => `#${camel(w)}`), ...(i.category ? [`#${camel(i.category)}`] : [])])].slice(0, 5);

  const chapters: KitContent['chapters'] = [];
  const notes: string[] = ['Titles, tags and comments are template drafts from your script; edit them before publishing.'];
  if (!i.isShort && i.sectionStarts && i.sectionStarts.length >= 3) {
    let last = -Infinity;
    for (const s of i.sectionStarts) {
      const sec = i.sections.find((x) => x.id === s.id);
      const t = chapters.length === 0 ? 0 : Math.round(s.start);
      if (sec && t - last >= 10) {
        chapters.push({ t, label: chapters.length === 0 ? 'Intro' : trunc(firstSentence(sec.text).replace(/[.!?…]+$/, '') || pretty(sec.kind), 40) });
        last = t;
      }
    }
    if (chapters.length < 3) chapters.length = 0;
  }
  if (i.isShort) notes.push('Chapters are only used for long-form videos.');
  else if (!chapters.length) notes.push('Not enough separated sections for chapters (YouTube needs 3 or more, 10 seconds apart).');
  if (i.lang !== 'en') notes.push('Non-English comment prompts are template drafts; have a native speaker review the wording.');

  const desc = [
    firstSentence(hook),
    main ? `\n${trunc(main, 300)}` : '',
    cta ? `\n${cta}` : '',
    chapters.length ? `\nChapters:\n${formatChapters(chapters)}` : '',
    i.credits?.length ? `\nCredits:\n${i.credits.map((c) => `- ${c}`).join('\n')}` : '',
    hashtags.length ? `\n${hashtags.join(' ')}` : '',
  ].filter(Boolean).join('\n');

  const hookWords = hook.replace(/[^\p{L}\p{N}'\s-]/gu, '').trim().split(/\s+/);
  const thumbs = [...new Set([hookWords.slice(0, 4).join(' ').toUpperCase(), i.topic ? i.topic.toUpperCase().split(/\s+/).slice(0, 3).join(' ') : ''].filter((t) => t && t.length <= 28))];
  return { title_options: titles, description: desc, tags, hashtags, chapters, pinned_comment_ideas: PINNED[i.lang] ?? PINNED.en, thumbnail_hooks: thumbs, notes, generated_by: 'template' };
}

export function formatChapters(ch: { t: number; label: string }[]): string {
  const f = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  return ch.map((c) => `${f(c.t)} ${c.label}`).join('\n');
}

const bad = (m: string) => new EngineError('VALIDATION', m);

/** YouTube's real limits: title 100, description 5000, tags 500 chars total, hashtags 15 max, chapters 3+ at least 10s apart starting at 0:00. */
export function validateKit(c: unknown): KitContent {
  const k = c as KitContent;
  if (!k || typeof k !== 'object') throw bad('kit must be an object');
  const strs = (a: unknown, name: string) => {
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'string')) throw bad(`${name} must be an array of strings`);
  };
  for (const n of ['title_options', 'tags', 'hashtags', 'pinned_comment_ideas', 'thumbnail_hooks', 'notes'] as const) strs(k[n], n);
  if (typeof k.description !== 'string') throw bad('description must be a string');
  if (k.title_options.some((t) => !t.trim() || t.length > 100)) throw bad('Each title must be 1-100 characters');
  if (k.description.length > 5000) throw bad('Description is over YouTube\'s 5000 character limit');
  if (k.tags.some((t) => t.length > 30)) throw bad('Each tag must be 30 characters or fewer');
  if (k.tags.join(',').length > 500) throw bad('Tags are over the 500 character total limit');
  if (k.hashtags.length > 15) throw bad('More than 15 hashtags makes YouTube ignore all of them');
  if (k.hashtags.some((h) => !/^#[\p{L}\p{N}_]+$/u.test(h))) throw bad('Hashtags must look like #Word');
  if (!Array.isArray(k.chapters)) throw bad('chapters must be an array');
  if (k.chapters.length) {
    if (k.chapters.length < 3 || k.chapters[0].t !== 0) throw bad('Chapters need at least 3 entries and must start at 0:00');
    k.chapters.forEach((c, i) => {
      if (!c.label?.trim() || typeof c.t !== 'number') throw bad(`Chapter ${i + 1} needs a label and time`);
      if (i && c.t - k.chapters[i - 1].t < 10) throw bad(`Chapter ${i + 1} is less than 10 seconds after the previous one`);
    });
  }
  if (!['template', 'manual'].includes(k.generated_by)) throw bad('generated_by must be template or manual');
  return k;
}

export function buildKitPrompt(i: KitInput & { languageName: string }): string {
  return [
    `Write a YouTube publishing kit for a faceless ${i.isShort ? 'Short' : 'video'} in ${i.languageName} (language code ${i.lang}).`,
    '',
    'Rules:',
    '- Use only facts that appear in the script below; do not add claims.',
    '- Titles: 3-5 options, each at most 70 characters, no clickbait promises the video does not deliver.',
    '- Description: a short summary, then the call to action. Do not add a Credits section; it is added automatically.',
    '- Tags: up to 15, each at most 30 characters. Hashtags: up to 5.',
    '- Pinned comment ideas: 3 short prompts that invite replies. Thumbnail text hooks: 3, each at most 4 words.',
    i.lang === 'taglish' ? '- Write the way Filipinos actually code-switch in casual conversation; do not translate word for word.' : '',
    i.lang === 'tl' ? '- Natural conversational Filipino, not literal translation.' : '',
    '- Return only JSON: {"title_options":[],"description":"","tags":[],"hashtags":[],"pinned_comment_ideas":[],"thumbnail_hooks":[]}',
    '',
    `Topic: ${i.topic}${i.category ? ` (${i.category})` : ''}`,
    'Script:',
    JSON.stringify(i.sections.map(({ kind, text }) => ({ kind, text })), null, 2),
  ].filter((l) => l !== '').join('\n');
}
