import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Loading, Modal, Pill, fmtSec, useToast } from '../ui';
import { ASSET_TYPES } from '../types';
import { ProjectDetailsEditor } from './shared';

const MOVES = ['static', 'pan', 'zoom', 'ken_burns', 'parallax'];
const TRANS = ['cut', 'fade', 'dissolve', 'slide', 'zoom', 'wipe'];
const DIRS: Record<string, string[]> = { pan: ['left_to_right', 'right_to_left', 'up', 'down'], zoom: ['in', 'out'], ken_burns: ['in', 'out'], parallax: [], static: [] };

export function StoryboardStage() {
  const { project, find, reload } = useProject();
  const art = find('storyboard')!;
  const base = find('script_base')!;
  const { push } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const baseDoc = useAsync(() => api.get<any>(`/artifacts/${base.id}`), [base.id, base.current_version_id]);
  const recs = useAsync(() => api.get<any>(`/categories/${encodeURIComponent(project.category ?? 'custom')}/recommendations`), [project.category]);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [secs, setSecs] = useState(4);
  const [pickCat, setPickCat] = useState(false);
  useEffect(() => { if (loaded.data) { setC(loaded.data.content); setDirty(false); } }, [loaded.data]);
  const done = () => { reload(); loaded.reload(); };
  if (loaded.loading && !loaded.data) return <Loading />;
  const sections: { id: string; kind: string; text: string }[] = baseDoc.data?.content?.sections ?? [];
  const edit = (patch: any) => { setC({ ...c, ...patch }); setDirty(true); };
  const setScene = (i: number, patch: any) => edit({ scenes: c.scenes.map((s: any, k: number) => (k === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= c.scenes.length) return;
    const next = [...c.scenes];
    [next[i], next[j]] = [next[j], next[i]];
    edit({ scenes: next });
  };

  return (
    <>
      <ArtifactBar artifact={art} onChanged={done}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      {recs.data && (
        <Card title={`Visual approach: ${recs.data.name}`} actions={<Btn small kind="ghost" onClick={() => setPickCat(!pickCat)}>{pickCat ? 'Close' : 'Change category'}</Btn>}>
          {pickCat && <div style={{ marginBottom: 12 }}><ProjectDetailsEditor compact project={project} onSaved={() => { setPickCat(false); reload(); recs.reload(); }} /></div>}
          <div className="row gap wrap small">
            <span className="muted">Suggested sources:</span>{recs.data.profile.assets.map((a: string) => <Pill key={a} tone="info">{a.replace(/_/g, ' ')}</Pill>)}
            <span className="muted">Looks:</span>{recs.data.profile.styles.map((a: string) => <Pill key={a}>{a}</Pill>)}
            <span className="muted">Camera:</span>{recs.data.profile.cameras.map((a: string) => <Pill key={a}>{a.replace('_', ' ')}</Pill>)}
          </div>
          {recs.data.custom && <p className="muted small" style={{ marginBottom: 0 }}>Custom category: using general defaults. Override anything per scene.</p>}
          {recs.data.profile.notes && <p className="small" style={{ marginBottom: 0 }}>{recs.data.profile.notes}</p>}
        </Card>
      )}
      {!c ? (
        <Card title="Create the storyboard">
          <p style={{ marginTop: 0 }}>Turn the approved script into scenes. The draft splits the script into short shots and picks a starting visual type and camera move for your category. The visual descriptions are plain skeletons: refine them yourself, or paste the prompt into an assistant you use.</p>
          {base.state !== 'approved' && <div className="notice warn" style={{ marginBottom: 10 }}>Approve the base script first.</div>}
          <div className="row gap wrap">
            <Field label="Aim for scenes of about (seconds)"><input type="number" min={2} max={20} style={{ width: 100 }} value={secs} onChange={(e) => setSecs(Number(e.target.value))} /></Field>
            <Btn kind="primary" disabled={base.state !== 'approved'} onClick={async () => { await api.post(`/artifacts/${art.id}/seed-storyboard`, { scene_seconds: secs }); push('ok', 'Draft storyboard created'); done(); }}>Generate draft from script</Btn>
            <Btn disabled={!base.current_version_id} onClick={async () => setPrompt((await api.get(`/artifacts/${art.id}/storyboard-prompt`)).prompt)}>Prompt for my own AI</Btn>
          </div>
        </Card>
      ) : (
        <>
          <div className="row gap wrap">
            <strong>{c.scenes.length} scenes</strong><span className="muted">≈ {fmtSec(c.scenes.reduce((n: number, s: any) => n + s.target_duration, 0))} planned</span>
            <span className="grow" />
            <Btn small onClick={async () => setPrompt((await api.get(`/artifacts/${art.id}/storyboard-prompt`)).prompt)}>Prompt for my own AI</Btn>
            <Btn small onClick={() => edit({ scenes: [...c.scenes, { title: 'New scene', script_segment_id: sections[0]?.id ?? '', target_duration: 3, visual_description: '', asset_type: 'stock_photo', camera: { movement: 'ken_burns', direction: 'in', intensity: 'subtle' }, transition_in: 'dissolve', sfx_cues: [] }] })}>Add scene</Btn>
          </div>
          <div className="stack">
            {c.scenes.map((s: any, i: number) => (
              <div key={s.scene_id ?? i} className="scene">
                <div className="row gap">
                  <span className="scene-n">{i + 1}</span>
                  <input aria-label="Scene title" value={s.title} onChange={(e) => setScene(i, { title: e.target.value })} />
                  {s.draft && <Pill tone="warn">draft</Pill>}
                  <Btn small kind="ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</Btn>
                  <Btn small kind="ghost" onClick={() => move(i, 1)} disabled={i === c.scenes.length - 1}>↓</Btn>
                  <Btn small kind="ghost" onClick={() => edit({ scenes: c.scenes.filter((_: any, k: number) => k !== i) })}>Remove</Btn>
                </div>
                {s.segment_text && <p className="muted small" style={{ margin: '8px 0 0' }}>“{s.segment_text}”</p>}
                <Field label="What the viewer sees" wide><textarea style={{ marginTop: 6 }} value={s.visual_description} onChange={(e) => setScene(i, { visual_description: e.target.value, draft: false })} /></Field>
                <div className="form" style={{ marginTop: 8 }}>
                  <Field label="Script section"><select value={s.script_segment_id} onChange={(e) => setScene(i, { script_segment_id: e.target.value })}>{sections.map((x) => <option key={x.id} value={x.id}>{x.kind}: {x.text.slice(0, 28)}</option>)}</select></Field>
                  <Field label="Duration (s)"><input type="number" step={0.1} min={0.5} value={s.target_duration} onChange={(e) => setScene(i, { target_duration: Number(e.target.value) })} /></Field>
                  <Field label="Visual type"><select value={s.asset_type} onChange={(e) => setScene(i, { asset_type: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
                  <Field label="Look"><input value={s.visual_style ?? ''} onChange={(e) => setScene(i, { visual_style: e.target.value })} /></Field>
                  <Field label="Camera"><select value={s.camera.movement} onChange={(e) => setScene(i, { camera: { ...s.camera, movement: e.target.value, direction: DIRS[e.target.value]?.[0] } })}>{MOVES.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</select></Field>
                  {(DIRS[s.camera.movement]?.length ?? 0) > 0 && <Field label="Direction"><select value={s.camera.direction ?? ''} onChange={(e) => setScene(i, { camera: { ...s.camera, direction: e.target.value } })}>{DIRS[s.camera.movement].map((d) => <option key={d}>{d}</option>)}</select></Field>}
                  <Field label="Intensity"><select value={s.camera.intensity ?? 'subtle'} onChange={(e) => setScene(i, { camera: { ...s.camera, intensity: e.target.value } })}>{['subtle', 'medium', 'strong'].map((d) => <option key={d}>{d}</option>)}</select></Field>
                  <Field label="Transition in"><select value={s.transition_in ?? 'cut'} onChange={(e) => setScene(i, { transition_in: e.target.value })}>{TRANS.map((t) => <option key={t}>{t}</option>)}</select></Field>
                  <Field label="Sound effects (comma separated)"><input value={(s.sfx_cues ?? []).join(', ')} onChange={(e) => setScene(i, { sfx_cues: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                </div>
              </div>
            ))}
            {c.scenes.length === 0 && <Empty>No scenes.</Empty>}
          </div>
          <div className="row gap"><Btn kind="primary" disabled={!dirty} onClick={async () => { const r = await saveArtifact(art.id, c); push('ok', r.changed ? 'Storyboard saved' : 'No changes'); done(); }}>Save storyboard</Btn><span className="muted small">Saving keeps one visual slot per scene in sync. A scene whose visual is already approved cannot be removed.</span></div>
        </>
      )}
      {prompt && <Modal title="Storyboard prompt" wide onClose={() => setPrompt(null)}><div className="row gap" style={{ marginBottom: 8 }}><CopyBtn text={prompt} /></div><pre>{prompt}</pre></Modal>}
    </>
  );
}
