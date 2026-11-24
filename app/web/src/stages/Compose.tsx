import { useEffect, useRef, useState } from 'react';
import { api, url } from '../api';
import { ArtifactBar } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, Loading, Pill, Tabs, fmtBytes, fmtSec, useToast } from '../ui';
import { formatName, langName } from '../types';
import type { Artifact } from '../types';

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

  const build = async () => {
    const call = (reopen: boolean) => api.post(`/artifacts/${comp.id}/build-timeline`, { reopen });
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
      <ArtifactBar artifact={comp} onChanged={done}>
        <Btn small onClick={build}>{st?.has_timeline ? 'Rebuild timeline' : 'Build timeline'}</Btn>
      </ArtifactBar>
      {st && st.has_timeline && st.stale && <div className="notice warn">The timeline is out of date: the storyboard, narration, captions or a scene visual changed since it was built. Rebuild it before approving or rendering.</div>}
      {!st?.has_timeline && <Empty>Build the timeline to combine the approved storyboard, visuals, narration and captions for {langName(lang)} in {formatName(format)}.</Empty>}

      {tl && (
        <>
          <Card title="Preview" actions={<><Pill>{tl.format.width}×{tl.format.height}</Pill><Pill>{fmtSec(tl.duration)}</Pill></>}>
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)' }}>
              <div className="stack">
                <PreviewFrame id={comp.id} version={comp.current_version_id ?? ''} t={t} captions={captions} stale={!!st?.stale} />
              </div>
              <div className="stack">
                <label className="field"><span className="field-l">Time: {fmtSec(t)}</span><input type="range" min={0} max={tl.duration} step={0.1} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label="Preview time" /></label>
                <label className="row gap"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />Show captions</label>
                <p className="muted small" style={{ margin: 0 }}>A single frame rendered with the real caption layout for this format, so you can check the safe zone and legibility before a full render.</p>
              </div>
            </div>
          </Card>

          <Card title="Scenes">
            <table>
              <thead><tr><th>#</th><th>Scene</th><th>Starts</th><th>Length</th><th>Timing</th><th>Caption position</th></tr></thead>
              <tbody>
                {tl.scenes.map((s: any) => {
                  const y = tl.overrides?.[s.scene_id]?.caption_y_pct;
                  return (
                    <tr key={s.scene_id}>
                      <td>{s.index + 1}</td><td>{s.title}</td><td>{fmtSec(s.start)}</td><td>{fmtSec(s.duration)}</td>
                      <td><Pill tone={s.timing_source === 'audio' ? 'good' : 'warn'}>{s.timing_source === 'audio' ? 'from narration' : 'estimated'}</Pill></td>
                      <td style={{ minWidth: 190 }}>
                        <div className="row gap">
                          <input type="range" min={0.3} max={0.95} step={0.01} value={y ?? defaultY} aria-label="Caption position" onChange={() => {}} onMouseUp={async (e) => { await api.put(`/artifacts/${comp.id}/scenes/${s.scene_id}/override`, { caption_y_pct: Number((e.target as HTMLInputElement).value), reopen: comp.state === 'approved' }); done(); }} onKeyUp={async (e) => { await api.put(`/artifacts/${comp.id}/scenes/${s.scene_id}/override`, { caption_y_pct: Number((e.target as HTMLInputElement).value), reopen: comp.state === 'approved' }); done(); }} />
                          {y !== undefined && <Btn small kind="ghost" onClick={async () => { await api.put(`/artifacts/${comp.id}/scenes/${s.scene_id}/override`, { caption_y_pct: null, reopen: comp.state === 'approved' }); done(); }}>Reset</Btn>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small" style={{ marginBottom: 0 }}>Moving a scene's captions overrides the format's safe-zone default for that scene only.</p>
          </Card>

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
