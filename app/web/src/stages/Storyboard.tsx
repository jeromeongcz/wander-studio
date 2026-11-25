import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Icon, Loading, Modal, Pill, StateBadge, fmtSec, useToast } from '../ui';
import { url } from '../api';
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
  const [pickCat, setPickCat] = useState(false);
  // how the scenes are laid out; remembered in this browser
  const [view, setView] = useState<'list' | 'grid'>(() => { try { return localStorage.getItem('wander-storyboard-view') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } });
  const layout = (v: 'list' | 'grid') => { setView(v); try { localStorage.setItem('wander-storyboard-view', v); } catch { /* storage unavailable */ } };
  const listClass = view === 'grid' ? 'board board-grid' : 'stack';
  const cardClass = view === 'grid' ? 'scene-card tall' : 'scene-card wide';
  const sketches = useAsync(() => api.get<any[]>(`/artifacts/${art.id}/sketches`), [art.id, art.current_version_id, project.artifacts.map((a) => a.current_version_id).join()]);
  const jobs = useAsync(() => api.get<any[]>(`/jobs?project_id=${project.id}`), [project.id]);
  const drawing = (jobs.data ?? []).find((j) => j.kind === 'sketch_scenes' && (j.state === 'queued' || j.state === 'running'));
  const lastDraw = (jobs.data ?? []).filter((j) => j.kind === 'sketch_scenes').sort((x, y) => (x.id < y.id ? 1 : -1))[0];
  useInterval(() => { jobs.reload(); if (drawing) sketches.reload(); }, 2000);
  const status = useAsync(() => api.get<any>('/research/status'), []);
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

  /** Draw all scenes without a picture, or the given ones. Builds the storyboard from the approved script first if needed. */
  const generate = async (indexes?: number[]) => {
    if (dirty) { push('warn', 'Save the storyboard first, then generate.'); return; }
    const approved = (indexes ?? []).some((i) => sketches.data?.[i]?.state === 'approved');
    const replacing = (indexes ?? []).some((i) => sketches.data?.[i]?.asset_id);
    if (replacing && !confirm(approved ? 'This scene is approved. Draw a new picture anyway? It will need your approval again.' : 'Draw a new picture for this scene? The old one stays in the Asset Library.')) return;
    if (!sessionStorage.getItem('wander-cc-sketch-ok')) {
      if (!confirm('Claude Code on this computer draws each sketch, using your Claude plan.\n\nIt gets no tools. Only the scene description is sent. Each picture can take a minute or more.\n\nContinue?')) return;
      sessionStorage.setItem('wander-cc-sketch-ok', '1');
    }
    const r = await api.post(`/artifacts/${art.id}/sketches`, { indexes, reopen: approved });
    push('ok', `Drawing ${r.scenes} scene${r.scenes === 1 ? '' : 's'}…`);
    jobs.reload();
    done();
  };
  const ready = base.state === 'approved' && !!status.data?.loggedIn;
  const preview: any[] = baseDoc.data?.content?.sections ?? [];
  const have = (sketches.data ?? []).filter((r) => r.asset_id).length;
  const total = c ? c.scenes.length : preview.length;
  const portrait = (project.settings.formats ?? ['vertical_9x16'])[0];
  const ratio = portrait === 'horizontal_16x9' ? '16 / 9' : portrait === 'square_1x1' ? '1 / 1' : '9 / 16';

  const frame = (i: number) => {
    const row = sketches.data?.[i];
    return (
      <div className="frame-slot" style={{ aspectRatio: ratio }}>
        {row?.asset_id ? <img src={url(`/assets/${row.asset_id}/file`)} alt={`Scene ${i + 1} picture`} /> : <span className="muted small">{drawing && (!row || drawing.params?.sceneIds?.includes(row.scene_id)) ? <><span className="spin" /> in the queue</> : 'No picture yet'}</span>}
      </div>
    );
  };
  const drawButton = (i: number) => {
    const has = !!sketches.data?.[i]?.asset_id;
    return <Btn small kind={has ? 'default' : 'primary'} disabled={!ready || !!drawing} onClick={() => generate([i])}><Icon name={has ? 'refresh' : 'spark'} small /> {has ? 'Regenerate' : 'Generate'}</Btn>;
  };

  const picture = (i: number) => <div className="frame-col">{frame(i)}{drawButton(i)}{sketches.data?.[i]?.asset_id && <a className="btn btn-sm" href={`#/p/${project.id}/visuals`}>Approve in Visuals <Icon name="arrow" small /></a>}</div>;

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
      <section className="board-head">
        <div className="grow">
          <h3>{total} scene{total === 1 ? '' : 's'}</h3>
          <p className="muted small">{have} of {total} have a picture{c ? ` · about ${fmtSec(c.scenes.reduce((n: number, s: any) => n + s.target_duration, 0))}` : ''}. Pictures are sketches drawn by Claude; approve each one under Visuals.</p>
          <div className="bar-prog"><i style={{ width: `${total ? (have / total) * 100 : 0}%` }} /></div>
        </div>
        <div className="seg" role="group" aria-label="Scene layout">
          {([['list', 'rows', 'Horizontal'], ['grid', 'grid', 'Grid']] as const).map(([v, icon, label]) => <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => layout(v)}><Icon name={icon} small /> {label}</button>)}
        </div>
        <Btn kind="primary" disabled={!ready || !!drawing || !total || have === total} onClick={() => generate()}><Icon name="spark" small /> {drawing ? 'Drawing…' : have === total && total ? 'All drawn' : have ? `Generate ${total - have} remaining` : `Generate all ${total}`}</Btn>
      </section>
      {base.state !== 'approved' && <div className="notice warn">Approve the base script first: the scenes come from it.</div>}
      {status.data && !status.data.loggedIn && <div className="notice warn"><strong>{status.data.detail}.</strong> {status.data.fix}</div>}
      {!drawing && lastDraw?.state === 'failed' && have < total && <div className="notice bad"><strong>Last drawing run had problems.</strong> {lastDraw.error?.message}</div>}
      {!c ? (
        <>
          <div className={listClass}>
            {preview.map((s, i) => (
              <article key={s.id} className={cardClass}>
                {picture(i)}
                <div className="scene-body">
                  <div className="row gap"><span className="scene-n">{i + 1}</span><strong className="grow">{s.kind}</strong></div>
                  <p className="quote">“{s.text}”</p>
                  <dl className="scene-facts small scene-text" tabIndex={0}>{['setting', 'characters', 'action', 'shot', 'mood', 'props'].filter((k) => s.visual?.[k]).map((k) => <div key={k}><dt>{k}</dt><dd>{s.visual[k]}</dd></div>)}</dl>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="row gap wrap">
            <span className="grow" />
            <Btn small onClick={async () => setPrompt((await api.get(`/artifacts/${art.id}/storyboard-prompt`)).prompt)}>Prompt for my own AI</Btn>
            <Btn small onClick={() => edit({ scenes: [...c.scenes, { title: 'New scene', script_segment_id: sections[0]?.id ?? '', target_duration: 3, visual_description: '', asset_type: 'stock_photo', camera: { movement: 'ken_burns', direction: 'in', intensity: 'subtle' }, transition_in: 'dissolve', sfx_cues: [] }] })}>Add scene</Btn>
          </div>
          <div className={listClass}>
            {c.scenes.map((s: any, i: number) => (
              <div key={s.scene_id ?? i} className={cardClass}>
                {picture(i)}
                <div className="scene-body">
                <div className="row gap wrap">
                  <span className="scene-n">{i + 1}</span>
                  <input aria-label="Scene title" value={s.title} onChange={(e) => setScene(i, { title: e.target.value })} />
                  {s.draft && <Pill tone="warn">draft</Pill>}
                  <Btn small kind="ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</Btn>
                  <Btn small kind="ghost" onClick={() => move(i, 1)} disabled={i === c.scenes.length - 1}>↓</Btn>
                  <Btn small kind="ghost" onClick={() => edit({ scenes: c.scenes.filter((_: any, k: number) => k !== i) })}>Remove</Btn>
                </div>
                {s.segment_text && <p className="quote">“{s.segment_text}”</p>}
                <div className="scene-text" tabIndex={0}>
                <p className="visual-text">{s.visual_description}</p>
                <details>
                <summary className="muted small">Edit details</summary>
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
                </details>
                </div>
                <div className="row gap wrap scene-actions">
                  <Pill>{fmtSec(s.target_duration)}</Pill><Pill>{s.camera.movement.replace('_', ' ')}</Pill><Pill>{(s.transition_in ?? 'cut')} in</Pill>
                  {sketches.data?.[i] && <StateBadge state={sketches.data[i].state} />}
                  <span className="grow" />
                </div>
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
