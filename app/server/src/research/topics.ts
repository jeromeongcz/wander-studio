import { EngineError } from '../engine.ts';

export const CONFIDENCE = ['well-documented', 'disputed', 'legend'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface TopicFact {
  text: string;
  source_url: string;
  source_title?: string;
  link_status?: 'reachable' | 'unclear' | 'dead' | 'unchecked';
  link_note?: string;
}
export interface Topic {
  title: string;
  hook: string;
  confidence: Confidence;
  note?: string;
  facts: TopicFact[];
}

export const MAX_TOPICS_PER_REQUEST = 20;
export const TOPICS_PER_RUN = 4; // one Claude Code run researches a few topics, so each run stays reliable and short

const GUIDANCE: Record<string, string> = {
  'philippine history': 'Documented events, people and places in Philippine history. Give dates. Prefer government archives, museums, universities and established history publishers. Mark colonial-era accounts that reflect one side.',
  'mythology and folklore': 'Stories from oral tradition. Name the region or community each comes from, say what written sources first record it, and keep the facts about the STORY (what is told, who records it), never claims that it is literally true. Use "legend" confidence unless there is real historical documentation.',
  'culture and traditions': 'Customs, festivals, crafts and everyday practices. Say where a practice is from, note regional variation, and avoid presenting one version as universal.',
  'food origins': 'Where dishes and ingredients come from. Origins are often disputed: show what each source claims, mark "disputed" when sources disagree, and never write that someone "invented" a dish unless a reliable source documents it.',
  geography: 'Places, landforms, islands, climate and borders. Give figures with the year and an official or scholarly source, because counts, areas and populations change.',
  superstitions: 'Folk beliefs and their origins. Present each as a belief, say which community holds it, and give the documented origin only if a reliable source records one; otherwise say the origin is unclear.',
};
const GENERAL = 'Interesting, well-sourced subjects within this category. Prefer reputable sources and mark uncertain material as disputed or legend.';

export function buildResearchPrompt(o: { category: string; focus?: string; notes?: string; count: number; avoid: string[] }): string {
  const guide = GUIDANCE[o.category.trim().toLowerCase()] ?? GENERAL;
  return [
    'You are a careful research assistant for a creator who makes short faceless videos. Use web search and open the pages you cite.',
    '',
    `Task: find ${o.count} distinct video topic ideas in the category "${o.category || 'General'}"${o.focus?.trim() ? `, focused on: ${o.focus.trim()}` : ''}.`,
    `Category guidance: ${guide}`,
    o.notes?.trim() ? `Extra notes from the creator: ${o.notes.trim()}` : '',
    '',
    'Rules:',
    '- Use only what you actually read on pages you opened. NEVER invent a URL, a quote, a date, a statistic or a source. If you cannot find a supporting page for a fact, leave that fact out.',
    '- Prefer reputable sources: government and museum sites, universities, established publishers, reputable news. Avoid content farms and unsourced listicles.',
    '- Each topic needs 3 to 6 key facts. Each fact is one sentence in your own words plus the exact URL of the page that supports it (a specific page, not a homepage).',
    '- "confidence" is one of: "well-documented" (several reliable sources agree), "disputed" (sources disagree or the origin is unclear), "legend" (oral tradition or belief: the facts then describe what is recorded about the story, not that it is true).',
    '- Each topic should suit a 45 to 60 second video: one clear, surprising idea, not a broad survey.',
    '- Do not include graphic violence, content about private individuals, or medical or legal advice.',
    o.avoid.length ? `- Do NOT repeat these topics, which already exist: ${o.avoid.slice(0, 60).map((t) => `"${t}"`).join('; ')}.` : '',
    '',
    'Return ONLY a JSON object, with no prose before or after and no code fence, in exactly this shape:',
    '{"topics":[{"title":"...","hook":"one-line hook","confidence":"well-documented","note":"optional caveat","facts":[{"text":"...","source_url":"https://...","source_title":"..."}]}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Pull the JSON object out of a model answer, tolerating code fences and stray text around it. */
export function parseModelJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.search(/[{[]/);
  if (first < 0) throw new EngineError('PROVIDER_ERROR', 'The answer did not contain any JSON');
  const open = t[first];
  const close = open === '{' ? '}' : ']';
  const last = t.lastIndexOf(close);
  if (last <= first) throw new EngineError('PROVIDER_ERROR', 'The answer contained incomplete JSON');
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    throw new EngineError('PROVIDER_ERROR', 'The answer was not valid JSON');
  }
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function validUrl(u: string): string | null {
  try {
    const p = new URL(u);
    if ((p.protocol !== 'https:' && p.protocol !== 'http:') || p.username || p.password || !p.hostname.includes('.')) return null;
    if (p.pathname === '/' && !p.search && !p.hash) return null; // a bare homepage does not support a specific fact
    return p.toString();
  } catch {
    return null;
  }
}

/** Strict check of model output. Bad topics are rejected with a reason instead of being silently kept. */
export function validateTopics(raw: unknown, o: { max: number; avoid?: string[] } = { max: MAX_TOPICS_PER_REQUEST }): { topics: Topic[]; rejected: { title: string; reason: string }[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { topics?: unknown }).topics) ? (raw as { topics: unknown[] }).topics : null;
  if (!list) throw new EngineError('PROVIDER_ERROR', 'Expected {"topics": [...]} in the answer');
  const seen = new Set((o.avoid ?? []).map(normTitle));
  const topics: Topic[] = [];
  const rejected: { title: string; reason: string }[] = [];
  for (const item of list) {
    const t = (item ?? {}) as Record<string, unknown>;
    const title = clean(t.title, 120);
    const reject = (reason: string) => rejected.push({ title: title || '(untitled)', reason });
    if (title.length < 3) { reject('missing title'); continue; }
    if (seen.has(normTitle(title))) { reject('duplicate of an existing topic'); continue; }
    const hook = clean(t.hook, 240);
    if (hook.length < 5) { reject('missing hook'); continue; }
    if (!CONFIDENCE.includes(t.confidence as Confidence)) { reject(`confidence must be one of ${CONFIDENCE.join(', ')}`); continue; }
    const facts: TopicFact[] = [];
    const urls = new Set<string>();
    for (const f of Array.isArray(t.facts) ? t.facts : []) {
      const x = (f ?? {}) as Record<string, unknown>;
      const text = clean(x.text, 400);
      const url = validUrl(String(x.source_url ?? '').trim());
      if (text.length < 10 || !url) continue; // a fact without a usable, specific source is dropped
      facts.push({ text, source_url: url, ...(clean(x.source_title, 160) ? { source_title: clean(x.source_title, 160) } : {}) });
      urls.add(url);
    }
    if (facts.length < 2) { reject('fewer than 2 facts with a specific source link'); continue; }
    seen.add(normTitle(title));
    topics.push({ title, hook, confidence: t.confidence as Confidence, ...(clean(t.note, 400) ? { note: clean(t.note, 400) } : {}), facts: facts.slice(0, 8) });
    if (topics.length >= o.max) break;
  }
  return { topics, rejected };
}
