import { EngineError } from '../engine.ts';
import type { TimedMouthCue } from './prompt-directives.ts';

export const ANIMATED_OPTIONAL_STAGES = ['referenceAnalysis', 'artDirection', 'composition', 'anatomy', 'environmentMaterials', 'lighting', 'texture', 'renderedReview', 'targetedCorrections', 'animationPreparation'] as const;
export type AnimatedOptionalStage = typeof ANIMATED_OPTIONAL_STAGES[number];
export const ANIMATED_BUDGET_STAGES = [...ANIMATED_OPTIONAL_STAGES, 'baseArtwork', 'motion', 'motionRefinement'] as const;
export type AnimatedBudgetStage = typeof ANIMATED_BUDGET_STAGES[number];
export type AnimatedStageBudget = { timeoutMs?: number; maxOutputBytes?: number };
export type AnimatedReviewFallback = 'source-only' | 'skip';
export interface AnimatedGenerationControls {
  stages?: Partial<Record<AnimatedOptionalStage, boolean>>;
  /** Limits automatic targeted correction/review cycles; a manually requested correction still runs once. */
  maxRevisions?: number;
  /** If pixels cannot be reviewed, use text-only critique or stop the optional review. */
  reviewFallback?: AnimatedReviewFallback;
  stageBudgets?: Partial<Record<AnimatedBudgetStage, AnimatedStageBudget>>;
}

function controlsRecord(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new EngineError('VALIDATION', `Use an object for animated SVG ${field}.`);
  return v as Record<string, unknown>;
}
function integer(v: unknown, min: number, max: number, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new EngineError('VALIDATION', `${label} must be an integer from ${min} to ${max}.`);
  return v;
}

/** Used at settings/job admission and at generation; unknown stage keys are rejected. No defaults or side effects. */
export function readAnimatedGenerationControls(input: unknown = {}): AnimatedGenerationControls {
  const src = controlsRecord(input, 'generation controls');
  const out: AnimatedGenerationControls = {};
  if (src.stages !== undefined) {
    const stages: NonNullable<AnimatedGenerationControls['stages']> = {};
    for (const [key, v] of Object.entries(controlsRecord(src.stages, 'stages'))) {
      if (!ANIMATED_OPTIONAL_STAGES.includes(key as AnimatedOptionalStage) || typeof v !== 'boolean') throw new EngineError('VALIDATION', `Invalid animated SVG stage: ${key}.`);
      stages[key as AnimatedOptionalStage] = v;
    }
    if (Object.keys(stages).length) out.stages = stages;
  }
  if (src.maxRevisions !== undefined) out.maxRevisions = integer(src.maxRevisions, 0, 3, 'Automatic revision limit');
  if (src.reviewFallback !== undefined) {
    if (src.reviewFallback !== 'source-only' && src.reviewFallback !== 'skip') throw new EngineError('VALIDATION', 'Choose source-only or skip for the animation review fallback.');
    out.reviewFallback = src.reviewFallback;
  }
  if (src.stageBudgets !== undefined) {
    const budgets: NonNullable<AnimatedGenerationControls['stageBudgets']> = {};
    for (const [key, value] of Object.entries(controlsRecord(src.stageBudgets, 'stage budgets'))) {
      if (!ANIMATED_BUDGET_STAGES.includes(key as AnimatedBudgetStage)) throw new EngineError('VALIDATION', `Unknown animated SVG stage budget: ${key}.`);
      const b = controlsRecord(value, `${key} stage budget`), budget: AnimatedStageBudget = {};
      if (Object.keys(b).some((k) => !['timeoutMs', 'maxOutputBytes'].includes(k))) throw new EngineError('VALIDATION', `Unknown limit in animated SVG ${key} stage budget.`);
      if (b.timeoutMs !== undefined) budget.timeoutMs = integer(b.timeoutMs, 100, 480_000, `${key} timeout (ms)`);
      if (b.maxOutputBytes !== undefined) budget.maxOutputBytes = integer(b.maxOutputBytes, 1, 600_064, `${key} output budget (bytes)`);
      if (Object.keys(budget).length) budgets[key as AnimatedBudgetStage] = budget;
    }
    if (Object.keys(budgets).length) out.stageBudgets = budgets;
  }
  return out;
}

/** Host-supplied, scene-local speech timing; never synthesize timing from model output. */
export function readTimedMouthCues(value: unknown, duration: number): TimedMouthCue[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 38) throw new EngineError('VALIDATION', 'Use at most 38 timed mouth cues in a scene.');
  let previousEnd = 0;
  return value.map((input) => {
    const { start, end, shape } = controlsRecord(input, 'timed mouth cue');
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < previousEnd || end <= start || end > duration || typeof shape !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(shape)) {
      throw new EngineError('VALIDATION', 'Timed mouth cues must use ordered non-overlapping intervals, within the scene, with named shapes.');
    }
    previousEnd = end;
    return {start, end, shape};
  });
}

/** Bound long-running local or provider work without assuming that every adapter respects AbortSignal. */
export async function runWithAnimatedStageDeadline<T>(o: {label: string; timeoutMs?: number; signal?: AbortSignal; run: (signal?: AbortSignal) => Promise<T>}): Promise<T> {
  const {label, timeoutMs, signal, run} = o;
  const cancelled = () => new EngineError('CANCELLED', 'Animated SVG generation was cancelled.');
  if (signal?.aborted) throw cancelled();
  if (timeoutMs === undefined && !signal) return run(undefined);
  const own = timeoutMs === undefined ? undefined : new AbortController();
  const operation = own ? (signal ? AbortSignal.any([signal, own.signal]) : own.signal) : signal!;
  const timer = own ? setTimeout(() => own.abort(), timeoutMs) : undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.aborted ? cancelled() : new EngineError('PROVIDER_ERROR', `${label} exceeded its configured time budget.`));
      if (operation.aborted) onAbort(); else operation.addEventListener('abort', onAbort, {once:true});
    });
    const result = await Promise.race([aborted, Promise.resolve().then(() => {operation.throwIfAborted(); return run(operation);})]);
    if (signal?.aborted) throw cancelled();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) operation.removeEventListener('abort', onAbort);
  }
}
export function checkAnimatedStageOutput(label: string, output: string, maxOutputBytes?: number): string {
  if (typeof output !== 'string' || (maxOutputBytes !== undefined && Buffer.byteLength(output, 'utf8') > maxOutputBytes)) throw new EngineError('PROVIDER_ERROR', `${label} exceeded its configured output budget or returned no text.`);
  return output;
}
/** Apply optional timeout and returned-byte caps to an exact, already-built provider prompt. */
export async function runBoundedAnimatedStage(o: {label: string; budget?: AnimatedStageBudget; signal?: AbortSignal; run: (signal?: AbortSignal) => Promise<string>}): Promise<string> {
  const {label, budget, signal, run} = o;
  return checkAnimatedStageOutput(label, await runWithAnimatedStageDeadline({label, timeoutMs:budget?.timeoutMs, signal, run}), budget?.maxOutputBytes);
}
