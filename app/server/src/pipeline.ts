import { Engine, EngineError } from './engine.ts';
import type { Artifact } from './engine.ts';
import { FORMATS, ulid } from '../../shared/src/index.ts';

export interface PipelineOptions {
  name: string;
  category?: string;
  languages: string[]; // e.g. ['en','tl','taglish']
  formats: string[]; // e.g. ['vertical_9x16']
}

/**
 * Dependency graph (A <- B means B depends on A):
 *   research <- script_base <- script_lang[l] <- audio[l] <- caption[l] <- subtitle_export[l]
 *   script_base <- storyboard <- scene_asset[s]
 *   {storyboard, scene_asset[*], audio[l], caption[l]} <- composition[l,f] <- final_render[l,f]
 */
export function createProject(engine: Engine, opts: PipelineOptions): string {
  return engine.tx(() => {
    const p = engine.createProject(opts.name, opts.languages, opts.category, { formats: opts.formats });
    const research = mk(engine, p, 'research', 'Research');
    const scriptBase = mk(engine, p, 'script_base', 'Base script');
    const storyboard = mk(engine, p, 'storyboard', 'Storyboard');
    engine.addDependency(scriptBase, research);
    engine.addDependency(storyboard, scriptBase);
    for (const l of opts.languages) buildLanguage(engine, p, l, opts.formats);
    return p;
  });
}

function mk(engine: Engine, projectId: string, kind: Artifact['kind'], label: string, extra: { lang?: string; format?: string; sceneId?: string } = {}) {
  return engine.createArtifact({ projectId, kind, label, ...extra });
}

/** Per-language artifacts. Wires into the project's existing base script, storyboard and scene assets. */
function buildLanguage(engine: Engine, projectId: string, l: string, formats: string[]): void {
  const [scriptBase] = engine.list(projectId, { kind: 'script_base' });
  const [storyboard] = engine.list(projectId, { kind: 'storyboard' });
  const sceneAssets = engine.list(projectId, { kind: 'scene_asset' });
  const script = mk(engine, projectId, 'script_lang', `Script (${l})`, { lang: l });
  const audio = mk(engine, projectId, 'audio', `Narration audio (${l})`, { lang: l });
  const caption = mk(engine, projectId, 'caption', `Captions (${l})`, { lang: l });
  const subs = mk(engine, projectId, 'subtitle_export', `SRT/VTT export (${l})`, { lang: l });
  engine.addDependency(script, scriptBase.id);
  engine.addDependency(audio, script);
  engine.addDependency(caption, audio);
  engine.addDependency(caption, script);
  engine.addDependency(subs, caption);
  for (const f of formats) {
    const comp = mk(engine, projectId, 'composition', `Composition (${l}, ${f})`, { lang: l, format: f });
    const render = mk(engine, projectId, 'final_render', `Final render (${l}, ${f})`, { lang: l, format: f });
    engine.addDependency(comp, storyboard.id);
    engine.addDependency(comp, audio);
    engine.addDependency(comp, caption);
    for (const a of sceneAssets) engine.addDependency(comp, a.id);
    engine.addDependency(render, comp);
  }
}

/** Adds a language to an existing project. Other languages and their approvals are untouched. */
export function addLanguage(engine: Engine, projectId: string, lang: string): void {
  engine.tx(() => {
    const project = engine.getProject(projectId);
    if (project.languages.includes(lang)) throw new EngineError('VALIDATION', `Project already has language ${lang}`);
    const formats = (project.settings.formats as string[] | undefined) ?? ['vertical_9x16'];
    engine.db.prepare('INSERT INTO project_languages (project_id, lang_code) VALUES (?,?)').run(projectId, lang);
    buildLanguage(engine, projectId, lang, formats);
  });
}

/** Removes a language. Refused while any of its artifacts are approved or awaiting review (approved work is protected). */
export function removeLanguage(engine: Engine, projectId: string, lang: string): number {
  return engine.tx(() => {
    const project = engine.getProject(projectId);
    if (!project.languages.includes(lang)) throw new EngineError('NOT_FOUND', `Project has no language ${lang}`);
    const arts = engine.list(projectId).filter((a) => a.lang_code === lang);
    const protectedOnes = arts.filter((a) => a.state === 'approved' || a.state === 'awaiting_review');
    if (protectedOnes.length) {
      throw new EngineError('PROTECTED', `Cannot remove ${lang}: approved or in-review work exists`, protectedOnes.map((a) => a.label));
    }
    for (const a of arts) engine.db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
    engine.db.prepare('DELETE FROM project_languages WHERE project_id = ? AND lang_code = ?').run(projectId, lang);
    return arts.length;
  });
}

const projectFormats = (engine: Engine, projectId: string) => (engine.getProject(projectId).settings.formats as string[] | undefined) ?? ['vertical_9x16'];
const saveFormats = (engine: Engine, projectId: string, formats: string[]) => {
  const p = engine.getProject(projectId);
  engine.db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ ...p.settings, formats }), projectId);
};

/** Adds a video dimension to a project: a composition and a final render for every language. Existing formats are untouched. */
export function addFormat(engine: Engine, projectId: string, format: string): void {
  if (!(FORMATS as readonly string[]).includes(format)) throw new EngineError('VALIDATION', `Unknown format "${format}"`);
  engine.tx(() => {
    const formats = projectFormats(engine, projectId);
    if (formats.includes(format)) throw new EngineError('VALIDATION', 'The project already has this format');
    const [storyboard] = engine.list(projectId, { kind: 'storyboard' });
    const scenes = engine.list(projectId, { kind: 'scene_asset' });
    for (const l of engine.getProject(projectId).languages) {
      const comp = mk(engine, projectId, 'composition', `Composition (${l}, ${format})`, { lang: l, format });
      const render = mk(engine, projectId, 'final_render', `Final render (${l}, ${format})`, { lang: l, format });
      engine.addDependency(comp, storyboard.id);
      for (const kind of ['audio', 'caption'] as const) engine.addDependency(comp, engine.list(projectId, { kind }).find((a) => a.lang_code === l)!.id);
      for (const a of scenes) engine.addDependency(comp, a.id);
      engine.addDependency(render, comp);
    }
    saveFormats(engine, projectId, [...formats, format]);
  });
}

/** Removes a format. Refused for the last one, or when any of its work exists (nothing saved is ever thrown away). */
export function removeFormat(engine: Engine, projectId: string, format: string): void {
  engine.tx(() => {
    const formats = projectFormats(engine, projectId);
    if (!formats.includes(format)) throw new EngineError('NOT_FOUND', 'The project does not have this format');
    if (formats.length === 1) throw new EngineError('VALIDATION', 'A video needs at least one format');
    const arts = engine.list(projectId).filter((a) => a.format === format);
    const worked = arts.filter((a) => a.current_version_id);
    if (worked.length) throw new EngineError('PROTECTED', 'This format already has work, so it is kept', worked.map((a) => a.label));
    for (const a of arts) engine.db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
    saveFormats(engine, projectId, formats.filter((f) => f !== format));
  });
}

/** Adds a scene's visual-asset artifact and wires it into the storyboard and every composition. */
export function addScene(
  engine: Engine,
  projectId: string,
  title: string,
  opts: { sceneId?: string; invalidate?: boolean } = {},
): { sceneId: string; assetArtifactId: string } {
  return engine.tx(() => {
    const sceneId = opts.sceneId ?? ulid();
    const asset = engine.createArtifact({ projectId, kind: 'scene_asset', label: `Scene asset: ${title}`, sceneId });
    const [storyboard] = engine.list(projectId, { kind: 'storyboard' });
    engine.addDependency(asset, storyboard.id);
    for (const c of engine.list(projectId, { kind: 'composition' })) engine.addDependency(c.id, asset);
    // A new scene changes what approved compositions contain (callers that already save the
    // storyboard pass invalidate:false because that save invalidates downstream itself).
    if (opts.invalidate !== false) for (const c of engine.list(projectId, { kind: 'composition' })) {
      if (c.state === 'approved' || c.state === 'awaiting_review') engine.saveVersion(c.id, { note: 'scene added', scene: sceneId, prev: c.current_version_id }, { actor: 'system', reopen: true });
    }
    return { sceneId, assetArtifactId: asset };
  });
}
