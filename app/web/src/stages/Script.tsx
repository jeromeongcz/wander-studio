import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, Empty, Field, Loading, Pill, useToast } from '../ui';
import { EstimateBar, SectionsEditor, sid } from './shared';
import type { Section } from './shared';
import { langName } from '../types';

export function ScriptStage() {
  const { project, find, reload } = useProject();
  const art = find('script_base')!;
  const { push } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const presets = useAsync(() => api.get<any[]>('/script-presets'), []);
  const outlines = useAsync(() => api.get<any[]>('/templates?kind=script_outline'), []);
  const research = find('research')!;
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!loaded.data) return;
    setC(loaded.data.content ?? { title: project.name, lang: project.languages[0] ?? 'en', preset: 'short_lt30', sections: [{ id: sid(), kind: 'hook', text: '' }] });
    setDirty(!loaded.data.content);
  }, [loaded.data, project.name, project.languages]);
  if (!c) return <Loading />;
  const edit = (patch: any) => { setC({ ...c, ...patch }); setDirty(true); };
  const save = async () => {
    const r = await saveArtifact(art.id, c);
    push('ok', r.changed ? 'Script saved' : 'No changes to save');
    if (r.invalidated?.length) push('warn', `${r.invalidated.length} dependent step(s) now need revision`);
    setDirty(false);
    reload();
  };
  const empty = c.sections.every((s: Section) => !s.text.trim());
  return (
    <>
      <ArtifactBar artifact={art} onChanged={() => { reload(); loaded.reload(); }}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      {research.state !== 'approved' && <div className="notice warn">The research is not approved yet. You can draft now, but the script cannot be approved until it is.</div>}
      <Card title="Base script">
        <div className="form">
          <Field label="Title"><input value={c.title} onChange={(e) => edit({ title: e.target.value })} /></Field>
          <Field label="Written in" hint="The base script is the source for every language version"><select value={c.lang} onChange={(e) => edit({ lang: e.target.value })}>{project.languages.map((l) => <option key={l} value={l}>{langName(l)}</option>)}</select></Field>
          <Field label="Length target">
            <select value={c.preset} onChange={(e) => edit({ preset: e.target.value })}>{(presets.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          </Field>
          {(c.preset === 'custom' || c.preset === 'long') && <Field label="Target seconds"><input type="number" min={5} value={c.target_seconds ?? ''} onChange={(e) => edit({ target_seconds: e.target.value ? Number(e.target.value) : undefined })} /></Field>}
        </div>
        {empty && (outlines.data?.length ?? 0) > 0 && (
          <div className="row gap wrap" style={{ marginTop: 12 }}>
            <span className="muted">Start from a structure:</span>
            {outlines.data!.map((o) => <Btn key={o.id} small onClick={() => edit({ sections: o.content.sections.map((s: any) => ({ id: sid(), kind: s.kind, text: '', delivery_note: s.guidance })) })}>{o.name}</Btn>)}
          </div>
        )}
      </Card>
      <EstimateBar sections={c.sections} lang={c.lang} preset={c.preset} target={c.target_seconds} />
      <SectionsEditor sections={c.sections} onChange={(sections) => edit({ sections })} />
      {c.sections.length === 0 && <Empty>Add a hook to begin. Shorts scripts must open with a hook.</Empty>}
      <div className="row gap"><Btn kind="primary" onClick={save} disabled={!dirty}>Save script</Btn><span className="muted small">Editing an approved script asks first, and marks its language versions, storyboard and everything after as needing revision.</span></div>
    </>
  );
}
