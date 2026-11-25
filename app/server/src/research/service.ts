import type { Studio } from '../services.ts';
import { EngineError } from '../engine.ts';
import { ulid } from '../../../shared/src/index.ts';
import type { JobCtx } from '../jobs.ts';
import { createProject } from '../pipeline.ts';
import { ClaudeBridge } from './claude.ts';
import { checkLinks } from './links.ts';
import type { LinkResult } from './links.ts';
import { MAX_TOPICS_PER_REQUEST, TOPICS_PER_RUN, buildResearchPrompt, parseModelJson, validateTopics } from './topics.ts';
import type { Topic, TopicFact } from './topics.ts';

const now = () => new Date().toISOString();
const bad = (m: string) => new EngineError('VALIDATION', m);

export function checkCount(n: unknown): number {
  const c = Number(n);
  if (!Number.isInteger(c) || c < 1 || c > MAX_TOPICS_PER_REQUEST) throw bad(`Choose between 1 and ${MAX_TOPICS_PER_REQUEST} topics`);
  return c;
}

const DEFAULT_CHECKLIST = ['Every key fact has at least one source', 'Dates, names and numbers were double-checked', 'Unverified claims are marked or removed', 'Creative speculation is labelled as speculation', 'No AI-generated summary is treated as verified'];

/** Turn a researched topic into the project's research notes. Every claim starts as UNVERIFIED: only the person can verify. */
export function researchFromTopic(t: { title: string; hook: string; confidence: string; note?: string; facts: TopicFact[] }, category?: string | null) {
  const sources: { id: string; url: string; title?: string }[] = [];
  const idFor = (url: string, title?: string) => {
    let s = sources.find((x) => x.url === url);
    if (!s) sources.push((s = { id: `s${sources.length + 1}`, url, ...(title ? { title } : {}) }));
    return s.id;
  };
  const claims = t.facts.map((f, i) => ({ id: `c${i + 1}`, text: f.text, status: 'unverified' as const, sourceIds: [idFor(f.source_url, f.source_title)] }));
  const dead = t.facts.filter((f) => f.link_status === 'dead').length;
  return {
    topic: t.title,
    ...(category ? { category } : {}),
    angle: t.hook,
    notes: [`Confidence: ${t.confidence}.${t.note ? ` ${t.note}` : ''}`, 'Researched by AI from web pages. Open each source and check it says what the claim says before marking anything verified.', dead ? `${dead} source link(s) did not load; treat those facts as unconfirmed.` : ''].filter(Boolean).join('\n'),
    sources,
    claims,
    checklist: DEFAULT_CHECKLIST.map((label, i) => ({ id: `chk${i + 1}`, label, done: false })),
  };
}

export class ResearchService {
  s: Studio;
  bridge: ClaudeBridge;
  constructor(studio: Studio) {
    this.s = studio;
    this.bridge = new ClaudeBridge(studio.config.llm?.claudeBin);
  }
  private get db() {
    return this.s.engine.db;
  }

  status() {
    return this.bridge.status();
  }

  private existingTitles(projectId: string): string[] {
    return (this.db.prepare('SELECT title FROM topic_ideas WHERE project_id = ?').all(projectId) as { title: string }[]).map((r) => r.title);
  }

  prompt(projectId: string, o: { count: unknown; focus?: string; notes?: string }) {
    const p = this.s.engine.getProject(projectId);
    return buildResearchPrompt({ category: p.category ?? '', focus: o.focus, notes: o.notes, count: checkCount(o.count), avoid: this.existingTitles(projectId) });
  }

  private insertBatch(projectId: string, o: { focus?: string; notes?: string; count: number; source: 'claude-code' | 'manual'; state: string }) {
    const p = this.s.engine.getProject(projectId);
    const id = ulid();
    this.db
      .prepare('INSERT INTO topic_batches (id, project_id, category, focus, notes, requested_count, source, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, p.category, (o.focus ?? '').trim().slice(0, 200) || null, (o.notes ?? '').trim().slice(0, 600) || null, o.count, o.source, o.state, now());
    return id;
  }

  private insertIdeas(batchId: string, projectId: string, topics: Topic[], links?: Map<string, LinkResult>) {
    for (const t of topics) {
      const facts = t.facts.map((f) => {
        const r = links?.get(f.source_url);
        return { ...f, link_status: r?.status ?? 'unchecked', ...(r ? { link_note: r.note } : {}) };
      });
      this.db
        .prepare('INSERT INTO topic_ideas (id, project_id, batch_id, title, hook, confidence, note, facts_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(ulid(), projectId, batchId, t.title, t.hook, t.confidence, t.note ?? null, JSON.stringify(facts), 'new', now());
    }
  }

  private finish(batchId: string, state: string, message: string, rejected: unknown[] = []) {
    this.db.prepare('UPDATE topic_batches SET state = ?, message = ?, rejected_json = ?, finished_at = ? WHERE id = ?').run(state, message, JSON.stringify(rejected), now(), batchId);
  }

  /** Queue an automatic research run (a background job). */
  startBatch(projectId: string, o: { count: unknown; focus?: string; notes?: string }) {
    const count = checkCount(o.count);
    const batchId = this.insertBatch(projectId, { ...o, count, source: 'claude-code', state: 'queued' });
    const job = this.s.jobs.enqueue('research_topics', { projectId, params: { batchId } });
    this.db.prepare('UPDATE topic_batches SET job_id = ? WHERE id = ?').run(job.id, batchId);
    return { batch: this.batch(batchId), job };
  }

  /** The job body. Researches in small chunks, then checks every cited link. Cancelling keeps whatever was found. */
  async run(batchId: string, ctx: JobCtx) {
    const b = this.batch(batchId);
    this.db.prepare("UPDATE topic_batches SET state = 'running' WHERE id = ?").run(batchId);
    const st = await this.bridge.status();
    if (!st.installed || !st.loggedIn) {
      const msg = `${st.detail}. ${st.fix ?? ''}`.trim();
      this.finish(batchId, 'failed', msg);
      throw new EngineError('PROVIDER_ERROR', msg);
    }
    const existing = this.existingTitles(b.project_id);
    const found: Topic[] = [];
    const rejected: { title: string; reason: string }[] = [];
    const attempts = Math.ceil(b.requested_count / TOPICS_PER_RUN) + 1;
    try {
      for (let i = 0; i < attempts && found.length < b.requested_count; i++) {
        if (ctx.signal.aborted) throw new EngineError('CANCELLED', 'Cancelled');
        const want = Math.min(TOPICS_PER_RUN, b.requested_count - found.length);
        ctx.progress(Math.min(0.85, found.length / b.requested_count), `Researching topics ${found.length + 1} to ${found.length + want} of ${b.requested_count}. This can take a few minutes.`);
        ctx.log(`Asking Claude Code for ${want} topic(s)`);
        const avoid = [...existing, ...found.map((t) => t.title)];
        const text = await this.bridge.ask(buildResearchPrompt({ category: b.category ?? '', focus: b.focus ?? undefined, notes: b.notes ?? undefined, count: want, avoid }), { signal: ctx.signal });
        try {
          const v = validateTopics(parseModelJson(text), { max: want, avoid });
          found.push(...v.topics);
          rejected.push(...v.rejected);
          ctx.log(`Got ${v.topics.length} usable topic(s), ${v.rejected.length} rejected`);
        } catch (e) {
          rejected.push({ title: '(one answer)', reason: (e as Error).message });
          ctx.log(`Could not use an answer: ${(e as Error).message}`, 'warn');
        }
      }
    } catch (e) {
      // keep what was already found (unchecked) so a cancel or a failure part-way does not waste the research
      this.insertIdeas(batchId, b.project_id, found);
      const cancelled = (e as EngineError).code === 'CANCELLED';
      this.finish(batchId, cancelled ? 'cancelled' : found.length ? 'partial' : 'failed', cancelled ? `Cancelled. Kept ${found.length} topic(s); their links were not checked.` : `${(e as Error).message}${found.length ? ` Kept ${found.length} topic(s); their links were not checked.` : ''}`, rejected);
      throw e;
    }
    if (!found.length) {
      this.finish(batchId, 'failed', 'No usable topics came back. Try again, or use the copy-paste prompt.', rejected);
      throw new EngineError('PROVIDER_ERROR', 'No usable topics came back from Claude Code');
    }
    ctx.progress(0.9, 'Checking that each source link exists…');
    const links = await checkLinks(found.flatMap((t) => t.facts.map((f) => f.source_url)), this.s.config.fetchFn);
    this.insertIdeas(batchId, b.project_id, found, links);
    const state = found.length >= b.requested_count ? 'done' : 'partial';
    this.finish(batchId, state, state === 'done' ? `Found ${found.length} topics.` : `Found ${found.length} of ${b.requested_count} topics.`, rejected);
    return { found: found.length, requested: b.requested_count, rejected: rejected.length };
  }

  /** Manual path: paste the JSON answer from any AI. It goes through the same validation and link checks. */
  async importText(projectId: string, text: unknown, o: { focus?: string } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw bad('Paste the answer to import');
    if (text.length > 400_000) throw bad('That answer is too long to import');
    const v = validateTopics(parseModelJson(text), { max: MAX_TOPICS_PER_REQUEST, avoid: this.existingTitles(projectId) });
    const batchId = this.insertBatch(projectId, { focus: o.focus, count: Math.max(1, v.topics.length), source: 'manual', state: 'running' });
    if (!v.topics.length) {
      this.finish(batchId, 'failed', 'No usable topics in the pasted answer.', v.rejected);
      throw new EngineError('VALIDATION', 'No usable topics in the pasted answer', v.rejected);
    }
    const links = await checkLinks(v.topics.flatMap((t) => t.facts.map((f) => f.source_url)), this.s.config.fetchFn);
    this.insertIdeas(batchId, projectId, v.topics, links);
    this.finish(batchId, 'done', `Imported ${v.topics.length} topic(s).`, v.rejected);
    return this.batch(batchId);
  }

  // ---- reading ----
  batch(id: string) {
    const r = this.db.prepare('SELECT * FROM topic_batches WHERE id = ?').get(id) as any;
    if (!r) throw new EngineError('NOT_FOUND', `Research batch ${id} not found`);
    return { ...r, rejected: JSON.parse(r.rejected_json) as { title: string; reason: string }[] };
  }

  list(projectId: string) {
    this.s.engine.getProject(projectId);
    const batches = (this.db.prepare('SELECT id FROM topic_batches WHERE project_id = ? ORDER BY id DESC LIMIT 30').all(projectId) as { id: string }[]).map((b) => this.batch(b.id));
    const ideas = (this.db.prepare('SELECT * FROM topic_ideas WHERE project_id = ? ORDER BY id DESC').all(projectId) as any[]).map((r) => this.idea(r));
    return { batches, ideas };
  }

  private idea(r: any) {
    const facts = JSON.parse(r.facts_json) as TopicFact[];
    const count = (s: string) => facts.filter((f) => f.link_status === s).length;
    return { id: r.id, project_id: r.project_id, batch_id: r.batch_id, title: r.title, hook: r.hook, confidence: r.confidence, note: r.note, facts, status: r.status, created_at: r.created_at, links: { reachable: count('reachable'), unclear: count('unclear'), dead: count('dead'), unchecked: count('unchecked') } };
  }

  private getIdea(id: string) {
    const r = this.db.prepare('SELECT * FROM topic_ideas WHERE id = ?').get(id);
    if (!r) throw new EngineError('NOT_FOUND', `Topic idea ${id} not found`);
    return this.idea(r);
  }

  setStatus(id: string, status: 'new' | 'dismissed') {
    const i = this.getIdea(id);
    if (i.status === 'used') throw new EngineError('BAD_TRANSITION', 'This topic was already used');
    this.db.prepare('UPDATE topic_ideas SET status = ? WHERE id = ?').run(status, id);
    return this.getIdea(id);
  }

  /** Put a topic into THIS project's research notes (a new version; earlier notes stay in history). */
  useIdea(id: string, o: { reopen?: boolean } = {}) {
    const i = this.getIdea(id);
    const research = this.s.engine.list(i.project_id, { kind: 'research' })[0];
    const project = this.s.engine.getProject(i.project_id);
    const r = this.s.save(research.id, researchFromTopic(i, project.category), { actor: 'user', reopen: o.reopen });
    this.db.prepare("UPDATE topic_ideas SET status = 'used' WHERE id = ?").run(id);
    return { ...r, idea: this.getIdea(id) };
  }

  /** Make a brand-new project for a topic, with the same category, languages and formats. */
  projectFromIdea(id: string) {
    const i = this.getIdea(id);
    const src = this.s.engine.getProject(i.project_id);
    const projectId = createProject(this.s.engine, { name: i.title, category: src.category ?? undefined, languages: src.languages, formats: (src.settings.formats as string[] | undefined) ?? ['vertical_9x16'] });
    const research = this.s.engine.list(projectId, { kind: 'research' })[0];
    this.s.save(research.id, researchFromTopic(i, src.category), { actor: 'user' });
    this.db.prepare("UPDATE topic_ideas SET status = 'used' WHERE id = ?").run(id);
    return { projectId };
  }
}
