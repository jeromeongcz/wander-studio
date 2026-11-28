import { directionSummary, useCinematic, words } from './Direction';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact, withReopen } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync, useInterval } from '../hooks';
import { Btn, Empty, Field, Icon, Loading, Modal, Pill, StateBadge, fmtSec, useToast } from '../ui';
import { url } from '../api';
import { ASSET_TYPES } from '../types';
import { AnimatedSvgScenePanel } from './AnimatedSvg';


export function StoryboardStage() {
  const { project, find, reload } = useProject();
  const art = find('storyboard')!;
  const base = find('script_base')!;
  const { push, fail } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const baseDoc = useAsync(() => api.get<any>(`/artifacts/${base.id}`), [base.id, base.current_version_id]);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const seededFor = useRef<string | null>(null);
  const [seedError, setSeedError] = useState<Error | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  // custom SVG: paste a drawing to use as a scene's picture instead of generating one
  const [customSvg, setCustomSvg] = useState<number | null>(null);
  const [svgText, setSvgText] = useState('');
  const [animatedArtworkBatch, setAnimatedArtworkBatch] = useState<{ current: number; total: number } | null>(null);
  const cinematic = useCinematic();
  const moves = cinematic.data?.cameras ?? [];
  const transitions = cinematic.data?.transitions ?? [];
  const directions = (movement: string) => moves.find((m) => m.id === movement)?.directions ?? [];
  const cardClass = `scene-card wide${c ? ' scene-designed animated-open' : ''}`;
  const sketches = useAsync(() => api.get<any[]>(`/artifacts/${art.id}/sketches`), [art.id, art.current_version_id, project.artifacts.map((a) => a.current_version_id).join()]);
  const animatedArtwork = useAsync(() => api.get<any[]>(`/artifacts/${art.id}/animated-svg`), [art.id, art.current_version_id]);
  const jobs = useAsync(() => api.get<any[]>(`/jobs?project_id=${project.id}`), [project.id]);
  const drawing = (jobs.data ?? []).find((j) => j.kind === 'sketch_scenes' && (j.state === 'queued' || j.state === 'running'));
  const lastDraw = (jobs.data ?? []).filter((j) => j.kind === 'sketch_scenes').sort((x, y) => (x.id < y.id ? 1 : -1))[0];
  useInterval(() => { jobs.reload(); if (drawing) sketches.reload(); }, 2000);
  const status = useAsync(() => api.get<any>('/research/status'), []);
  useEffect(() => { if (loaded.data) { setC(loaded.data.content); setDirty(false); } }, [loaded.data]);
  useEffect(() => {
    if (base.state !== 'approved' || !loaded.data || loaded.data.content || seededFor.current === art.id) return;
    seededFor.current = art.id;
    setSeedError(null);
    void api.post(`/artifacts/${art.id}/seed-storyboard`).then(() => {
      loaded.reload();
      reload();
    }).catch((error: Error) => {
      if ((error as { code?: string }).code === 'VALIDATION' && /already has content/i.test(error.message)) loaded.reload();
      else setSeedError(error);
    });
  }, [art.id, base.state, loaded.data, loaded.reload, reload]);
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
  const generateAnimatedArtworkBatch = async () => {
    if (dirty) { push('warn', 'Save the storyboard first, then generate animated artwork.'); return; }
    const targets = (c?.scenes ?? []).map((scene: any, index: number) => ({ scene, index }))
      .filter(({ index }: { index: number }) => !animatedArtwork.data?.[index])
      .slice(0, 10);
    if (!targets.length) { push('warn', 'All scenes already have animated artwork.'); return; }
    if ((jobs.data ?? []).some((job) => job.kind?.startsWith('animated_svg_') && (job.state === 'queued' || job.state === 'running'))) {
      push('warn', 'Wait for the current animated artwork job to finish first.'); return;
    }
    try {
      const selected = await api.get<{ active: string | null }>('/llm/active');
      if (!selected.active) throw new Error('Select an AI provider in Settings first.');
      if (!confirm(`Generate layered animated artwork for ${targets.length} scene${targets.length === 1 ? '' : 's'} using ${selected.active}? Each scene is sent to this provider and saved as a draft for your review.`)) return;
      setAnimatedArtworkBatch({ current: 0, total: targets.length });
      let succeeded = 0;
      const failures: string[] = [];
      for (let n = 0; n < targets.length; n++) {
        const { scene, index } = targets[n];
        setAnimatedArtworkBatch({ current: n + 1, total: targets.length });
        const { job: queued } = await api.post<{ job: { id: string } }>(`/artifacts/${art.id}/animated-svg/${index}/generate`, {
          operation: 'artwork', brief: scene.visual_description ?? '', consent: true, expectedProvider: selected.active,
        });
        let job: any;
        do {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          job = await api.get<any>(`/jobs/${queued.id}`);
        } while (job.state === 'queued' || job.state === 'running');
        if (job.state === 'succeeded') succeeded++;
        else {
          failures.push(`Scene ${index + 1}: ${job.error?.message ?? (job.state === 'cancelled' ? 'cancelled' : 'generation failed')}`);
          if (job.state === 'cancelled') break;
        }
      }
      animatedArtwork.reload();
      jobs.reload();
      done();
      if (failures.length) push('warn', `Animated artwork finished: ${succeeded} of ${targets.length} scenes succeeded.`, failures);
      else push('ok', `Animated artwork generated for ${succeeded} scene${succeeded === 1 ? '' : 's'}. Review each draft in its scene.`);
    } catch (error) {
      fail(error);
    } finally {
      setAnimatedArtworkBatch(null);
    }
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
      <aside className="frame-col scene-media" aria-label={`Scene ${i + 1} still picture`}>
        <div className="scene-media-heading"><span className="scene-eyebrow">Still frame</span><span className="scene-media-count">{row?.asset_id ? 'Ready to review' : 'Awaiting artwork'}</span></div>
        {frame(i)}
        <div className="scene-media-controls">
        <div className="scene-media-action">{drawButton(i)}{row?.asset_id && row.state === 'approved' && <span className="approved-mark"><Icon name="check" small /> Approved</span>}</div>
        <div className="scene-support-actions">
          <Btn small onClick={() => copyPrompt(i)} title="Copy this scene's art-direction prompt">Copy prompt</Btn>
          <Btn small onClick={() => { setCustomSvg(i); setSvgText(''); }} title="Use your own SVG as this scene's picture">Custom SVG</Btn>
        </div>
        </div>
      </aside>
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
          <Btn kind="primary" disabled={!ready || !!drawing || !total || have === total} onClick={() => generate()}><Icon name="spark" small /> {drawing ? 'Drawing…' : have === total && total ? 'All drawn' : have ? `Generate ${total - have} remaining` : `Generate all ${total}`}</Btn>
          {c && <Btn disabled={!!drawing || !!animatedArtworkBatch || !animatedArtwork.data || !(c.scenes ?? []).some((_: any, i: number) => !animatedArtwork.data?.[i]) || (jobs.data ?? []).some((job) => job.kind?.startsWith('animated_svg_') && (job.state === 'queued' || job.state === 'running'))} title="Generate layered animated artwork for up to 10 scenes without an existing animated artwork draft" onClick={() => void generateAnimatedArtworkBatch()}>
            {animatedArtworkBatch ? `Generating Animated Artwork (${animatedArtworkBatch.current}/${animatedArtworkBatch.total})…` : `Generate (${Math.min(10, (c.scenes ?? []).filter((_: any, i: number) => !animatedArtwork.data?.[i]).length)}) Animated Artwork`}
          </Btn>}
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
      {!c && base.state === 'approved' && !seedError && !loaded.error ? <Loading what="Preparing storyboard scenes" /> : !c ? (
        <>
          {loaded.error && <div className="notice bad" role="alert">Could not load the storyboard: {loaded.error.message} <Btn small onClick={loaded.reload}>Retry</Btn></div>}
          {seedError && <div className="notice bad" role="alert">Could not prepare the storyboard scenes: {seedError.message} <Btn small onClick={() => { seededFor.current = null; setSeedError(null); loaded.reload(); }}>Retry</Btn></div>}
          <div className="stack">
            {preview.map((s, i) => (
              <article key={s.id} className={cardClass}>
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
          <div className="stack">
            {c.scenes.map((s: any, i: number) => (
              <div key={s.scene_id ?? i} className={cardClass}>
                <header className="topic-top scene-top" role="group" aria-label={`Scene ${i + 1} order and removal`}>
                  <span className="topic-state">
                    <span className="scene-n">{i + 1}</span>
                    <span>
                      <b>{s.title?.trim() || `Scene ${i + 1}`}</b>
                      {s.draft && <span className="draft-note" title="Written automatically from the script. Edit the description to mark it as yours.">Draft: not edited by you yet</span>}
                      {dirty && <span className="draft-note">Changes are not saved: press Save storyboard at the top.</span>}
                    </span>
                  </span>
                  <div className="tool-row">
                    <Btn small title="Show this scene one place earlier" onClick={() => move(i, -1)} disabled={i === 0}>↑ Earlier</Btn>
                    <Btn small title="Show this scene one place later" onClick={() => move(i, 1)} disabled={i === c.scenes.length - 1}>↓ Later</Btn>
                    <Btn small kind="danger" title="Delete this scene from the storyboard" onClick={() => { if (confirm(`Delete scene ${i + 1} from the storyboard?\n\nIt is removed when you press Save storyboard.`)) edit({ scenes: c.scenes.filter((_: any, k: number) => k !== i) }); }}><Icon name="trash" small /> Delete</Btn>
                    {sketches.data?.[i]?.asset_id && sketches.data[i].state !== 'approved' && <>
                      <span className="vsep" role="separator" aria-orientation="vertical" />
                      <Btn small kind="primary" disabled={!!drawing} onClick={() => approveScene(i)}><Icon name="check" small /> Approve</Btn>
                    </>}
                  </div>
                </header>
                <div className="scene-workspace">
                <div className="scene-overview">
                {picture(i)}
                <div className="scene-body">
                <details className="scene-settings">
                  <summary><span className="scene-settings-title"><span className="scene-settings-icon"><Icon name="gear" small /></span><span><strong>Scene settings</strong><small>Script, visuals, camera and timing</small></span></span><span className="scene-settings-summary"><Pill>{fmtSec(s.target_duration)}</Pill><Pill>{words(s.camera.movement)}</Pill>{sketches.data?.[i] && <StateBadge state={sketches.data[i].state} />}</span></summary>
                  <div className="scene-settings-content">
                  {s.segment_text && <div className="scene-cue"><span>Script cue</span><p>“{s.segment_text}”</p></div>}
                  <div className="scene-main"><Field label="What the viewer sees" wide><textarea value={s.visual_description} onChange={(e) => setScene(i, { visual_description: e.target.value, draft: false })} /></Field></div>
                  {s.look && <p className="muted small">{directionSummary({ look: s.look })}</p>}
                  <div className="form">
                  <Field label="Scene title"><input value={s.title} onChange={(e) => setScene(i, { title: e.target.value })} /></Field>
                  <Field label="Script section"><select value={s.script_segment_id} onChange={(e) => setScene(i, { script_segment_id: e.target.value })}>{sections.map((x) => <option key={x.id} value={x.id}>{x.kind}: {x.text.slice(0, 28)}</option>)}</select></Field>
                  <Field label="Duration (s)"><input type="number" step={0.1} min={0.5} value={s.target_duration} onChange={(e) => setScene(i, { target_duration: Number(e.target.value) })} /></Field>
                  <Field label="Visual type"><select value={s.asset_type} onChange={(e) => setScene(i, { asset_type: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
                  {project.settings.animatedSvg?.mode === 'mixed' && <Field label="Scene production mode">
                    <select value={s.animation_plan?.mode ?? 'auto'} onChange={e => {
                      const mode=e.target.value;
                      if(mode==='auto'){setScene(i,{animation_plan:undefined});return;}
                      const duration=Math.max(.1,Math.min(60,s.target_duration));
                      setScene(i,{animation_plan:{...s.animation_plan,mode,duration,beats:mode==='static'?[]:
                        (s.animation_plan?.mode==='animated'&&s.animation_plan.duration===duration?s.animation_plan.beats:
                          [{start:0,end:duration,actor:'',action:'Follow the saved storyboard direction.'}])}});
                    }}>
                      <option value="auto">Use the approved primary visual</option><option value="static">Static illustration</option><option value="animated">Animated SVG clip</option>
                    </select>
                  </Field>}
                  <Field label="Look"><input value={s.visual_style ?? ''} onChange={(e) => setScene(i, { visual_style: e.target.value })} /></Field>
                  <Field label="Camera"><select value={s.camera.movement} onChange={(e) => setScene(i, { camera: { ...s.camera, movement: e.target.value, direction: directions(e.target.value)[0] } })}>{moves.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
                  {directions(s.camera.movement).length > 0 && <Field label="Direction"><select value={s.camera.direction ?? ''} onChange={(e) => setScene(i, { camera: { ...s.camera, direction: e.target.value } })}>{directions(s.camera.movement).map((d) => <option key={d}>{d}</option>)}</select></Field>}
                  <Field label="Intensity"><select value={s.camera.intensity ?? 'subtle'} onChange={(e) => setScene(i, { camera: { ...s.camera, intensity: e.target.value } })}>{['subtle', 'medium', 'strong'].map((d) => <option key={d}>{d}</option>)}</select></Field>
                  <Field label="Transition in"><select value={s.transition_in ?? 'cut'} onChange={(e) => setScene(i, { transition_in: e.target.value, transition_settings: undefined })}>{transitions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
                  <Field label="Sound effects (comma separated)"><input value={(s.sfx_cues ?? []).join(', ')} onChange={(e) => setScene(i, { sfx_cues: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                  </div>
                  </div>
                </details>
                </div>
                </div>
                <section className="scene-animation">
                <AnimatedSvgScenePanel key={s.scene_id ?? i} artifactId={art.id} projectId={project.id} sceneId={s.scene_id} index={i}
                  title={s.title ?? ''} brief={s.visual_description ?? ''} targetDuration={s.target_duration ?? 0}
                  approvedStoryboard={art.state === 'approved'} hasApprovedStill={sketches.data?.[i]?.state === 'approved'}
                  onAttached={() => { sketches.reload(); done(); }} />
                </section>
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
