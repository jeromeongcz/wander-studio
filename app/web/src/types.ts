export type State = 'not_started' | 'in_progress' | 'awaiting_review' | 'approved' | 'needs_revision' | 'rejected' | 'failed';

export interface Artifact {
  id: string;
  project_id: string;
  kind: string;
  lang_code: string | null;
  format: string | null;
  scene_id: string | null;
  label: string;
  state: State;
  current_version_id: string | null;
  last_error: string | null;
}

export interface Project {
  id: string;
  name: string;
  category: string | null;
  settings: { formats?: string[]; cinematic?: { camera?: string; style?: string; transition?: string; custom_text?: string } };
  languages: string[];
  artifacts: Artifact[];
}

export const STATE_LABEL: Record<State, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  needs_revision: 'Needs revision',
  rejected: 'Rejected',
  failed: 'Failed',
};

export const LANG_LABEL: Record<string, string> = { en: 'English', tl: 'Tagalog', taglish: 'Taglish' };
export const langName = (c: string) => LANG_LABEL[c] ?? c;
export const FORMAT_LABEL: Record<string, string> = { vertical_9x16: 'Vertical 9:16', horizontal_16x9: 'Horizontal 16:9', square_1x1: 'Square 1:1' };
export const formatName = (f: string) => FORMAT_LABEL[f] ?? f;
export const ASSET_TYPES = ['ai_image', 'stock_photo', 'stock_video', 'illustration', 'background', 'map', 'infographic', 'icon', 'character', 'prop', 'motion_graphic', 'text_overlay'];
export const SECTION_KINDS = ['hook', 'intro', 'main', 'payoff', 'cta', 'other'];
