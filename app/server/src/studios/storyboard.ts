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

const CATEGORIES: Record<string, CategoryProfile> = {
  Documentary: { assets: ['stock_video', 'stock_photo', 'map', 'infographic'], styles: ['cinematic realism', 'muted colour grade'], cameras: ['ken_burns', 'pan', 'zoom'], transition: 'dissolve', hint: 'Documentary footage or photograph of' },
  History: { assets: ['stock_photo', 'map', 'illustration', 'ai_image'], styles: ['archival sepia', 'period illustration'], cameras: ['ken_burns', 'pan', 'zoom'], transition: 'dissolve', hint: 'Archival photo, historical map or period illustration of', notes: 'Label reconstructions as such; check licences on archival images.' },
  Mysteries: { assets: ['ai_image', 'stock_photo', 'background', 'text_overlay'], styles: ['moody low-key lighting', 'atmospheric fog'], cameras: ['zoom', 'parallax', 'pan'], transition: 'fade', hint: 'Atmospheric, moody image of' },
  Science: { assets: ['infographic', 'illustration', 'motion_graphic', 'stock_video'], styles: ['clean labelled diagram', 'flat vector'], cameras: ['static', 'zoom', 'pan'], transition: 'cut', hint: 'Clean diagram or labelled illustration of' },
  Technology: { assets: ['motion_graphic', 'stock_video', 'infographic', 'icon'], styles: ['sleek high-contrast UI', 'accent glow'], cameras: ['zoom', 'parallax', 'static'], transition: 'slide', hint: 'Sleek screen, device or interface visual of' },
  Education: { assets: ['infographic', 'illustration', 'icon', 'text_overlay'], styles: ['clear friendly flat design'], cameras: ['static', 'zoom', 'pan'], transition: 'cut', hint: 'Simple explanatory graphic of' },
  Psychology: { assets: ['illustration', 'ai_image', 'background', 'text_overlay'], styles: ['soft abstract', 'muted pastel'], cameras: ['zoom', 'parallax', 'ken_burns'], transition: 'dissolve', hint: 'Soft abstract or metaphorical visual of' },
  'Motivational Stories': { assets: ['stock_video', 'stock_photo', 'ai_image', 'text_overlay'], styles: ['cinematic landscape', 'golden hour', 'kinetic typography'], cameras: ['ken_burns', 'zoom', 'parallax'], transition: 'dissolve', hint: 'Cinematic, emotive visual of' },
  Travel: { assets: ['stock_video', 'stock_photo', 'map', 'background'], styles: ['vibrant natural light'], cameras: ['pan', 'ken_burns', 'parallax'], transition: 'dissolve', hint: 'Scenic footage or photo of', notes: 'Use a route/geographic map when the script names places.' },
  Nature: { assets: ['stock_video', 'stock_photo', 'illustration'], styles: ['natural light', 'macro detail'], cameras: ['ken_burns', 'pan', 'parallax'], transition: 'dissolve', hint: 'Nature footage or photograph of' },
  Adventure: { assets: ['stock_video', 'stock_photo', 'map'], styles: ['dynamic, high energy'], cameras: ['pan', 'zoom', 'parallax'], transition: 'cut', hint: 'Dynamic outdoor footage of' },
  Biographies: { assets: ['stock_photo', 'illustration', 'map', 'text_overlay'], styles: ['portrait-focused', 'period-appropriate'], cameras: ['ken_burns', 'zoom', 'pan'], transition: 'dissolve', hint: 'Portrait or period image of' },
  'Fictional Storytelling': { assets: ['character', 'background', 'illustration', 'prop'], styles: ['consistent illustrated characters'], cameras: ['parallax', 'pan', 'zoom'], transition: 'dissolve', hint: 'Illustrated scene featuring', notes: 'Keep a character sheet so characters stay consistent across scenes; optional character motion.' },
  'Interesting Facts': { assets: ['ai_image', 'stock_photo', 'infographic', 'text_overlay'], styles: ['bold punchy visuals'], cameras: ['zoom', 'ken_burns', 'static'], transition: 'cut', hint: 'Bold, eye-catching visual of' },
  'Horror & Folklore': { assets: ['ai_image', 'illustration', 'background', 'text_overlay'], styles: ['near-black teal palette lit by one amber or cold source', 'thick-outline gritty cartoon horror', 'glowing eyes in darkness'], cameras: ['zoom', 'ken_burns', 'pan'], transition: 'cut', hint: 'Dark, moody illustration with a single practical light source of', notes: 'Hard cuts, one picture per sentence, slow linear camera on every shot, creature reveal close-up around 5s. See docs/style/dark-folklore-shorts.md.' },
  'Urban Legends': { assets: ['ai_image', 'illustration', 'stock_photo', 'text_overlay'], styles: ['found-footage grain', 'low-light street scenes'], cameras: ['zoom', 'pan', 'static'], transition: 'cut', hint: 'Eerie everyday location at night showing' },
  'Filipino Folklore': { assets: ['illustration', 'ai_image', 'background', 'map'], styles: ['tropical night, bamboo and nipa huts', 'moonlit barrio', 'warm lantern accents'], cameras: ['ken_burns', 'pan', 'zoom'], transition: 'dissolve', hint: 'Illustrated Philippine setting, such as a barrio, forest or river, with', notes: 'Name creatures and places the way the story tellers do, and have a Filipino speaker check the wording.' },
  Mythology: { assets: ['illustration', 'ai_image', 'map', 'background'], styles: ['epic painterly', 'bronze and gold accents'], cameras: ['ken_burns', 'zoom', 'pan'], transition: 'dissolve', hint: 'Epic illustration of' },
  'True Crime': { assets: ['stock_photo', 'map', 'text_overlay', 'illustration'], styles: ['desaturated documentary', 'evidence-board graphics'], cameras: ['ken_burns', 'zoom', 'static'], transition: 'cut', hint: 'Sober documentary image or map of', notes: 'Keep to verified facts and avoid identifying private individuals.' },
  'Space & Astronomy': { assets: ['illustration', 'infographic', 'stock_video', 'motion_graphic'], styles: ['deep-space gradients', 'clean scientific diagram'], cameras: ['zoom', 'ken_burns', 'parallax'], transition: 'fade', hint: 'Space illustration or diagram of' },
  'Health & Wellness': { assets: ['infographic', 'illustration', 'stock_video', 'icon'], styles: ['calm, bright, friendly'], cameras: ['static', 'zoom', 'pan'], transition: 'cut', hint: 'Simple friendly graphic of', notes: 'Cite sources for health claims; this is not medical advice.' },
  'Finance & Business': { assets: ['infographic', 'motion_graphic', 'icon', 'stock_photo'], styles: ['clean data visuals', 'bold numbers'], cameras: ['static', 'zoom', 'pan'], transition: 'slide', hint: 'Clean chart or graphic of', notes: 'Show sources and avoid personal financial advice.' },
  Sports: { assets: ['stock_video', 'stock_photo', 'motion_graphic', 'infographic'], styles: ['dynamic, high contrast'], cameras: ['pan', 'zoom', 'parallax'], transition: 'cut', hint: 'Action image of' },
  'Food & Cooking': { assets: ['stock_video', 'stock_photo', 'illustration', 'text_overlay'], styles: ['warm, close-up, appetising'], cameras: ['zoom', 'ken_burns', 'pan'], transition: 'cut', hint: 'Close-up food shot of' },
  'Animals & Pets': { assets: ['stock_video', 'stock_photo', 'illustration', 'infographic'], styles: ['natural light, close and friendly'], cameras: ['ken_burns', 'zoom', 'pan'], transition: 'dissolve', hint: 'Close photo or footage of' },
  Gaming: { assets: ['motion_graphic', 'ai_image', 'text_overlay', 'icon'], styles: ['neon accents', 'pixel and UI motifs'], cameras: ['zoom', 'parallax', 'pan'], transition: 'cut', hint: 'Game-style visual of' },
  'Movies & TV': { assets: ['illustration', 'text_overlay', 'stock_photo', 'motion_graphic'], styles: ['cinematic, title-card feel'], cameras: ['zoom', 'ken_burns', 'pan'], transition: 'cut', hint: 'Cinematic still-style image of', notes: 'Do not use copyrighted stills or clips without a licence; prefer original illustrations.' },
  'Music & Arts': { assets: ['illustration', 'ai_image', 'background', 'motion_graphic'], styles: ['expressive colour', 'stage lighting'], cameras: ['zoom', 'parallax', 'ken_burns'], transition: 'dissolve', hint: 'Expressive illustration of' },
  Philosophy: { assets: ['illustration', 'background', 'text_overlay', 'ai_image'], styles: ['minimal, symbolic, high contrast'], cameras: ['ken_burns', 'zoom', 'static'], transition: 'fade', hint: 'Symbolic, minimal image of' },
  'How-To & Life Hacks': { assets: ['infographic', 'icon', 'stock_video', 'text_overlay'], styles: ['step-by-step, clear numbered graphics'], cameras: ['static', 'zoom', 'pan'], transition: 'cut', hint: 'Clear step graphic showing' },
  'News & Current Events': { assets: ['stock_photo', 'map', 'infographic', 'text_overlay'], styles: ['neutral, factual'], cameras: ['static', 'ken_burns', 'zoom'], transition: 'cut', hint: 'Neutral documentary image of', notes: 'Attribute sources and keep opinion separate from fact.' },
  'Comedy & Skits': { assets: ['character', 'illustration', 'text_overlay', 'background'], styles: ['bright, exaggerated, expressive characters'], cameras: ['zoom', 'static', 'pan'], transition: 'cut', hint: 'Exaggerated cartoon scene of', notes: 'Keep character sheets so characters stay consistent.' },
  'Philippine History': { assets: ['stock_photo', 'map', 'illustration', 'text_overlay'], styles: ['archival sepia', 'period illustration'], cameras: ['ken_burns', 'pan', 'zoom'], transition: 'dissolve', hint: 'Archival photo, historical map or period illustration of', notes: 'Label reconstructions as such; check licences on archival images.' },
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
