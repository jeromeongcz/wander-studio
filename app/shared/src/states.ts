export const STATES = [
  'not_started',
  'in_progress',
  'awaiting_review',
  'approved',
  'needs_revision',
  'rejected',
  'failed',
] as const;
export type State = (typeof STATES)[number];

export type Actor = 'user' | 'system' | 'ai';

// Allowed transitions. Moving INTO `approved` or `rejected` is additionally restricted to the user.
export const TRANSITIONS: Record<State, readonly State[]> = {
  not_started: ['in_progress'],
  in_progress: ['awaiting_review', 'failed'],
  awaiting_review: ['approved', 'needs_revision', 'rejected', 'in_progress'],
  approved: ['needs_revision', 'in_progress'],
  needs_revision: ['in_progress'],
  rejected: ['in_progress'],
  failed: ['in_progress'],
};

export const USER_ONLY_TARGETS: readonly State[] = ['approved', 'rejected'];

export const ARTIFACT_KINDS = [
  'research',
  'script_base',
  'script_lang',
  'storyboard',
  'scene_asset',
  'audio',
  'caption',
  'subtitle_export',
  'composition',
  'final_render',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const FORMATS = ['vertical_9x16', 'horizontal_16x9', 'square_1x1'] as const;
export type Format = (typeof FORMATS)[number] | (string & {});
