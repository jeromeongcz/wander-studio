import { EngineError } from '../engine.ts';
import type { Actor } from '../../../shared/src/index.ts';

export const CLAIM_STATUSES = ['verified', 'unverified', 'speculation'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface Source {
  id: string;
  url: string;
  title?: string;
  note?: string;
}
export interface Claim {
  id: string;
  text: string;
  status: ClaimStatus;
  sourceIds: string[];
}
export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}
export interface ResearchContent {
  topic: string;
  category?: string;
  angle?: string;
  notes?: string;
  sources: Source[];
  claims: Claim[];
  checklist: ChecklistItem[];
}

export const DEFAULT_CHECKLIST = [
  'Every key fact has at least one source',
  'Dates, names and numbers were double-checked',
  'Unverified claims are marked or removed',
  'Creative speculation is labelled as speculation',
  'No AI-generated summary is treated as verified',
];

export function newResearchContent(topic: string, category?: string): ResearchContent {
  return {
    topic,
    category,
    sources: [],
    claims: [],
    checklist: DEFAULT_CHECKLIST.map((label, i) => ({ id: `chk${i + 1}`, label, done: false })),
  };
}

const bad = (message: string, details?: unknown) => new EngineError('VALIDATION', message, details);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function isHttpUrl(u: unknown): boolean {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Structural validation: drafts may be incomplete, but must be well-formed. Throws EngineError('VALIDATION'). */
export function validateResearchShape(content: unknown, actor: Actor, previous: unknown | null): ResearchContent {
  if (!isObj(content)) throw bad('Research content must be an object');
  const { topic, sources, claims, checklist } = content as Record<string, unknown>;
  if (typeof topic !== 'string') throw bad('topic must be a string');
  if (!Array.isArray(sources) || !Array.isArray(claims) || !Array.isArray(checklist)) throw bad('sources, claims and checklist must be arrays');

  const ids = new Set<string>();
  for (const [i, s] of sources.entries()) {
    if (!isObj(s) || typeof s.id !== 'string' || !s.id) throw bad('Each source needs an id');
    if (!isHttpUrl(s.url)) throw bad(`Source ${i + 1} needs a valid http(s) URL (include https://)`);
    if (ids.has(s.id)) throw bad(`Duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  const prevVerified = new Map<string, string>();
  if (isObj(previous) && Array.isArray(previous.claims)) {
    for (const c of previous.claims as Claim[]) if (c.status === 'verified') prevVerified.set(c.id, JSON.stringify([c.text, [...c.sourceIds].sort()]));
  }
  const claimIds = new Set<string>();
  for (const c of claims) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.text !== 'string') throw bad('Each claim needs an id and text');
    if (claimIds.has(c.id)) throw bad(`Duplicate claim id ${c.id}`);
    claimIds.add(c.id);
    if (!CLAIM_STATUSES.includes(c.status as ClaimStatus)) throw bad(`Claim ${c.id} has invalid status`);
    if (!Array.isArray(c.sourceIds) || !c.sourceIds.every((x) => typeof x === 'string' && ids.has(x))) {
      throw bad(`Claim ${c.id} references unknown sources`);
    }
    if (c.status === 'verified' && actor !== 'user') {
      // AI may carry forward a claim the user already verified, but never verify one itself.
      const same = prevVerified.get(c.id) === JSON.stringify([c.text, [...(c.sourceIds as string[])].sort()]);
      if (!same) throw new EngineError('AI_CANNOT_VERIFY', `Only the user can mark claim ${c.id} verified`);
    }
  }
  for (const k of checklist) {
    if (!isObj(k) || typeof k.id !== 'string' || typeof k.label !== 'string' || typeof k.done !== 'boolean') throw bad('Invalid checklist item');
  }
  return content as unknown as ResearchContent;
}

/** Stricter checks required before research can be submitted for approval. */
export function researchReadiness(c: ResearchContent): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!c.topic.trim()) errors.push('Topic is empty');
  if (c.sources.length === 0) errors.push('Add at least one source');
  for (const cl of c.claims) {
    if (cl.status === 'verified' && cl.sourceIds.length === 0) errors.push(`Verified claim "${cl.text.slice(0, 40)}" has no source`);
  }
  const open = c.checklist.filter((k) => !k.done);
  if (open.length) errors.push(`Fact-verification checklist incomplete (${open.length} open)`);
  const unverified = c.claims.filter((x) => x.status === 'unverified').length;
  if (unverified) warnings.push(`${unverified} claim(s) still unverified`);
  return { errors, warnings };
}
