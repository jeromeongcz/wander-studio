import { directionSummary, useCinematic, words } from './Direction';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact, withReopen } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, Field, Icon, Loading, Modal, Pill, StateBadge, fmtSec, useToast } from '../ui';
import { url } from '../api';
import { ASSET_TYPES } from '../types';


export function StoryboardStage() {
  const { project, find, reload } = useProject();
  const art = find('storyboard')!;
  const base = find('script_base')!;
  const { push, fail } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const baseDoc = useAsync(() => api.get<any>(`/artifacts/${base.id}`), [base.id, base.current_version_id]);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  // how the scenes are laid out; remembered in this browser
  const [view, setView] = useState<'list' | 'grid'>(() => { try { return localStorage.getItem('wander-storyboard-view') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } });
  const layout = (v: 'list' | 'grid') => { setView(v); try { localStorage.setItem('wander-storyboard-view', v); } catch { /* storage unavailable */ } };
  const listClass = view === 'grid' ? 'board board-grid' : 'stack';
  const [zoom, setZoom] = useState<number | null>(null);
  // custom SVG: paste a drawing to use as a scene's picture instead of generating one
  const [customSvg, setCustomSvg] = useState<number | null>(null);
  const [svgText, setSvgText] = useState('');
  const cinematic = useCinematic();
  const moves = cinematic.data?.cameras ?? [];
  const transitions = cinematic.data?.transitions ?? [];
  const directions = (movement: string) => moves.find((m) => m.id === movement)?.directions ?? [];
  const cardClass = (i: number) => (view === 'grid' ? 'scene-card tall' : 'scene-card wide');
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
        {row?.asset_id ? <button type="button" className="zoom-open" aria-label={`Enlarge scene ${i + 1} picture`} title="Click to enlarge" onClick={() => setZoom(i)}><img src={url(`/assets/${row.asset_id}/file`)} alt={`Scene ${i + 1} picture`} /></button> : <span className="muted small">{drawing && (!row || drawing.params?.sceneIds?.includes(row.scene_id)) ? <><span className="spin" /> in the queue</> : 'No picture yet'}</span>}
      </div>
    );
  };
  const drawButton = (i: number) => {
    const has = !!sketches.data?.[i]?.asset_id;
    return <Btn small kind={has ? 'default' : 'primary'} disabled={!ready || !!drawing} onClick={() => generate([i])}><Icon name={has ? 'refresh' : 'spark'} small /> {has ? 'Regenerate' : 'Generate'}</Btn>;
  };

  /** The person's approval of one scene's picture: the picture itself, then the scene it belongs to. */
  const approveScene = async (i: number) => {
    const row = sketches.data?.[i];
    if (!row?.asset_id || !row.artifact_id) return;
    if (dirty) { push('warn', 'Save the storyboard first, then approve.'); return; }
    if (art.state !== 'approved') {
      if (!confirm(`Pictures belong to the storyboard, which is not approved yet.\n\nApprove the storyboard and scene ${i + 1}'s picture?`)) return;
      await approveStoryboard();
    }
    await approveRow((await api.get<any[]>(`/artifacts/${art.id}/sketches`))[i]);
    push('ok', `Scene ${i + 1} approved`);
    sketches.reload();
    done();
  };
  /** Part of the person's own approval click: resume if marked for revision, run the readiness checks, then approve. */
  const approveStoryboard = async () => {
    if (['needs_revision', 'rejected', 'failed'].includes(art.state)) {
      const cur = await api.get<{ content: unknown }>(`/artifacts/${art.id}`);
      await api.put(`/artifacts/${art.id}/content`, { content: cur.content });
    }
    if (art.state !== 'awaiting_review') await api.post(`/artifacts/${art.id}/submit`);
    await api.post(`/artifacts/${art.id}/approve`);
  };
  const approveRow = async (row: any) => {
    await api.post(`/assets/${row.asset_id}/approve`);
    // a scene marked for revision (for example after the storyboard changed) is resumed by saving it again, unchanged
    if (['needs_revision', 'rejected', 'failed'].includes(row.state)) {
      const cur = await api.get<{ content: unknown }>(`/artifacts/${row.artifact_id}`);
      await api.put(`/artifacts/${row.artifact_id}/content`, { content: cur.content });
    }
    if (row.state !== 'awaiting_review') await api.post(`/artifacts/${row.artifact_id}/submit`);
    await api.post(`/artifacts/${row.artifact_id}/approve`);
  };
  /** Approve every picture still waiting, after the person confirms. Scenes without a picture are left alone. */
  const waiting = (sketches.data ?? []).map((row, i) => ({ row, i })).filter(({ row }) => row.asset_id && row.artifact_id && row.state !== 'approved');
  const approveAll = async () => {
    if (dirty) { push('warn', 'Save the storyboard first, then approve.'); return; }
    const needsBoard = art.state !== 'approved';
    const without = total - have;
    const what = [needsBoard ? 'the storyboard' : '', waiting.length ? `${waiting.length} picture${waiting.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    if (!confirm(`Approve ${what}?\n\nCheck them first: approved work is used in your video.${without ? `\n\n${without} scene(s) have no picture yet and stay unapproved.` : ''}`)) return;
    if (needsBoard) await approveStoryboard(); // a failed check stops here and is shown
    const rows = (await api.get<any[]>(`/artifacts/${art.id}/sketches`)).map((row, i) => ({ row, i })).filter(({ row }) => row.asset_id && row.artifact_id && row.state !== 'approved');
    let ok = 0;
    const problems: string[] = [];
    for (const { row, i } of rows) {
      try { await approveRow(row); ok++; } catch (e) { problems.push(`Scene ${i + 1}: ${(e as Error).message}`); }
    }
    push(problems.length ? 'warn' : 'ok', rows.length ? `${needsBoard ? 'Storyboard and ' : ''}${ok} of ${rows.length} pictures approved` : 'Storyboard approved', problems.length ? problems : undefined);
    sketches.reload();
    done();
  };
  /** Copy the exact art-direction prompt for a scene, to run in any model. */
  const copyPrompt = async (i: number) => {
    try {
      const r = await api.get<{ prompt: string }>(`/artifacts/${art.id}/sketches/${i}/prompt`);
      await navigator.clipboard.writeText(r.prompt);
      push('ok', `Scene ${i + 1} prompt copied`);
    } catch (e) {
      fail(e);
    }
  };
  /** Turn a pasted SVG into this scene's picture (no model is called). */
  const generateSvg = async () => {
    if (customSvg === null) return;
    const i = customSvg;
    const approved = sketches.data?.[i]?.state === 'approved';
    if (approved && !confirm('This scene is approved. Replace its picture with your SVG?\n\nIt will need your approval again.')) return;
    try {
      await api.post(`/artifacts/${art.id}/sketches/${i}/custom-svg`, { svg: svgText, reopen: approved });
      push('ok', `Scene ${i + 1} picture set from your SVG`);
      setCustomSvg(null);
      setSvgText('');
      sketches.reload();
      done();
    } catch (e) {
      fail(e);
    }
  };
  const picture = (i: number) => {
    const row = sketches.data?.[i];
    return (
      <div className="frame-col">
        {frame(i)}
        {drawButton(i)}
        {row?.asset_id && (row.state === 'approved'
          ? <span className="approved-mark"><Icon name="check" small /> Approved</span>
          : <Btn small kind="primary" disabled={!!drawing} onClick={() => approveScene(i)}><Icon name="check" small /> Approve</Btn>)}
        <div className="row gap" style={{ flexWrap: 'wrap' }}>
          <Btn small onClick={() => copyPrompt(i)} title="Copy this scene's art-direction prompt">Copy prompt</Btn>
          <Btn small onClick={() => { setCustomSvg(i); setSvgText(''); }} title="Use your own SVG as this scene's picture">Custom SVG</Btn>
        </div>
      </div>
    );
  };

  return (
    <>
      <ArtifactBar artifact={art} onChanged={done}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      <section className="board-head">
        <div className="grow">
          <h3>{total} scene{total === 1 ? '' : 's'}</h3>
          <p className="muted small">{have} of {total} have a picture{c ? ` · about ${fmtSec(c.scenes.reduce((n: number, s: any) => n + s.target_duration, 0))}` : ''}. Pictures are sketches drawn by Claude; approve each one, or all at once.</p>
          <div className="bar-prog"><i style={{ width: `${total ? (have / total) * 100 : 0}%` }} /></div>
        </div>
        <div className="board-actions">
          {c && <Btn disabled={!!drawing || (!waiting.length && art.state === 'approved')} title={waiting.length || art.state !== 'approved' ? 'Approve the storyboard and every picture that is waiting' : 'Everything is approved'} onClick={approveAll}><Icon name="check" small /> {waiting.length ? `Approve all (${waiting.length})` : art.state !== 'approved' ? 'Approve all' : have ? 'All approved' : 'Approve all'}</Btn>}
          <div className="seg" role="group" aria-label="Scene layout">
            {([['list', 'rows', 'Horizontal'], ['grid', 'grid', 'Grid']] as const).map(([v, icon, label]) => <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => layout(v)}><Icon name={icon} small /> {label}</button>)}
          </div>
          <Btn kind="primary" disabled={!ready || !!drawing || !total || have === total} onClick={() => generate()}><Icon name="spark" small /> {drawing ? 'Drawing…' : have === total && total ? 'All drawn' : have ? `Generate ${total - have} remaining` : `Generate all ${total}`}</Btn>
          {c && <>
            {baseDoc.data?.content?.sections?.some((x: any) => x.cinematic) && <Btn disabled={dirty || !!drawing} title={dirty ? 'Save your changes first' : "Use the script's camera, transition and style directions on these scenes"} onClick={async () => {
              if (!confirm("Use the script's camera, transition and style directions on this storyboard?\n\nScenes you set yourself are kept. Changing the storyboard means scene visuals and videos need your approval again. To change only one finished video, use Compose & render instead.")) return;
              const r: any = await withReopen((reopen) => api.post(`/artifacts/${art.id}/apply-directions`, { reopen }));
              push('ok', r.changed ? `Directions applied${r.kept ? `; ${r.kept} of your own settings kept` : ''}` : 'The storyboard already follows the script directions');
              done();
            }}>Apply script directions</Btn>}
            <span className="vsep" role="separator" aria-orientation="vertical" />
            <Btn kind="primary" disabled={!dirty} title={dirty ? 'Save your changes' : 'No changes to save'} onClick={async () => { const r = await saveArtifact(art.id, c); push('ok', r.changed ? 'Storyboard saved' : 'No changes'); done(); }}>Save storyboard</Btn>
          </>}
        </div>
      </section>
      {base.state !== 'approved' && <div className="notice warn">Approve the base script first: the scenes come from it.</div>}
      {status.data && !status.data.loggedIn && <div className="notice warn"><strong>{status.data.detail}.</strong> {status.data.fix}</div>}
      {!drawing && lastDraw?.state === 'failed' && have < total && <div className="notice bad"><strong>Last drawing run had problems.</strong> {lastDraw.error?.message}</div>}
      {!c ? (
        <>
          <div className={listClass}>
            {preview.map((s, i) => (
              <article key={s.id} className={cardClass(i)}>
                {picture(i)}
                <div className="scene-body">
                  <div className="row gap"><span className="scene-n">{i + 1}</span><strong className="grow">{s.kind}</strong></div>
                  <p className="quote">“{s.text}”</p>
                  <dl className="scene-facts small scene-text">{['setting', 'characters', 'action', 'shot', 'mood', 'props'].filter((k) => s.visual?.[k]).map((k) => <div key={k}><dt>{k}</dt><dd>{s.visual[k]}</dd></div>)}</dl>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={listClass}>
            {c.scenes.map((s: any, i: number) => (
              <div key={s.scene_id ?? i} className={cardClass(i)}>
                <header className="topic-top scene-top" role="group" aria-label={`Scene ${i + 1} order and removal`}>
                  <span className="topic-state">
                    <span className="scene-n">{i + 1}</span>
                    <span>
                      <b>Scene {i + 1}</b>
                      {s.draft && <span className="draft-note" title="Written automatically from the script. Edit the description to mark it as yours.">Draft: not edited by you yet</span>}
                      {dirty && <span className="draft-note">Changes are not saved: press Save storyboard at the top.</span>}
                    </span>
                  </span>
                  <div className="tool-row">
                    <Btn small title="Show this scene one place earlier" onClick={() => move(i, -1)} disabled={i === 0}>↑ Earlier</Btn>
                    <Btn small title="Show this scene one place later" onClick={() => move(i, 1)} disabled={i === c.scenes.length - 1}>↓ Later</Btn>
                    <Btn small kind="danger" title="Delete this scene from the storyboard" onClick={() => { if (confirm(`Delete scene ${i + 1} from the storyboard?\n\nIt is removed when you press Save storyboard.`)) edit({ scenes: c.scenes.filter((_: any, k: number) => k !== i) }); }}><Icon name="trash" small /> Delete</Btn>
                  </div>
                </header>
                {picture(i)}
                <div className="scene-body">
                {s.segment_text && <p className="quote">“{s.segment_text}”</p>}
                <div className="scene-text">
                <p className="visual-text">{s.visual_description}</p>
                {s.look && <p className="visual-text">{directionSummary({ look: s.look })}</p>}
                <Field label="What the viewer sees" wide><textarea style={{ marginTop: 6 }} value={s.visual_description} onChange={(e) => setScene(i, { visual_description: e.target.value, draft: false })} /></Field>
                <div className="row gap wrap">
                  <input aria-label="Scene title" value={s.title} onChange={(e) => setScene(i, { title: e.target.value })} />
                </div>
                <div className="form" style={{ marginTop: 8 }}>
                  <Field label="Script section"><select value={s.script_segment_id} onChange={(e) => setScene(i, { script_segment_id: e.target.value })}>{sections.map((x) => <option key={x.id} value={x.id}>{x.kind}: {x.text.slice(0, 28)}</option>)}</select></Field>
                  <Field label="Duration (s)"><input type="number" step={0.1} min={0.5} value={s.target_duration} onChange={(e) => setScene(i, { target_duration: Number(e.target.value) })} /></Field>
                  <Field label="Visual type"><select value={s.asset_type} onChange={(e) => setScene(i, { asset_type: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
                  <Field label="Look"><input value={s.visual_style ?? ''} onChange={(e) => setScene(i, { visual_style: e.target.value })} /></Field>
                  <Field label="Camera"><select value={s.camera.movement} onChange={(e) => setScene(i, { camera: { ...s.camera, movement: e.target.value, direction: directions(e.target.value)[0] } })}>{moves.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
                  {directions(s.camera.movement).length > 0 && <Field label="Direction"><select value={s.camera.direction ?? ''} onChange={(e) => setScene(i, { camera: { ...s.camera, direction: e.target.value } })}>{directions(s.camera.movement).map((d) => <option key={d}>{d}</option>)}</select></Field>}
                  <Field label="Intensity"><select value={s.camera.intensity ?? 'subtle'} onChange={(e) => setScene(i, { camera: { ...s.camera, intensity: e.target.value } })}>{['subtle', 'medium', 'strong'].map((d) => <option key={d}>{d}</option>)}</select></Field>
                  <Field label="Transition in"><select value={s.transition_in ?? 'cut'} onChange={(e) => setScene(i, { transition_in: e.target.value, transition_settings: undefined })}>{transitions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
                  <Field label="Sound effects (comma separated)"><input value={(s.sfx_cues ?? []).join(', ')} onChange={(e) => setScene(i, { sfx_cues: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                </div>
                </div>
                <div className="row gap wrap scene-actions">
                  <Pill>{fmtSec(s.target_duration)}</Pill><Pill>{words(s.camera.movement)}</Pill><Pill>{words(s.transition_in ?? 'cut')} in</Pill>
                  {sketches.data?.[i] && <StateBadge state={sketches.data[i].state} />}
                  <span className="grow" />
                </div>
                </div>
              </div>
            ))}
            {c.scenes.length === 0 && <Empty>No scenes.</Empty>}
          </div>
        </>
      )}
      {customSvg !== null && (
        <Modal title={`Custom SVG — scene ${customSvg + 1}`} wide onClose={() => setCustomSvg(null)}>
          <p className="muted small" style={{ marginTop: 0 }}>Paste a complete <code>&lt;svg&gt;…&lt;/svg&gt;</code>. It is checked for safety, turned into a PNG at the video size, and set as this scene’s picture. No model is called.</p>
          <Field label="SVG" wide>
            <textarea style={{ minHeight: 200, fontFamily: 'monospace', fontSize: 12 }} value={svgText} onChange={(e) => setSvgText(e.target.value)} placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920">…</svg>'} />
          </Field>
          <div className="row gap" style={{ marginTop: 10 }}>
            <Btn kind="primary" disabled={!svgText.trim()} onClick={generateSvg}><Icon name="spark" small /> Generate image</Btn>
            <Btn onClick={() => setCustomSvg(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
      {zoom !== null && sketches.data?.[zoom]?.asset_id && (
        <PicturePopup
          src={url(`/assets/${sketches.data[zoom].asset_id}/file`)}
          title={`Scene ${zoom + 1}`}
          caption={c?.scenes[zoom]?.segment_text ?? ''}
          prev={[...sketches.data.keys()].filter((k) => k < zoom && sketches.data![k].asset_id).at(-1)}
          next={[...sketches.data.keys()].find((k) => k > zoom && sketches.data![k].asset_id)}
          go={setZoom}
          onClose={() => setZoom(null)}
        />
      )}
    </>
  );
}

/** A scene picture at full size. Escape closes it; the arrow keys move between scenes that have a picture. */
function PicturePopup({ src, title, caption, prev, next, go, onClose }: { src: string; title: string; caption: string; prev?: number; next?: number; go: (i: number) => void; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && prev !== undefined) go(prev);
      if (e.key === 'ArrowRight' && next !== undefined) go(next);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });
  return (
    <Modal title={title} wide onClose={onClose}>
      <figure className="zoom-view">
        <img src={src} alt={`${title} picture`} />
        {caption && <figcaption>“{caption}”</figcaption>}
      </figure>
      {(prev !== undefined || next !== undefined) && (
        <div className="row gap">
          <Btn small disabled={prev === undefined} onClick={() => go(prev!)}>← Previous</Btn>
          <span className="grow" />
          <Btn small disabled={next === undefined} onClick={() => go(next!)}>Next →</Btn>
        </div>
      )}
    </Modal>
  );
}
