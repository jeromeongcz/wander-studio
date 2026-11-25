// Storyboard sketch frames: Claude (with no tools) draws one vector illustration per scene. The vector file is untrusted
// model output, so it is checked against an allow-list before it is turned into a PNG and recorded as an asset.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import { ffmpegBinary, run } from '../media.ts';
import { rasterCommands } from '../platform.ts';
import type { Studio } from '../services.ts';
import type { JobCtx } from '../jobs.ts';
import { ulid } from '../../../shared/src/index.ts';
import type { Scene, StoryboardContent } from '../studios/storyboard.ts';
import type { ScriptContent } from '../studios/script.ts';
import { profileFor } from '../studios/storyboard.ts';

export const FRAME: Record<string, { w: number; h: number }> = { vertical_9x16: { w: 1080, h: 1920 }, horizontal_16x9: { w: 1920, h: 1080 }, square_1x1: { w: 1080, h: 1080 } };
const MAX_SVG = 600_000; // detailed artwork is large; still bounded so a runaway answer cannot fill the disk
// Technical safety, not art direction: only inert drawing elements may appear. Nothing here can run code, load a file or
// reach the network (no script, style, image, feImage, foreignObject, animate, a). Text and richer filters are drawing
// features and are allowed; any href must still point inside the drawing (checked below).
const SHAPES = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'use', 'symbol', 'marker', 'title', 'desc'];
const PAINT = ['lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern'];
const TEXT = ['text', 'tspan', 'textpath'];
const FILTERS = [
  'filter', 'fegaussianblur', 'feoffset', 'femerge', 'femergenode', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'feturbulence',
  'fedisplacementmap', 'fedropshadow', 'fecomponenttransfer', 'fefuncr', 'fefuncg', 'fefuncb', 'fefunca', 'femorphology', 'fetile',
  'fespecularlighting', 'fediffuselighting', 'fedistantlight', 'fepointlight', 'fespotlight',
];
const TAGS = new Set([...SHAPES, ...PAINT, ...TEXT, ...FILTERS]);

const bad = (m: string) => new EngineError('PROVIDER_ERROR', m);

/** Pull the drawing out of an answer and refuse anything that could run code, load a file or reach the network. */
export function checkSvg(answer: string, size: { w: number; h: number }): string {
  const start = answer.indexOf('<svg');
  const end = answer.lastIndexOf('</svg>');
  if (start < 0 || end < start) throw bad('The answer did not contain a complete drawing');
  const svg = answer.slice(start, end + 6);
  if (svg.length > MAX_SVG) throw bad('The drawing is too large');
  if (/<!|<\?/.test(svg.replace(/<!--[\s\S]*?-->/g, ''))) throw bad('The drawing contains declarations that are not allowed');
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(body)) throw bad('The drawing contains an unknown entity');
  for (const m of body.matchAll(/<\s*\/?\s*([^\s/>]+)/g)) if (!TAGS.has(m[1].toLowerCase())) throw bad(`The drawing uses "${m[1].slice(0, 30)}", which is not allowed`);
  for (const m of body.matchAll(/([^\s=<>"'/]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
    const name = m[1].toLowerCase();
    const value = m[2].replace(/^["']|["']$/g, '').trim();
    if (name.startsWith('on')) throw bad('The drawing contains a script handler');
    if (name.endsWith('href') && !value.startsWith('#')) throw bad('The drawing links to something outside itself');
    if (name !== 'xmlns' && !name.startsWith('xmlns:') && /(javascript:|data:|https?:|file:|@import|\\)/i.test(value)) throw bad('The drawing refers to something outside itself');
    for (const u of value.matchAll(/url\s*\(\s*["']?\s*([^)"']*)/gi)) if (!u[1].startsWith('#')) throw bad('The drawing refers to something outside itself');
  }
  // fix the canvas size so the picture always comes out at the video's dimensions
  const open = body.slice(0, body.indexOf('>') + 1);
  const attrs = open.replace(/^<svg/, '').replace(/\/?>$/, '').replace(/\s(width|height|xmlns)\s*=\s*("[^"]*"|'[^']*')/g, '');
  const viewBox = /\sviewBox\s*=/.test(attrs) ? '' : ` viewBox="0 0 ${size.w} ${size.h}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}"${viewBox}${attrs}>${body.slice(open.length)}`;
}

/** Bump when the brief changes in a way that changes what Claude is asked to do; recorded in every asset's params. */
export const SKETCH_PROMPT_VERSION = 3;

export interface SketchPromptOptions {
  size: { w: number; h: number };
  category?: string;
  number: number;
  total: number;
  styleNotes?: string;
  /** Only when the project asks for it: keep the lower fifth quiet so subtitles stay readable. */
  captionSpace?: boolean;
  /** Neighbouring scenes (title and narration), so the picture knows what came before and what follows. */
  previous?: { title: string; text?: string };
  next?: { title: string; text?: string };
  /** Characters of the script whose fixed look must be kept. Only entries that exist in the project. */
  cast?: { name: string; description: string }[];
}

const clip = (t: string | undefined, n = 240) => {
  const x = (t ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};
const neighbour = (label: string, n: SketchPromptOptions['previous'], none: string) => (n ? `${label}: "${clip(n.title, 80)}"${n.text ? `, narration "${clip(n.text)}"` : ''}` : `${label}: ${none}`);

/**
 * The whole visual-direction brief for one scene, sent in the single Claude Code call that draws it. Claude is asked to do
 * the directing silently and answer with the SVG only. Artistic decisions are left to it; the few rules in the last section
 * are technical and mirror checkSvg.
 */
export function buildSketchPrompt(scene: Scene, o: SketchPromptOptions): string {
  const { profile } = profileFor(o.category);
  const style = scene.visual_style || profile.styles[0];
  const cam = scene.camera?.movement && scene.camera.movement !== 'static' ? `${scene.camera.movement.replace('_', ' ')}${scene.camera.direction ? ` (${scene.camera.direction.replace(/_/g, ' ')})` : ''}, ${scene.camera.intensity ?? 'subtle'}` : '';
  return [
    `You are, in one person, the visual director, cinematic storyboard artist, professional 2D illustrator, character designer, environment artist and lighting artist of a faceless video. Illustrate scene ${o.number} of ${o.total} as one finished SVG, ${o.size.w}x${o.size.h}. Do all the directing in your head first; your answer is the SVG only.`,
    '',
    'SCENE BRIEF',
    `Title: ${clip(scene.title, 100)}`,
    ...(scene.segment_text ? [`Narration heard over this scene: "${clip(scene.segment_text, 400)}"`] : []),
    neighbour('Just before', o.previous, 'nothing, this is the opening scene'),
    neighbour('Right after', o.next, 'nothing, this is the closing scene'),
    `What to show:\n${scene.visual_description}`,
    ...(scene.notes?.trim() ? [`Director's notes: ${clip(scene.notes, 400)}`] : []),
    `Art style: ${style}.${o.styleNotes ? ` Project style notes: ${clip(o.styleNotes, 400)}.` : ''}`,
    ...(cam ? [`In the edit this picture is animated with a camera move (${cam}) over about ${scene.target_duration} s: leave room for that move and keep important detail away from the frame edge.`] : []),
    ...(o.cast?.length ? ['Established characters (keep these designs exactly, do not redesign them):', ...o.cast.map((c) => `- ${clip(c.name, 60)}: ${clip(c.description, 400)}`)] : []),
    'Use only what is given here. Where the brief is silent, make the choice that best serves the story, but do not add named characters or story events that are not in it.',
    '',
    'THINK FIRST (silently)',
    'What is happening, what led to it, what comes next, and what is this scene for? Who or what is the primary subject, who is secondary, how do they relate, what is the emotional tone, what is the one idea the viewer must get, and what should they notice first? Do not just turn the description into a list of objects; make the picture tell the story.',
    '',
    'COMPOSITION AND FRAMING',
    'Decide the shot type (establishing, extreme wide, wide, full, medium wide, medium, medium close-up, close-up, extreme close-up, over-the-shoulder, point-of-view), the angle (eye level, low, high, bird\'s-eye, worm\'s-eye) and the distance, because they serve this scene, not at random. Place the subject deliberately and work out foreground, midground and background, visual hierarchy, focal point, leading lines, balance, negative space, depth, perspective, subject scale against the environment and a readable silhouette. Vary the treatment from scene to scene while keeping the project\'s look.',
    '',
    'CHARACTERS',
    'For every character decide identity, body proportions, face, hair, clothing, accessories, colours, pose, gesture, expression, eye direction, body orientation, emotional state and place in the frame. Make the pose show the action: weight and stride when walking, forward momentum when running, real contact and weight when sitting, clear head and eye direction when looking, a plausible arm line when reaching, a believable grip when holding, expressive face and body when talking or reacting. Intentional silhouettes, natural anatomy, expressive faces. No stick figures, no missing limbs or hands, no inconsistent proportions, and keep each character the same from scene to scene.',
    '',
    'ENVIRONMENT',
    'Design the place as a real space: architecture or terrain, props, environmental storytelling, atmospheric perspective, weather, time of day, texture, and clear separation between depth layers. Do not leave backgrounds empty unless the scene calls for minimalism, and keep background detail from competing with the main subject.',
    '',
    'LIGHT AND COLOUR',
    'Choose the key light, fill, rim light, ambient light, shadows, highlights, colour temperature, contrast and light direction from the mood the story needs (for example warm and welcoming, cold and isolated, dark and mysterious, tense, bright and energetic, dreamlike), and let the light carry the story and the depth. Keep the palette controlled.',
    '',
    'ILLUSTRATION QUALITY AND STYLE',
    'It should look like a professionally art-directed 2D animation frame, not a rough sketch or a diagram: carefully built shapes, organic curves, detailed silhouettes, deliberate line weight, layered shading, highlights and shadows, gradients and texture where they help, refined faces, rich environment detail. Follow the art style above for line quality, shape language, colour treatment, shading, detail density and texture, and do not mix incompatible styles. Do not force a flat geometric look unless the style asks for it. Avoid placeholder circles and rectangles, random decoration, lifeless flat compositions and accidental empty areas. Keep lettering out unless the story needs it (a sign that matters, for example); if you include it, spell it exactly.',
    '',
    'BUILT FOR ANIMATION',
    'Group the picture into clearly named layers and parts, for example <g id="background">, <g id="midground">, <g id="foreground">, and one <g id="character-name"> per character (with sub-groups such as head, arms, torso). Keep characters distinct from the background, keep their silhouettes readable, do not merge unrelated objects into one shape, avoid needless overlap, keep proportions consistent, and leave room for the intended movement and for parallax.',
    ...(o.captionSpace ? ['', 'Subtitles will be laid over the bottom fifth of this frame, so keep that area calm and free of important detail.'] : []),
    '',
    'TECHNICAL FORMAT (the file is checked before it is used)',
    `- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.size.w} ${o.size.h}"> and fill the whole canvas.`,
    '- Allowed elements: svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, use, symbol, marker, title, desc, text, tspan, textPath, linearGradient, radialGradient, stop, clipPath, mask, pattern, and filter with its fe* primitives (blur, offset, merge, blend, colour matrix, component transfer, composite, flood, morphology, turbulence, displacement map, drop shadow, lighting).',
    '- Style with presentation attributes or style="" attributes. No <style> blocks, CSS classes, scripts, event handlers, animation, images, foreignObject or links. Every href and url() must point to an id inside this drawing. Escape &, < and > in text.',
    '- For text use common font stacks such as Georgia, serif / Arial, sans-serif / Impact, sans-serif.',
    '- Define repeated shapes once in defs and reuse them. Aim for roughly 40 to 250 kilobytes of SVG and never more than 500; spend the detail where the eye goes.',
    '- Answer with the SVG only, with no explanation before or after it.',
  ].join('\n');
}

/** Turn the checked drawing into a PNG with whatever this computer has (see rasterCommands). */
export async function rasterize(svgPath: string, pngPath: string, ffmpeg: string) {
  const errors: string[] = [];
  for (const c of rasterCommands(svgPath, pngPath, ffmpeg)) {
    try {
      await run(c.bin, c.args, { timeout: 60_000 });
      if (existsSync(pngPath)) return;
    } catch (e) {
      errors.push((e as Error).message.slice(0, 160));
    }
  }
  const fix = process.platform === 'darwin' ? '' : ' Install an FFmpeg build with librsvg (SVG support), or rsvg-convert.';
  throw bad(`Could not turn the drawing into a picture.${fix} ${errors.join(' | ')}`);
}

export class SketchArtist {
  s: Studio;
  constructor(studio: Studio) {
    this.s = studio;
  }

  private storyboard(storyboardId: string) {
    const a = this.s.engine.get(storyboardId);
    if (a.kind !== 'storyboard') throw new EngineError('VALIDATION', 'Not a storyboard');
    return { a, content: this.s.engine.getContent(a.id) as StoryboardContent | null };
  }

  /** What each scene currently shows. */
  list(storyboardId: string) {
    const { a, content } = this.storyboard(storyboardId);
    const arts = this.s.engine.list(a.project_id, { kind: 'scene_asset' });
    return (content?.scenes ?? []).map((scene) => {
      const art = arts.find((x) => x.scene_id === scene.scene_id);
      const c = art ? (this.s.engine.getContent(art.id) as { primary_asset_id?: string } | null) : null;
      return { scene_id: scene.scene_id!, artifact_id: art?.id ?? null, state: art?.state ?? 'not_started', asset_id: c?.primary_asset_id ?? null };
    });
  }

  /**
   * Queue drawing. `indexes` are scene positions (0-based); left out, every scene without a picture. A missing storyboard
   * is first built from the approved script.
   */
  start(storyboardId: string, o: { indexes?: unknown; reopen?: boolean; captionSpace?: boolean } = {}) {
    let { a, content } = this.storyboard(storyboardId);
    if (!content) {
      this.s.seedStoryboard(storyboardId);
      ({ a, content } = this.storyboard(storyboardId));
    }
    const rows = this.list(storyboardId);
    let picked: number[];
    if (o.indexes === undefined) picked = rows.flatMap((r, i) => (r.asset_id ? [] : [i]));
    else {
      if (!Array.isArray(o.indexes) || !o.indexes.every((i) => Number.isInteger(i) && i >= 0 && i < rows.length)) throw new EngineError('VALIDATION', 'Unknown scene');
      picked = [...new Set(o.indexes as number[])];
    }
    if (!picked.length) throw new EngineError('VALIDATION', 'Every scene already has a picture. Redraw a single scene if you want a new one.');
    const protectedOnes = picked.filter((i) => rows[i].state === 'approved');
    if (protectedOnes.length && !o.reopen) throw new EngineError('PROTECTED', `Scene ${protectedOnes[0] + 1} is approved; pass reopen to replace its picture`);
    const busy = this.s.engine.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND kind = 'sketch_scenes' AND state IN ('queued','running')").get(a.project_id) as { n: number };
    if (busy.n) throw new EngineError('BUSY', 'Scenes are already being drawn. Wait for that to finish or cancel it.');
    const job = this.s.jobs.enqueue('sketch_scenes', { projectId: a.project_id, artifactId: a.id, params: { storyboardId, sceneIds: picked.map((i) => rows[i].scene_id), reopen: o.reopen === true, captionSpace: typeof o.captionSpace === 'boolean' ? o.captionSpace : undefined } });
    return { job, scenes: picked.length };
  }

  async run(ctx: JobCtx) {
    const { storyboardId, sceneIds, reopen, captionSpace } = ctx.params as { storyboardId: string; sceneIds: string[]; reopen?: boolean; captionSpace?: boolean };
    const st = await this.s.research.bridge.status();
    if (!st.installed || !st.loggedIn) throw bad(`${st.detail}. ${st.fix ?? ''}`.trim());
    let drawn = 0;
    const failed: string[] = [];
    for (const [n, sceneId] of sceneIds.entries()) {
      if (ctx.signal.aborted) throw new EngineError('CANCELLED', `Cancelled after ${drawn} picture(s)`);
      const { a, content } = this.storyboard(storyboardId);
      const index = content?.scenes.findIndex((s) => s.scene_id === sceneId) ?? -1;
      if (index < 0) continue; // removed while we were working
      ctx.progress(n / sceneIds.length, `Drawing scene ${index + 1} (${n + 1} of ${sceneIds.length}). Finished pictures are kept if you cancel.`);
      try {
        await this.draw(a.project_id, content!, index, { reopen, captionSpace, signal: ctx.signal });
        drawn++;
      } catch (e) {
        if ((e as EngineError).code === 'CANCELLED') throw e;
        failed.push(`Scene ${index + 1}: ${(e as Error).message}`);
        ctx.log(failed[failed.length - 1], 'warn');
      }
    }
    if (failed.length) throw bad(`Drew ${drawn} of ${sceneIds.length}. ${failed.slice(0, 3).join(' | ')}`);
    return { drawn };
  }

  private neighbour(s?: Scene) {
    return s ? { title: s.title, text: s.segment_text } : undefined;
  }

  /** The script's cast members this scene is about: named in the scene, and not already described in full in its description. */
  private cast(projectId: string, scene: Scene) {
    const base = this.s.engine.list(projectId, { kind: 'script_base' })[0];
    const cast = (base ? (this.s.engine.getContent(base.id) as ScriptContent | null)?.characters : undefined) ?? [];
    const text = `${scene.visual_description} ${scene.segment_text ?? ''} ${scene.title}`.toLowerCase();
    return cast.filter((c) => c.name.trim() && c.description.trim() && text.includes(c.name.trim().toLowerCase()) && !scene.visual_description.includes(c.description.trim()));
  }

  private async draw(projectId: string, sb: StoryboardContent, index: number, o: { reopen?: boolean; captionSpace?: boolean; signal?: AbortSignal }) {
    const project = this.s.engine.getProject(projectId);
    const format = (project.settings.formats as string[] | undefined)?.[0] ?? 'vertical_9x16';
    const size = FRAME[format] ?? FRAME.vertical_9x16;
    const scene = sb.scenes[index];
    const captionSpace = o.captionSpace ?? project.settings.reserve_caption_space === true;
    const prompt = buildSketchPrompt(scene, {
      size, category: project.category ?? undefined, number: index + 1, total: sb.scenes.length, styleNotes: sb.style_notes, captionSpace,
      previous: this.neighbour(sb.scenes[index - 1]), next: this.neighbour(sb.scenes[index + 1]), cast: this.cast(projectId, scene),
    });
    const svg = checkSvg(await this.s.research.bridge.ask(prompt, { noTools: true, signal: o.signal }), size);
    const dir = join(this.s.config.root, 'cache', `sketch_${ulid()}`);
    await mkdir(dir, { recursive: true });
    try {
      const src = join(dir, 'frame.svg');
      const png = join(dir, 'frame.png');
      await writeFile(src, svg);
      await rasterize(src, png, ffmpegBinary(this.s.config.ffprobePath));
      const asset = await this.s.assets.importLocal(projectId, png, {
        type: 'illustration',
        name: `Sketch: scene ${index + 1}`,
        license: { type: 'ai-generated', commercial_use: 'unknown', notes: 'Storyboard sketch drawn by Claude from your script. Check your Claude plan terms before commercial use.' },
        provider: 'claude-sketch',
        prompt: scene.visual_description,
        tags: ['storyboard-sketch'],
        params: { scene_id: scene.scene_id, prompt_version: SKETCH_PROMPT_VERSION, caption_space: captionSpace },
      });
      const art = this.s.engine.list(projectId, { kind: 'scene_asset' }).find((x) => x.scene_id === scene.scene_id)!;
      this.s.save(art.id, { assets: [{ asset_id: asset.id, role: 'primary' }], primary_asset_id: asset.id }, { actor: 'ai', reopen: o.reopen });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
