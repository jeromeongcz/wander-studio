import type { Artifact, State } from './types';

/** The six steps a video moves through. Each step groups the existing production stages (parts). */
export interface Step {
  id: string;
  n: number;
  label: string;
  short: string;
  blurb: string;
  /** what the person does here, used for "next up" text */
  action: string;
  parts: { id: string; label: string; kinds: string[] }[];
}

export const STEPS: Step[] = [
  { id: 'topic', n: 1, label: 'Topic', short: 'Research and approve a topic', blurb: 'Choose how many ideas you want, let Claude research them with sources, then approve the one you will make.', action: 'Approve your topic', parts: [{ id: 'research', label: 'Topic & research', kinds: ['research'] }] },
  { id: 'script', n: 2, label: 'Script', short: 'Write and localize', blurb: 'Write the base script, then create and approve each language version.', action: 'Write and approve the script', parts: [{ id: 'script', label: 'Base script', kinds: ['script_base'] }, { id: 'localize', label: 'Languages', kinds: ['script_lang'] }] },
  { id: 'visuals', n: 3, label: 'Storyboard & visuals', short: 'Plan scenes, add images', blurb: 'Turn the script into scenes, then give every scene its approved visual.', action: 'Approve storyboard and visuals', parts: [{ id: 'storyboard', label: 'Storyboard', kinds: ['storyboard'] }, { id: 'visuals', label: 'Visuals', kinds: ['scene_asset'] }] },
  { id: 'voice', n: 4, label: 'Voice & captions', short: 'Narration and timing', blurb: 'Record or generate the narration, then check caption timing against the approved script.', action: 'Approve voice and captions', parts: [{ id: 'audio', label: 'Voice & audio', kinds: ['audio'] }, { id: 'captions', label: 'Captions', kinds: ['caption'] }] },
  { id: 'render', n: 5, label: 'Compose & render', short: 'Build the video', blurb: 'Assemble scenes, voice and captions, render, and watch the result.', action: 'Render and approve the video', parts: [{ id: 'compose', label: 'Compose & render', kinds: ['composition', 'final_render'] }] },
  { id: 'publish', n: 6, label: 'Publish', short: 'Export the package', blurb: 'Export captions and the publishing package. Nothing is uploaded for you.', action: 'Export and publish', parts: [{ id: 'publish', label: 'Export package', kinds: ['subtitle_export'] }] },
];

export type Agg = State | 'none';
export const aggregate = (arts: Artifact[]): Agg => {
  if (!arts.length) return 'none';
  if (arts.some((a) => a.state === 'needs_revision' || a.state === 'rejected' || a.state === 'failed')) return 'needs_revision';
  if (arts.every((a) => a.state === 'approved')) return 'approved';
  if (arts.some((a) => a.state === 'awaiting_review')) return 'awaiting_review';
  if (arts.every((a) => a.state === 'not_started')) return 'not_started';
  return 'in_progress';
};

export interface StepInfo {
  step: Step;
  agg: Agg;
  done: boolean;
  locked: boolean;
  attention: boolean; // something needs revision or failed
  waiting: boolean; // something is awaiting the person's review
  artifacts: Artifact[];
}

/** Steps unlock in order: a step opens once the one before it is fully approved. Earlier steps stay reachable. */
export function analyze(arts: Artifact[]): { steps: StepInfo[]; current: number; allDone: boolean } {
  const steps: StepInfo[] = [];
  let open = true;
  for (const step of STEPS) {
    const kinds = step.parts.flatMap((p) => p.kinds);
    const mine = arts.filter((a) => kinds.includes(a.kind));
    const agg = aggregate(mine);
    const done = agg === 'approved';
    steps.push({ step, agg, done, locked: !open, attention: mine.some((a) => ['needs_revision', 'rejected', 'failed'].includes(a.state)), waiting: mine.some((a) => a.state === 'awaiting_review'), artifacts: mine });
    if (!done) open = false;
  }
  const firstUndone = steps.findIndex((s) => !s.done);
  return { steps, current: firstUndone === -1 ? steps.length - 1 : firstUndone, allDone: firstUndone === -1 };
}

export const stepOfPart = (partId: string) => STEPS.findIndex((s) => s.parts.some((p) => p.id === partId));
