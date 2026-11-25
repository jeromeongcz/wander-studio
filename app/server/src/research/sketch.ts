// Storyboard sketch frames: Claude (with no tools) draws one vector illustration per scene. The vector file is untrusted
// model output, so it is checked against an allow-list before it is turned into a PNG and recorded as an asset.
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import type { Studio } from '../services.ts';
import type { JobCtx } from '../jobs.ts';
import { ulid } from '../../../shared/src/index.ts';
import type { Scene, StoryboardContent } from '../studios/storyboard.ts';
import { profileFor } from '../studios/storyboard.ts';

export const FRAME: Record<string, { w: number; h: number }> = { vertical_9x16: { w: 1080, h: 1920 }, horizontal_16x9: { w: 1920, h: 1080 }, square_1x1: { w: 1080, h: 1080 } };
const MAX_SVG = 400_000;
const TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'use', 'symbol', 'title', 'desc', 'filter', 'fegaussianblur', 'feoffset', 'femerge', 'femergenode', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'feturbulence', 'fedisplacementmap', 'fedropshadow']);

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

export function buildSketchPrompt(scene: Scene, o: { size: { w: number; h: number }; category?: string; number: number; total: number }): string {
  const { profile } = profileFor(o.category);
  return [
    `Draw storyboard frame ${o.number} of ${o.total} as a single SVG illustration, ${o.size.w}x${o.size.h}.`,
    `Look: ${scene.visual_style || profile.styles[0]}. Flat, layered shapes with clear foreground, middle ground and background, one main light source, bold readable silhouettes.`,
    'Draw exactly what is described. Give each character the described build, hair, clothing and colours, with a face and a pose that show what they are doing.',
    '',
    scene.visual_description,
    '',
    'Rules:',
    `- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${o.size.w} ${o.size.h}"> and fill the whole canvas.`,
    '- Use only: g, path, rect, circle, ellipse, line, polyline, polygon, defs, linearGradient, radialGradient, stop, clipPath.',
    '- No text, letters, labels or captions. No images, links, scripts, style blocks or CSS classes: use presentation attributes.',
    '- Keep it under 60 kilobytes. Leave the lower fifth uncluttered for captions.',
    '- Answer with the SVG only.',
  ].join('\n');
}

const rasterize = (svgPath: string, pngPath: string) =>
  new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { timeout: 60_000 }, (err) => (err ? reject(bad(`Could not turn the drawing into a picture: ${err.message.slice(0, 200)}`)) : resolve()));
  });

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
  start(storyboardId: string, o: { indexes?: unknown; reopen?: boolean } = {}) {
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
    const job = this.s.jobs.enqueue('sketch_scenes', { projectId: a.project_id, artifactId: a.id, params: { storyboardId, sceneIds: picked.map((i) => rows[i].scene_id), reopen: o.reopen === true } });
    return { job, scenes: picked.length };
  }

  async run(ctx: JobCtx) {
    const { storyboardId, sceneIds, reopen } = ctx.params as { storyboardId: string; sceneIds: string[]; reopen?: boolean };
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
        await this.draw(a.project_id, content!, index, { reopen, signal: ctx.signal });
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

  private async draw(projectId: string, sb: StoryboardContent, index: number, o: { reopen?: boolean; signal?: AbortSignal }) {
    const project = this.s.engine.getProject(projectId);
    const format = (project.settings.formats as string[] | undefined)?.[0] ?? 'vertical_9x16';
    const size = FRAME[format] ?? FRAME.vertical_9x16;
    const scene = sb.scenes[index];
    const prompt = buildSketchPrompt(scene, { size, category: project.category ?? undefined, number: index + 1, total: sb.scenes.length });
    const svg = checkSvg(await this.s.research.bridge.ask(prompt, { noTools: true, signal: o.signal }), size);
    const dir = join(this.s.config.root, 'cache', `sketch_${ulid()}`);
    await mkdir(dir, { recursive: true });
    try {
      const src = join(dir, 'frame.svg');
      const png = join(dir, 'frame.png');
      await writeFile(src, svg);
      await rasterize(src, png);
      const asset = await this.s.assets.importLocal(projectId, png, {
        type: 'illustration',
        name: `Sketch: scene ${index + 1}`,
        license: { type: 'ai-generated', commercial_use: 'unknown', notes: 'Storyboard sketch drawn by Claude from your script. Check your Claude plan terms before commercial use.' },
        provider: 'claude-sketch',
        prompt: scene.visual_description,
        tags: ['storyboard-sketch'],
        params: { scene_id: scene.scene_id },
      });
      const art = this.s.engine.list(projectId, { kind: 'scene_asset' }).find((x) => x.scene_id === scene.scene_id)!;
      this.s.save(art.id, { assets: [{ asset_id: asset.id, role: 'primary' }], primary_asset_id: asset.id }, { actor: 'ai', reopen: o.reopen });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
