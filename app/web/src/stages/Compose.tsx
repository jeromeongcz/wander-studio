import { useEffect, useRef, useState } from 'react';
import { api, url } from '../api';
import { ArtifactBar, withReopen } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, Icon, Loading, Modal, Pill, Tabs, fmtBytes, fmtSec, useToast } from '../ui';
import { formatName, langName } from '../types';
import type { Artifact } from '../types';
import { TimelinePlayer } from './TimelinePlayer';
import { CaptionSlider, DirectionCard, useCinematic } from './Direction';

export function ComposeStage() {
  const { project } = useProject();
  const formats = project.settings.formats ?? [];
  const [lang, setLang] = useState(project.languages[0]);
  const [fmt, setFmt] = useState(formats[0]);
  return (
    <>
      <div className="row gap wrap">
        <Tabs value={lang} onChange={setLang} items={project.languages.map((l) => ({ id: l, label: langName(l) }))} />
      </div>
      <Tabs value={fmt} onChange={setFmt} items={formats.map((f) => ({ id: f, label: formatName(f) }))} />
      <Composition key={`${lang}-${fmt}`} lang={lang} format={fmt} />
    </>
  );
}

function Composition({ lang, format }: { lang: string; format: string }) {
  const { project, find, reload } = useProject();
  const comp = find('composition', lang, format)!;
  const fin = find('final_render', lang, format)!;
  const { push } = useToast();
  const status = useAsync(() => api.get<any>(`/artifacts/${comp.id}/timeline-status`), [comp.id, comp.current_version_id, comp.state]);
  const doc = useAsync(() => (status.data?.has_timeline ? api.get<any>(`/artifacts/${comp.id}`) : Promise.resolve(null)), [comp.id, comp.current_version_id, status.data?.has_timeline]);
  const renders = useAsync(() => api.get<any[]>(`/projects/${project.id}/renders?lang=${lang}&format=${format}`), [project.id, lang, format]);
  const [t, setT] = useState(0.5);
  const [captions, setCaptions] = useState(true);
  const [popup, setPopup] = useState(false);
  useEffect(() => {
    if (!popup) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopup(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [popup]);
  const [job, setJob] = useState<any>(null);
  const tl = doc.data?.content;
  const st = status.data;
  const done = () => { reload(); status.reload(); doc.reload(); renders.reload(); };

  // follow a running render job
  useInterval(async () => {
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.state)) return;
    const j = await api.get(`/jobs/${job.id}`);
    setJob(j);
    if (['succeeded', 'failed', 'cancelled'].includes(j.state)) {
      if (j.state === 'succeeded') push('ok', 'Render finished and verified');
      else if (j.state === 'failed') push('error', j.error?.message ?? 'Render failed', j.error?.recovery ? [`Fix: ${j.error.recovery}`] : undefined);
      done();
    }
  }, job ? 600 : null);

  const build = async (effects?: string, look?: object | null) => {
    const call = (reopen: boolean) => api.post(`/artifacts/${comp.id}/build-timeline`, { reopen, effects, look });
    try { await call(false); } catch (e: any) { if (e.code === 'PROTECTED' && confirm('This composition is approved. Rebuild it?\n\nIts final render will need revision.')) await call(true); else throw e; }
    push('ok', 'Timeline built from the current script, narration, captions and visuals');
    done();
  };
  const startRender = async (variants: string[]) => {
    const j = await api.post('/jobs', { kind: 'render_composition', project_id: project.id, artifact_id: comp.id, params: { compositionId: comp.id, variants, reopen: fin.state === 'approved' && confirm('The final render is approved. Render again?\n\nThe approved version stays in history.') } });
    setJob(j);
  };
  const running = job && (job.state === 'queued' || job.state === 'running');
  // Default caption position per format = the safe zone's bottom edge (matches the server's templates).
  const defaultY = format.includes('9x16') ? 0.78 : format.includes('1x1') ? 0.86 : 0.9;
  const latest = (v: string) => (renders.data ?? []).find((r) => r.variant === v);

  return (
    <div className="stack">
      <TimelineBuilder lang={lang} format={format} timeline={tl} built={!!st?.has_timeline} stale={!!st?.stale} onBuild={build} onPick={setT} at={t} />
      <ArtifactBar artifact={comp} onChanged={done} />

      {tl && (
        <>
          <Card title="Preview" actions={<><Pill>{tl.format.width}×{tl.format.height}</Pill><Pill>{fmtSec(tl.duration)}</Pill></>}>
            <div className="stack">
              <TimelinePlayer key={comp.current_version_id ?? 'none'} timeline={tl} time={t} onTime={setT} captions={captions} onEnlarge={() => setPopup(true)}
                still={popup ? undefined : <PreviewFrame id={comp.id} version={comp.current_version_id ?? ''} t={t} captions={captions} stale={!!st?.stale} />} />
              <label className="row gap"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />Show captions</label>
              <p className="muted small" style={{ margin: 0 }}>Paused, you see an exact frame from the renderer. Playing is a quick check of pictures, voice, captions and a rough approximation of the camera and style: transitions, grain, atmosphere, sound effects, music and exact styling appear in the rendered video. The scene previews below show each transition.</p>
            </div>
          </Card>
          {popup && (
            <Modal title="Preview" wide onClose={() => setPopup(false)}>
              <TimelinePlayer timeline={tl} time={t} onTime={setT} captions={captions} autoPlay />
            </Modal>
          )}

          <DirectionCard artifact={comp} timeline={tl} onChanged={done} sceneDetails={(sceneId) => {
            const x = tl.scenes.find((v: any) => v.scene_id === sceneId);
            if (!x) return null;
            const y = tl.overrides?.[sceneId]?.caption_y_pct;
            // an approved composition is changed only after the person agrees
            const caption = async (value: number | null) => { await withReopen((reopen) => api.put(`/artifacts/${comp.id}/scenes/${sceneId}/override`, { caption_y_pct: value, reopen })); done(); };
            return (
              <>
                <div className="row gap wrap small">
                  <span>Starts {fmtSec(x.start)}</span><span>Length {fmtSec(x.duration)}</span>
                  <Pill tone={x.timing_source === 'audio' ? 'good' : 'warn'}>{x.timing_source === 'audio' ? 'from narration' : 'estimated'}</Pill>
                </div>
                <div className="row gap dir-caption">
                  <span className="small">Caption position</span>
                  <CaptionSlider value={y ?? defaultY} label={`Caption position, scene ${x.index + 1}`} onSave={caption} />
                  {y !== undefined && <Btn small kind="ghost" onClick={() => caption(null)}>Reset</Btn>}
                </div>
              </>
            );
          }} />

          <Card title="Render" actions={<span className="muted small">Final render: {fin.state.replace('_', ' ')}</span>}>
            <div className="row gap wrap">
              <Btn kind="primary" disabled={running || st?.stale || comp.state !== 'approved'} title={comp.state !== 'approved' ? 'Approve the composition first' : ''} onClick={() => startRender(['captioned', 'clean'])}>Render captioned + clean</Btn>
              <Btn disabled={running || st?.stale || comp.state !== 'approved'} onClick={() => startRender(['captioned'])}>Captioned only</Btn>
              <Btn disabled={running || st?.stale || comp.state !== 'approved'} onClick={() => startRender(['clean'])}>Clean only (use with .srt/.vtt)</Btn>
            </div>
            {comp.state !== 'approved' && <p className="muted small">Approve the composition above to enable rendering.</p>}
            {job && (
              <div className="row gap" style={{ marginTop: 12 }}>
                <Pill tone={job.state === 'succeeded' ? 'good' : job.state === 'failed' ? 'bad' : 'info'}>{job.state}</Pill>
                <div className="bar-prog grow"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
                <span className="muted small">{job.message}</span>
                {running && <Btn small kind="danger" onClick={async () => setJob(await api.post(`/jobs/${job.id}/cancel`))}>Cancel</Btn>}
              </div>
            )}
            {job?.state === 'failed' && <div className="notice bad" style={{ marginTop: 10 }}>{job.error?.message}{job.error?.recovery && <div>Fix: {job.error.recovery}</div>}</div>}
            <p className="muted small" style={{ marginBottom: 0 }}>Scenes that have not changed are reused from the cache, so small edits re-render quickly. A render only counts as done after it passes verification (codec, size, audio and length).</p>
          </Card>
        </>
      )}

      {(renders.data?.length ?? 0) > 0 && (
        <Card title="Finished videos">
          <div className="grid g2">
            {(['captioned', 'clean'] as const).map((v) => {
              const r = latest(v);
              if (!r) return null;
              return (
                <div key={v} className="stack">
                  <div className="row gap"><strong>{v === 'captioned' ? 'With captions' : 'Clean (no captions)'}</strong><span className="grow" /><span className="muted small">{fmtSec(r.duration_seconds)} · {fmtBytes(r.bytes)}</span></div>
                  <video controls preload="metadata" src={url(`/renders/${r.id}/file`)} style={{ maxWidth: '100%', maxHeight: 420, background: '#000', borderRadius: 8 }} />
                  <span className="muted small mono">sha256 {r.sha256.slice(0, 16)}…</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      <Card title="Final render approval"><ArtifactBar artifact={fin} onChanged={done} /><p className="muted small" style={{ marginBottom: 0 }}>Watch the finished video before approving. Approval is yours alone; only approved renders are included in the export package.</p></Card>
    </div>
  );
}

function PreviewFrame({ id, version, t, captions, stale }: { id: string; version: string; t: number; captions: boolean; stale: boolean }) {
  const [shown, setShown] = useState(t);
  const timer = useRef<number | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  useEffect(() => { clearTimeout(timer.current); timer.current = window.setTimeout(() => { setShown(t); setState('loading'); }, 250); return () => clearTimeout(timer.current); }, [t]);
  useEffect(() => { setState('loading'); }, [captions, version]);
  return (
    <div style={{ position: 'relative' }}>
      <img className="frame" alt="Preview frame" src={url(`/artifacts/${id}/preview-frame?t=${shown.toFixed(2)}&captions=${captions}&v=${version}`)} onLoad={() => setState('ok')} onError={() => setState('error')} style={{ width: '100%', opacity: state === 'loading' ? 0.5 : 1 }} />
      {state === 'error' && <div className="notice bad" style={{ marginTop: 8 }}>Could not draw this frame. {stale ? 'The timeline is out of date; rebuild it.' : 'Check that the visuals and caption font are available (Jobs & settings → environment check).'}</div>}
    </div>
  );
}

/** The timeline: what goes into it, one button to build it, and a strip of the scenes in order, sized by their length. */
function TimelineBuilder({ lang, format, timeline, built, stale, onBuild, onPick, at }: { lang: string; format: string; timeline?: any; built: boolean; stale: boolean; onBuild: (effects: string, look?: object | null) => Promise<void>; onPick: (t: number) => void; at: number }) {
  const { project, find, all } = useProject();
  const storyboard = find('storyboard')!;
  const visuals = all('scene_asset');
  const pictures = useAsync(() => api.get<any[]>(`/artifacts/${storyboard.id}/sketches`), [storyboard.id, storyboard.current_version_id, visuals.map((v) => v.current_version_id).join()]);
  const approved = (a?: Artifact) => a?.state === 'approved';
  const ready = visuals.filter(approved).length;
  const parts = [
    { label: 'Storyboard', ok: approved(storyboard), note: approved(storyboard) ? 'Approved' : 'Not approved', href: 'storyboard' },
    { label: 'Visuals', ok: visuals.length > 0 && ready === visuals.length, note: `${ready} of ${visuals.length} approved`, href: 'visuals' },
    { label: 'Narration', ok: approved(find('audio', lang)), note: approved(find('audio', lang)) ? 'Approved' : 'Not approved', href: 'audio' },
    { label: 'Captions', ok: approved(find('caption', lang)), note: approved(find('caption', lang)) ? 'Approved' : 'Not approved', href: 'captions' },
  ];
  const all4 = parts.every((p) => p.ok);
  const options = useCinematic();
  // the project's Cinematic Direction style, chosen in the Script step
  const chosen = project.settings.cinematic?.style;
  const direction = chosen && chosen !== 'automatic' ? chosen : undefined;
  // 'folklore' is the classic effect; other values name a cinematic style
  const asValue = (style?: string) => (!style || style === 'none' ? 'none' : `style:${style}`);
  const current: string = !timeline ? 'none' : timeline.effects ? 'folklore' : asValue(timeline.look?.style);
  // before the first build: the project's chosen style. A video that uses Cinematic Direction starts clean, because the
  // classic effect would replace its directed camera moves; otherwise folklore-type videos suggest the classic style.
  const suggested = project.settings.cinematic ? asValue(direction) : /folklore|horror|superstition|myth/i.test(project.category ?? '') ? 'folklore' : 'none';
  const sceneStyles = !!timeline?.scenes.some((s: any) => s.look);
  const [picked, setPicked] = useState<string | null>(null);
  const effects = picked ?? (timeline ? current : suggested);
  const changed = !!timeline && (effects !== current || (picked === 'none' && sceneStyles));
  const apply = () => {
    if (effects === 'folklore') return onBuild('folklore');
    // nothing picked: keep whatever the timeline already has
    if (picked === null) return onBuild(timeline ? (timeline.effects ?? 'none') : 'none');
    // "Clean" must also silence a style that comes from the project direction or from the storyboard
    if (effects === 'none') return onBuild('none', direction || sceneStyles ? { style: 'none' } : null);
    // a style that is simply the project's direction needs no override of its own
    return onBuild('none', effects === asValue(direction) ? null : { style: effects.slice(6) });
  };
  const styleInfo = options.data?.styles.find((s) => `style:${s.id}` === effects);
  const state = !built ? (all4 ? 'ready' : 'waiting') : stale || changed ? 'stale' : 'built';
  const headline = changed ? 'Scene style changed' : { waiting: 'A few approvals to go', ready: 'Everything is ready', stale: 'The timeline is out of date', built: 'Timeline built' }[state];
  const detail = {
    waiting: 'Approve the items below, then build the timeline.',
    ready: `Combine your scenes, narration and captions into the ${langName(lang)} video, ${formatName(format)}.`,
    stale: 'The storyboard, narration, captions or a visual changed. Rebuild before approving or rendering.',
    built: 'Click a scene in the strip to preview it.',
  }[state];
  const shownDetail = changed ? 'Rebuild the timeline to apply the new style to the preview and the render.' : detail;
  return (
    <section className={`tlb tlb-${state}`} aria-label="Timeline">
      <div className="tlb-head">
        <span className="tlb-icon" aria-hidden="true"><Icon name={state === 'built' ? 'check' : state === 'stale' ? 'alert' : 'film'} /></span>
        <div className="grow">
          <h3>{headline}</h3>
          <p className="muted small">{shownDetail}</p>
          {timeline && <div className="row gap wrap"><Pill tone="info">{timeline.scenes.length} scenes</Pill><Pill tone="info">{fmtSec(timeline.duration)}</Pill><Pill tone="info">{timeline.format.width}×{timeline.format.height}</Pill></div>}
        </div>
        <Btn kind={state === 'built' ? 'default' : 'primary'} onClick={async () => { await apply(); setPicked(null); }}><Icon name={built ? 'refresh' : 'spark'} small /> {changed ? 'Apply style & rebuild' : built ? 'Rebuild timeline' : 'Build timeline'}</Btn>
      </div>
      <div className="tlb-style">
        <b>Scene style</b>
        <div className="seg" role="group" aria-label="Scene style">
          {([['none', 'Clean'], ['folklore', 'Dark folklore (classic)']] as const).map(([v, label]) => <button key={v} type="button" className={effects === v ? 'on' : ''} aria-pressed={effects === v} onClick={() => setPicked(v)}>{label}</button>)}
        </div>
        <select className="tlb-more" aria-label="Cinematic visual style" value={effects.startsWith('style:') ? effects : ''} onChange={(e) => e.target.value && setPicked(e.target.value)}>
          <option value="">Cinematic styles…</option>
          {(options.data?.styles ?? []).map((s) => <option key={s.id} value={`style:${s.id}`}>{s.label}</option>)}
        </select>
        <span className="muted small">{styleInfo ? `${styleInfo.summary} Your camera moves and transitions stay as set.` : effects === 'folklore' ? 'Like your reference videos: hard cuts, a new framing about every 3 seconds, dark grade with grain and flicker, one big word at a time (names and numbers in red), impact hits, a low drone when there is no music, and a glitch ending.' : current === 'none' && sceneStyles ? 'Your storyboard camera moves and transitions, with normal captions. Some scenes carry their own style: choose Clean and rebuild to remove it.' : 'Your storyboard camera moves and transitions, with normal captions.'}</span>
      </div>
      <ul className="tlb-parts">
        {parts.map((p) => (
          <li key={p.label} className={p.ok ? 'ok' : ''}>
            <a href={`#/p/${project.id}/${p.href}`}>
              <span className="tlb-dot"><Icon name={p.ok ? 'check' : 'clock'} small /></span>
              <span><b>{p.label}</b><span className="small">{p.note}</span></span>
            </a>
          </li>
        ))}
      </ul>
      {timeline && (
        <div className="tlb-strip" role="list" aria-label="Scenes in order">
          {timeline.scenes.map((x: any) => {
            const pic = pictures.data?.find((r) => r.scene_id === x.scene_id)?.asset_id;
            const on = at >= x.start && at < x.start + x.duration;
            return (
              <button key={x.scene_id} type="button" role="listitem" className={on ? 'on' : ''} style={{ flexGrow: x.duration }} title={`${x.title} · starts ${fmtSec(x.start)}`} aria-label={`Preview scene ${x.index + 1}, ${fmtSec(x.duration)}`} onClick={() => onPick(Math.min(timeline.duration, Math.round((x.start + x.duration / 2) * 10) / 10))}>
                {pic && <img src={url(`/assets/${pic}/file`)} alt="" loading="lazy" />}
                <span className="tlb-n">{x.index + 1}</span>
                <span className="tlb-d">{fmtSec(x.duration)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
