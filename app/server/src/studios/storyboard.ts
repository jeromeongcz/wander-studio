import { EngineError } from '../engine.ts';
import { estimate, PRESETS } from './estimator.ts';
import type { CalibrationSample } from './estimator.ts';
import type { ScriptContent } from './script.ts';

export const ASSET_TYPES = [
  'ai_image',
  'stock_photo',
  'stock_video',
  'illustration',
  'background',
  'map',
  'infographic',
  'icon',
  'character',
  'prop',
  'motion_graphic',
  'text_overlay',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const MOVEMENTS = ['static', 'pan', 'zoom', 'ken_burns', 'parallax'] as const;
export type Movement = (typeof MOVEMENTS)[number];
export const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slide', 'zoom', 'wipe'] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const INTENSITIES = ['subtle', 'medium', 'strong'] as const;

export interface Scene {
  scene_id?: string; // assigned by the server on first save; immutable afterwards
  order_index?: number; // derived from array position on save
  title: string;
  script_segment_id: string; // base-script section this scene visualises
  segment_text?: string;
  target_duration: number; // seconds; initial estimate, superseded by measured audio per language
  visual_description: string;
  visual_style?: string;
  asset_type: AssetType;
  camera: { movement: Movement; direction?: string; intensity?: (typeof INTENSITIES)[number] };
  transition_in?: Transition;
  transition_out?: Transition;
  sfx_cues?: string[];
  notes?: string;
  draft?: boolean; // true for auto-generated skeletons that still need a creative pass
}
export interface StoryboardContent {
  category?: string;
  style_notes?: string;
  scenes: Scene[];
}

// ---- category-aware recommendations (plan section 5.2). Starting points; the user overrides per scene. ----
export interface CategoryProfile {
  assets: AssetType[];
  styles: string[];
  cameras: Movement[];
  transition: Transition;
  hint: string;
  notes?: string;
}

/**
 * The project categories. Anything else a person types is a custom category and gets general defaults.
 * Country or region is not a category: put it in the research focus (e.g. "Philippines", "Visayas", "Japan").
 */
const CATEGORIES: Record<string, CategoryProfile> = {
  'Philippine History': { assets: ['stock_photo', 'map', 'illustration', 'text_overlay'], styles: ['archival sepia', 'period illustration'], cameras: ['ken_burns', 'pan', 'zoom'], transition: 'dissolve', hint: 'Archival photo, historical map or period illustration of', notes: 'Label reconstructions as such and check licences on archival images. Give dates and name the sources.' },
  'Mythology and Folklore': { assets: ['illustration', 'ai_image', 'background', 'character'], styles: ['painterly illustration', 'moonlit, one light source', 'carved-wood and woven-pattern borders'], cameras: ['ken_burns', 'zoom', 'pan'], transition: 'dissolve', hint: 'Illustration of a folklore scene with', notes: 'Say which region or community a story comes from, present it as tradition rather than fact, and keep recurring characters looking the same with a character sheet. Have a cultural reviewer check names and spellings.' },
  'Culture and Traditions': { assets: ['stock_photo', 'stock_video', 'illustration', 'text_overlay'], styles: ['warm natural light', 'woven patterns and festival colour'], cameras: ['ken_burns', 'pan', 'parallax'], transition: 'dissolve', hint: 'Warm documentary image of a tradition showing', notes: 'Traditions vary by region and family: say where a practice is from, and avoid presenting one version as the only one.' },
  'Food Origins': { assets: ['stock_photo', 'illustration', 'map', 'infographic'], styles: ['warm, close-up, appetising', 'old trade-route maps'], cameras: ['zoom', 'ken_burns', 'pan'], transition: 'dissolve', hint: 'Close-up food shot or origin map of', notes: 'Food origins are often disputed: show who documents each claim and avoid saying a dish was "invented by" someone unless that is documented.' },
  Geography: { assets: ['map', 'stock_video', 'infographic', 'illustration'], styles: ['clean labelled maps', 'aerial and landscape footage'], cameras: ['zoom', 'pan', 'ken_burns'], transition: 'cut', hint: 'Map, aerial footage or diagram of', notes: 'Give figures with the year and an official source, because counts, areas and populations change.' },
  Superstitions: { assets: ['ai_image', 'illustration', 'background', 'text_overlay'], styles: ['eerie but playful', 'candlelit and moonlit', 'folk-art motifs'], cameras: ['zoom', 'ken_burns', 'pan'], transition: 'cut', hint: 'Atmospheric illustration of a folk belief about', notes: 'Present superstitions as beliefs, say where they are from, and give the documented origin if there is one.' },
};
const FALLBACK: CategoryProfile = { assets: ['stock_photo', 'ai_image', 'illustration', 'text_overlay'], styles: ['clean and readable'], cameras: ['ken_burns', 'zoom', 'pan'], transition: 'cut', hint: 'Relevant visual of' };

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const INDEX = new Map(Object.entries(CATEGORIES).map(([k, v]) => [norm(k), { name: k, profile: v }]));

export function listCategories(): { name: string; profile: CategoryProfile }[] {
  return [...INDEX.values()];
}

export function profileFor(category?: string | null): { name: string; custom: boolean; profile: CategoryProfile } {
  const hit = category ? INDEX.get(norm(category)) : undefined;
  return hit ? { ...hit, custom: false } : { name: category?.trim() || 'Custom', custom: true, profile: FALLBACK };
}

// ---- validation ----
const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function validateStoryboardShape(content: unknown): StoryboardContent {
  if (!isObj(content) || !Array.isArray(content.scenes)) throw bad('Storyboard must be an object with a scenes array');
  const ids = new Set<string>();
  content.scenes.forEach((s: unknown, i: number) => {
    const at = `Scene ${i + 1}`;
    if (!isObj(s)) throw bad(`${at} must be an object`);
    if (typeof s.title !== 'string' || !s.title.trim()) throw bad(`${at} needs a title`);
    if (typeof s.script_segment_id !== 'string' || !s.script_segment_id) throw bad(`${at} needs script_segment_id`);
    if (typeof s.target_duration !== 'number' || !(s.target_duration >= 0.5 && s.target_duration <= 120)) throw bad(`${at} target_duration must be 0.5-120 seconds`);
    if (typeof s.visual_description !== 'string') throw bad(`${at} needs visual_description`);
    if (!ASSET_TYPES.includes(s.asset_type as AssetType)) throw bad(`${at} has invalid asset_type`);
    if (!isObj(s.camera) || !MOVEMENTS.includes(s.camera.movement as Movement)) throw bad(`${at} has invalid camera.movement`);
    if (s.camera.intensity !== undefined && !INTENSITIES.includes(s.camera.intensity as never)) throw bad(`${at} has invalid camera.intensity`);
    for (const k of ['transition_in', 'transition_out'] as const) {
      if (s[k] !== undefined && !TRANSITIONS.includes(s[k] as Transition)) throw bad(`${at} has invalid ${k}`);
    }
    if (s.sfx_cues !== undefined && !(Array.isArray(s.sfx_cues) && s.sfx_cues.every((x) => typeof x === 'string'))) throw bad(`${at} sfx_cues must be strings`);
    if (s.scene_id !== undefined) {
      if (typeof s.scene_id !== 'string' || !s.scene_id) throw bad(`${at} has invalid scene_id`);
      if (ids.has(s.scene_id)) throw bad(`Duplicate scene_id ${s.scene_id}`);
      ids.add(s.scene_id);
    }
  });
  return content as unknown as StoryboardContent;
}

export function storyboardReadiness(
  sb: StoryboardContent,
  base: ScriptContent,
  ctx: { samples: CalibrationSample[]; defaultWpm?: number },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (sb.scenes.length === 0) errors.push('Storyboard has no scenes');
  const sectionIds = new Set(base.sections.map((s) => s.id));
  const unknown = sb.scenes.filter((s) => !sectionIds.has(s.script_segment_id));
  if (unknown.length) errors.push(`Scene(s) point at script sections that do not exist: ${unknown.map((s) => s.title).join(', ')}`);
  const covered = new Set(sb.scenes.map((s) => s.script_segment_id));
  const uncovered = base.sections.filter((s) => s.text.trim() && !covered.has(s.id)).map((s) => s.id);
  if (uncovered.length) errors.push(`No scene covers script section(s): ${uncovered.join(', ')}`);
  const noVisual = sb.scenes.filter((s) => !s.visual_description.trim());
  if (noVisual.length) errors.push(`Scene(s) without a visual description: ${noVisual.map((s) => s.title).join(', ')}`);

  const total = sb.scenes.reduce((n, s) => n + s.target_duration, 0);
  const preset = PRESETS[base.preset];
  if (total > preset.hardMax) errors.push(`Scenes add up to ${Math.round(total)}s, over the ${preset.hardMax}s Shorts limit`);
  else if (Number.isFinite(preset.max) && total > preset.max) warnings.push(`Scenes add up to ${Math.round(total)}s, over the ${preset.label} range`);
  const est = estimate({ sections: base.sections, lang: base.lang, samples: ctx.samples, defaultWpm: ctx.defaultWpm }).seconds;
  if (est > 0 && Math.abs(total - est) / est > 0.25) warnings.push(`Scene durations (${Math.round(total)}s) differ from the script's estimated narration (${Math.round(est)}s) by more than 25%`);
  const drafts = sb.scenes.filter((s) => s.draft).length;
  if (drafts) warnings.push(`${drafts} scene(s) are still auto-generated skeletons; refine their visual descriptions (clear "draft" when done)`);
  if (base.preset.startsWith('short_') && sb.scenes.some((s) => s.target_duration > 8)) warnings.push('Some scenes run over 8s; Shorts usually need a visual change every 2-5s');
  return { errors, warnings };
}

// ---- deterministic draft from the approved base script ----
export function draftScenes(base: ScriptContent, category: string | undefined, opts: { samples: CalibrationSample[]; defaultWpm?: number; sceneSeconds?: number }): StoryboardContent {
  const { profile } = profileFor(category);
  const goal = opts.sceneSeconds ?? 4;
  const scenes: Scene[] = [];
  let lastMove: Movement | null = null;
  let flip = 0;

  for (const sec of base.sections) {
    const sentences = sec.text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
    const chunks: string[] = [];
    let cur = '';
    for (const sent of sentences) {
      const next = cur ? `${cur} ${sent}` : sent;
      const secs = estimate({ sections: [{ text: next }], lang: base.lang, samples: opts.samples, defaultWpm: opts.defaultWpm }).seconds;
      if (cur && secs > goal) {
        chunks.push(cur);
        cur = sent;
      } else cur = next;
    }
    if (cur) chunks.push(cur);

    for (const text of chunks) {
      const idx = scenes.length;
      const asset: AssetType = sec.kind === 'cta' ? 'text_overlay' : sec.kind === 'hook' ? profile.assets[0] : profile.assets[idx % profile.assets.length];
      const options = profile.cameras.filter((m) => m !== lastMove);
      const movement: Movement = asset === 'text_overlay' ? 'static' : options[idx % options.length] ?? profile.cameras[0];
      lastMove = movement;
      flip++;
      const dur = Math.max(1.5, estimate({ sections: [{ text }], lang: base.lang, samples: opts.samples, defaultWpm: opts.defaultWpm }).seconds);
      const words = text.split(/\s+/).slice(0, 5).join(' ');
      scenes.push({
        title: `${sec.kind[0].toUpperCase()}${sec.kind.slice(1)}: ${words}${text.split(/\s+/).length > 5 ? '…' : ''}`,
        script_segment_id: sec.id,
        segment_text: text,
        target_duration: Math.round(dur * 10) / 10,
        visual_description: `${profile.hint}: ${text}`,
        visual_style: profile.styles[idx % profile.styles.length],
        asset_type: asset,
        camera: {
          movement,
          direction: movement === 'pan' ? (flip % 2 ? 'left_to_right' : 'right_to_left') : movement === 'zoom' ? (sec.kind === 'hook' || flip % 2 ? 'in' : 'out') : movement === 'ken_burns' ? 'in' : undefined,
          intensity: sec.kind === 'hook' ? 'medium' : 'subtle',
        },
        transition_in: idx === 0 ? 'cut' : profile.transition,
        sfx_cues: [],
        draft: true,
      });
    }
  }
  return { category, scenes };
}

// ---- manual copy-paste LLM prompt (no runtime LLM required) ----
export function buildStoryboardPrompt(args: { category?: string; base: ScriptContent; notes?: string }): string {
  const { name, profile, custom } = profileFor(args.category);
  const isShort = args.base.preset.startsWith('short_');
  return [
    `You are planning the visuals for a faceless ${isShort ? 'YouTube Short (vertical 9:16)' : 'video'}. Category: ${name}${custom ? ' (custom category)' : ''}.`,
    '',
    `Suggested visual approach: prefer ${profile.assets.join(', ')}; styles such as ${profile.styles.join(', ')}; camera moves such as ${profile.cameras.join(', ')}.`,
    profile.notes ? `Category note: ${profile.notes}` : '',
    '',
    'Rules:',
    '- Break the script into scenes. Every script section with text must be covered by at least one scene.',
    `- ${isShort ? 'Aim for a new visual every 2-5 seconds.' : 'Pace scenes to the narration.'} target_duration is in seconds.`,
    `- asset_type must be one of: ${ASSET_TYPES.join(', ')}.`,
    `- camera.movement must be one of: ${MOVEMENTS.join(', ')}. Avoid repeating the same movement back to back.`,
    `- transition_in/out must be one of: ${TRANSITIONS.join(', ')}.`,
    '- visual_description must describe something that can actually be sourced or generated; do not invent facts not in the script.',
    '- Set script_segment_id to the id of the script section the scene visualises.',
    '- Return only JSON: {"scenes":[{"title":"","script_segment_id":"","target_duration":3,"visual_description":"","visual_style":"","asset_type":"","camera":{"movement":"","direction":"","intensity":"subtle"},"transition_in":"","sfx_cues":[]}]}',
    args.notes ? `\nExtra notes from the creator: ${args.notes}` : '',
    '',
    `Title: ${args.base.title}`,
    'Script sections:',
    JSON.stringify(args.base.sections.map(({ id, kind, text }) => ({ id, kind, text })), null, 2),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
