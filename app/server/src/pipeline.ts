import { Engine } from './engine.ts';
import type { Artifact } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';

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
    const p = engine.createProject(opts.name, opts.languages, opts.category);
    const mk = (kind: Artifact['kind'], label: string, extra: { lang?: string; format?: string; sceneId?: string } = {}) =>
      engine.createArtifact({ projectId: p, kind, label, ...extra });

    const research = mk('research', 'Research');
    const scriptBase = mk('script_base', 'Base script');
    const storyboard = mk('storyboard', 'Storyboard');
    engine.addDependency(scriptBase, research);
    engine.addDependency(storyboard, scriptBase);

    for (const l of opts.languages) {
      const script = mk('script_lang', `Script (${l})`, { lang: l });
      const audio = mk('audio', `Narration audio (${l})`, { lang: l });
      const caption = mk('caption', `Captions (${l})`, { lang: l });
      const subs = mk('subtitle_export', `SRT/VTT export (${l})`, { lang: l });
      engine.addDependency(script, scriptBase);
      engine.addDependency(audio, script);
      engine.addDependency(caption, audio);
      engine.addDependency(caption, script);
      engine.addDependency(subs, caption);
      for (const f of opts.formats) {
        const comp = mk('composition', `Composition (${l}, ${f})`, { lang: l, format: f });
        const render = mk('final_render', `Final render (${l}, ${f})`, { lang: l, format: f });
        engine.addDependency(comp, storyboard);
        engine.addDependency(comp, audio);
        engine.addDependency(comp, caption);
        engine.addDependency(render, comp);
      }
    }
    return p;
  });
}

/** Adds a scene's visual-asset artifact and wires it into the storyboard and every composition. */
export function addScene(engine: Engine, projectId: string, title: string): { sceneId: string; assetArtifactId: string } {
  return engine.tx(() => {
    const sceneId = ulid();
    const asset = engine.createArtifact({ projectId, kind: 'scene_asset', label: `Scene asset: ${title}`, sceneId });
    const [storyboard] = engine.list(projectId, { kind: 'storyboard' });
    engine.addDependency(asset, storyboard.id);
    for (const c of engine.list(projectId, { kind: 'composition' })) engine.addDependency(c.id, asset);
    // A new scene changes what approved compositions contain.
    for (const c of engine.list(projectId, { kind: 'composition' })) {
      if (c.state === 'approved' || c.state === 'awaiting_review') engine.saveVersion(c.id, { note: 'scene added', scene: sceneId, prev: c.current_version_id }, { actor: 'system', reopen: true });
    }
    return { sceneId, assetArtifactId: asset };
  });
}
