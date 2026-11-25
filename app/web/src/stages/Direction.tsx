import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, url } from '../api';
import { withReopen } from '../actions';
import { useAsync } from '../hooks';
import { Btn, Card, Field, Icon, Loading, Modal, Pill, useToast } from '../ui';
import type { Artifact } from '../types';

/** The choices the renderer really supports, as the server lists them. */
export interface CinematicOptions {
  cameras: { id: string; label: string; cinematic: boolean; directions: string[]; simulated: boolean }[];
  intensities: string[];
  easings: string[];
  transitions: { id: string; label: string; directions: string[]; easable: boolean; colored: boolean; seconds: number }[];
  transitionIntensities: string[];
  sounds: string[];
  overlays: string[];
  styles: { id: string; label: string; summary: string; params: Record<string, any> }[];
  params: { id: string; label: string; min: number; max: number; neutral: number; group: string }[];
  gradings: string[];
  captionLooks: string[];
  ambiences: string[];
  direction: Record<'camera' | 'style' | 'transition', { id: string; label: string; guide: string }[]>;
}
export const useCinematic = () => useAsync(() => api.get<CinematicOptions>('/cinematic/options'), []);

export const words = (s: string) => s.replace(/_/g, ' ');
const SOURCE: Record<string, string> = {
  scene_override: 'set here',
  storyboard_user: 'your storyboard',
  composition_override: 'whole video',
  ai: 'generated',
  draft: 'automatic draft',
  direction: 'Cinematic Direction',
  classic: 'classic folklore',
  default: 'default',
};

type Obj = Record<string, any>;
/** Set a key, or remove it when the value is empty. */
const set = (o: Obj, k: string, v: unknown) => {
  const next = { ...o };
  if (v === '' || v === undefined) delete next[k];
  else next[k] = v;
  return next;
};

function Pick({ label, value, onChange, items, none = 'Default', hint }: { label: string; value: string | undefined; onChange: (v: string) => void; items: (string | { id: string; label: string })[]; none?: string | null; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {none !== null && <option value="">{none}</option>}
        {items.map((i) => (typeof i === 'string' ? <option key={i} value={i}>{words(i)}</option> : <option key={i.id} value={i.id}>{i.label}</option>))}
      </select>
    </Field>
  );
}

function Num({ label, value, onChange, min, max, step = 0.1, hint }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; min: number; max: number; step?: number; hint?: string }) {
  return (
    <Field label={label} hint={hint ?? `${min} to ${max}; empty for default`}>
      <input type="number" min={min} max={max} step={step} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </Field>
  );
}

function Point({ label, value, onChange }: { label: string; value: Obj | undefined; onChange: (v: Obj | undefined) => void }) {
  const axis = (k: 'x' | 'y', v: number | undefined) => onChange(v === undefined ? undefined : { x: 0.5, y: 0.5, ...value, [k]: v });
  return (
    <Field label={label} hint="Across and down, 0 to 1; empty for default">
      <span className="row gap">
        {(['x', 'y'] as const).map((k) => <input key={k} type="number" min={0} max={1} step={0.05} aria-label={`${label} ${k}`} placeholder={k} value={value?.[k] ?? ''} onChange={(e) => axis(k, e.target.value === '' ? undefined : Number(e.target.value))} />)}
      </span>
    </Field>
  );
}

export function CameraFields({ opts, value, onChange }: { opts: CinematicOptions; value: Obj | undefined; onChange: (v: Obj | undefined) => void }) {
  const move = opts.cameras.find((c) => c.id === value?.movement);
  const v = value ?? {};
  const put = (k: string, x: unknown) => onChange(set(v, k, x));
  return (
    <fieldset className="choices">
      <legend>Camera movement</legend>
      <div className="form">
        <Field label="Movement" hint={move?.simulated ? 'Simulated in 2D: the picture is flat.' : undefined}>
          <select value={v.movement ?? ''} onChange={(e) => onChange(e.target.value ? { movement: e.target.value, ...(v.intensity ? { intensity: v.intensity } : {}), ...(v.amount ? { amount: v.amount } : {}) } : undefined)}>
            <option value="">No override</option>
            <optgroup label="Cinematic">{opts.cameras.filter((c) => c.cinematic).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
            <optgroup label="Classic">{opts.cameras.filter((c) => !c.cinematic).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
          </select>
        </Field>
        {move && <Pick label="Intensity" value={v.intensity} onChange={(x) => put('intensity', x)} items={opts.intensities} none="Subtle (default)" />}
        {move && v.intensity === 'custom' && <Num label="Custom intensity" value={v.amount} onChange={(x) => put('amount', x)} min={0.1} max={3} />}
        {!!move?.directions.length && <Pick label="Direction" value={v.direction} onChange={(x) => put('direction', x)} items={move.directions} />}
      </div>
      {move && (
        <details>
          <summary className="muted small">Advanced camera settings</summary>
          <div className="form" style={{ marginTop: 8 }}>
            <Pick label="Easing" value={v.easing} onChange={(x) => put('easing', x)} items={opts.easings} />
            {v.easing === 'custom' && <Num label="Curve" value={v.curve} onChange={(x) => put('curve', x)} min={0.2} max={5} hint="Above 1 starts slowly, below 1 starts fast" />}
            <Num label="Move time (seconds)" value={v.move_seconds} onChange={(x) => put('move_seconds', x)} min={0.3} max={60} hint="Shorter is faster; then it holds" />
            <Num label="Start zoom" value={v.start_zoom} onChange={(x) => put('start_zoom', x)} min={1} max={2.5} step={0.05} />
            <Num label="End zoom" value={v.end_zoom} onChange={(x) => put('end_zoom', x)} min={1} max={2.5} step={0.05} />
            <Point label="Start position" value={v.start} onChange={(x) => put('start', x)} />
            <Point label="End position" value={v.end} onChange={(x) => put('end', x)} />
            <Point label="Focal point (subject)" value={v.focal} onChange={(x) => put('focal', x)} />
            <Num label="Rotation (degrees)" value={v.rotation} onChange={(x) => put('rotation', x)} min={-8} max={8} step={0.5} />
            <Num label="Shake" value={v.shake} onChange={(x) => put('shake', x)} min={0} max={1} />
            <Num label="Smoothness of shake" value={v.smoothness} onChange={(x) => put('smoothness', x)} min={0} max={1} />
            <Num label="Motion blur" value={v.motion_blur} onChange={(x) => put('motion_blur', x)} min={0} max={1} />
          </div>
        </details>
      )}
    </fieldset>
  );
}

export function TransitionFields({ opts, value, onChange }: { opts: CinematicOptions; value: Obj | undefined; onChange: (v: Obj | undefined) => void }) {
  const t = opts.transitions.find((x) => x.id === value?.type);
  const v = value ?? {};
  const put = (k: string, x: unknown) => onChange(set(v, k, x));
  const cut = v.type === 'cut';
  return (
    <fieldset className="choices">
      <legend>Transition into the scene</legend>
      <div className="form">
        <Pick label="Type" value={v.type} onChange={(x) => onChange(x ? { type: x } : undefined)} items={opts.transitions} none="No override" />
        {t && !cut && <Num label="Duration (seconds)" value={v.duration} onChange={(x) => put('duration', x)} min={0.1} max={2} hint={`Usually ${t.seconds}s; shortened to fit short scenes`} />}
        {!!t?.directions.length && <Pick label="Direction" value={v.direction} onChange={(x) => put('direction', x)} items={t.directions} />}
        {t && <Pick label="Sound effect" value={v.sound} onChange={(x) => put('sound', x)} items={opts.sounds} none="None" />}
      </div>
      {t && !cut && (
        <details>
          <summary className="muted small">Advanced transition settings</summary>
          <div className="form" style={{ marginTop: 8 }}>
            <Pick label="Intensity" value={v.intensity} onChange={(x) => put('intensity', x)} items={opts.transitionIntensities} none="Medium (default)" />
            {t.easable && <Pick label="Easing" value={v.easing} onChange={(x) => put('easing', x)} items={opts.easings.filter((e) => e !== 'custom')} />}
            <Num label="Extra blur" value={v.blur} onChange={(x) => put('blur', x)} min={0} max={1} hint="Motion blur on moving transitions" />
            <Pick label="Light layer" value={v.overlay} onChange={(x) => onChange(set(x ? v : set(v, 'color', t.colored ? v.color : undefined), 'overlay', x))} items={opts.overlays} none="None" />
            {(t.colored || v.overlay) && (
              <Field label="Colour" hint="Empty for default">
                <span className="row gap"><input type="color" value={v.color ?? '#ffffff'} onChange={(e) => put('color', e.target.value)} />{v.color && <Btn small kind="ghost" onClick={() => put('color', undefined)}>Clear</Btn>}</span>
              </Field>
            )}
          </div>
        </details>
      )}
    </fieldset>
  );
}

export function LookFields({ opts, value, onChange }: { opts: CinematicOptions; value: Obj | undefined; onChange: (v: Obj | undefined) => void }) {
  const style = opts.styles.find((s) => s.id === value?.style);
  const params: Obj = value?.params ?? {};
  const preset: Obj = style?.params ?? {};
  const put = (k: string, x: unknown) => onChange(set({ ...value, style: value?.style ?? 'none' }, 'params', Object.keys(set(params, k, x)).length ? set(params, k, x) : undefined));
  return (
    <fieldset className="choices">
      <legend>Visual style and effects</legend>
      <div className="form">
        <Pick label="Style" value={value?.style} onChange={(x) => onChange(x ? { style: x } : undefined)} items={[{ id: 'none', label: 'No style (own effects only)' }, ...opts.styles]} none="No override" hint={style?.summary} />
        {value && <Pick label="Colour grading" value={params.grading} onChange={(x) => put('grading', x)} items={opts.gradings} none={`From style (${preset.grading ?? 'none'})`} />}
      </div>
      {value && (
        <details>
          <summary className="muted small">Adjust colour, effects and atmosphere</summary>
          {['Colour', 'Effects', 'Atmosphere'].map((group) => (
            <div key={group} style={{ marginTop: 10 }}>
              <h4>{group}</h4>
              <div className="form">
                {opts.params.filter((p) => p.group === group).map((p) => {
                  const base = preset[p.id] ?? p.neutral;
                  const now = params[p.id] ?? base;
                  const step = p.max - p.min > 100 ? 100 : 0.01;
                  return (
                    <Field key={p.id} label={`${p.label}: ${now}`} hint={params[p.id] === undefined ? 'From the style' : undefined}>
                      <span className="row gap">
                        <input type="range" className="grow" min={p.min} max={p.max} step={step} value={now} onChange={(e) => put(p.id, Number(e.target.value))} />
                        {params[p.id] !== undefined && <Btn small kind="ghost" onClick={() => put(p.id, undefined)}>Reset</Btn>}
                      </span>
                    </Field>
                  );
                })}
              </div>
            </div>
          ))}
        </details>
      )}
    </fieldset>
  );
}

/** One-word captions and generated ambience belong to the whole video, not to one scene. */
function WholeVideoExtras({ opts, value, onChange }: { opts: CinematicOptions; value: Obj; onChange: (v: Obj) => void }) {
  const preset: Obj = opts.styles.find((s) => s.id === value.style)?.params ?? {};
  const params: Obj = value.params ?? {};
  const put = (k: string, x: string) => onChange(set(value, 'params', set(params, k, x)));
  return (
    <div className="form">
      <Pick label="Captions" value={params.captions} onChange={(x) => put('captions', x)} items={[{ id: 'track', label: 'Your caption style' }, { id: 'word', label: 'One big word at a time' }]} none={`From style (${preset.captions === 'word' ? 'one word' : 'your caption style'})`} />
      <Pick label="Generated ambience" value={params.ambience} onChange={(x) => put('ambience', x)} items={opts.ambiences} none={`From style (${words(preset.ambience ?? 'none')})`} hint="Wind and drone only, and only when no music is chosen. Add other sounds as audio in Voice & captions." />
    </div>
  );
}

function Editor({ opts, initial, wholeVideo, firstScene, onApply, onReset }: { opts: CinematicOptions; initial: Obj; wholeVideo?: boolean; firstScene?: boolean; onApply: (change: Obj) => Promise<void>; onReset: () => Promise<void> }) {
  const [draft, setDraft] = useState<Obj>(initial);
  const saved = JSON.stringify(initial);
  useEffect(() => setDraft(initial), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = ['camera', 'transition', 'look'];
  const change = Object.fromEntries(keys.filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(initial[k])).map((k) => [k, draft[k] ?? null]));
  const has = keys.some((k) => initial[k]);
  return (
    <div className="stack">
      <CameraFields opts={opts} value={draft.camera} onChange={(v) => setDraft((d) => set(d, 'camera', v))} />
      {!firstScene && <TransitionFields opts={opts} value={draft.transition} onChange={(v) => setDraft((d) => set(d, 'transition', v))} />}
      <LookFields opts={opts} value={draft.look} onChange={(v) => setDraft((d) => set(d, 'look', v))} />
      {wholeVideo && draft.look && <WholeVideoExtras opts={opts} value={draft.look} onChange={(v) => setDraft((d) => set(d, 'look', v))} />}
      <div className="row gap wrap dir-actions">
        <Btn kind="primary" disabled={!Object.keys(change).length} onClick={() => onApply(change)}>{wholeVideo ? 'Apply to the whole video' : 'Apply to this scene'}</Btn>
        {has && <Btn onClick={onReset}><Icon name="refresh" small /> Remove these overrides</Btn>}
      </div>
    </div>
  );
}

// previews are drawn one after another, so the page's other requests are never left waiting behind them
let previewQueue: Promise<unknown> = Promise.resolve();

/**
 * One scene's rendered preview, shown all the time. It is requested when first seen and plays only when the person
 * presses play. `still` is the moment shown before that: just after the change into the scene.
 */
function ScenePreview({ src, label, aspect, still }: { src: string; label: string; aspect: string; still: number }) {
  const box = useRef<HTMLDivElement>(null);
  const waiting = useRef(true); // still on the thumbnail frame, never played
  const [seen, setSeen] = useState(false);
  const [clip, setClip] = useState<{ url?: string; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const watch = new IntersectionObserver(([e]) => { if (e.isIntersecting) setSeen(true); else box.current?.querySelector('video')?.pause(); }, { rootMargin: '150px' });
    watch.observe(box.current!);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    setClip({}); // the old picture is out of date while the new one is drawn
    const stop = new AbortController();
    let made: string | undefined;
    previewQueue = previewQueue.then(async () => {
      if (stop.signal.aborted) return;
      try {
        const r = await fetch(src, { signal: stop.signal });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
        made = URL.createObjectURL(await r.blob());
        if (stop.signal.aborted) URL.revokeObjectURL(made);
        else setClip({ url: made });
      } catch (e) {
        if (!stop.signal.aborted) setClip({ error: (e as Error).message });
      }
    });
    return () => { stop.abort(); if (made) URL.revokeObjectURL(made); };
  }, [src, seen, attempt]);
  return (
    <div ref={box} className="dir-preview" style={{ aspectRatio: aspect }}>
      {clip.url ? <video src={clip.url} aria-label={label} muted playsInline controls preload="auto"
          onLoadedMetadata={(e) => { waiting.current = true; e.currentTarget.currentTime = Math.min(still, e.currentTarget.duration); }}
          onPlay={(e) => { if (waiting.current) { waiting.current = false; e.currentTarget.currentTime = 0; } }} />
        : clip.error ? <span className="small"><span>Preview failed: {clip.error}</span><Btn small onClick={() => { setClip({}); setAttempt((n) => n + 1); }}>Try again</Btn></span>
        : <span className="small"><span className="spin" /> Drawing preview…</span>}
    </div>
  );
}

/**
 * Changes only when something visible in one scene's preview changes: that scene, the end of the one before it, and
 * (when shown) that scene's own captions. A preview whose key is unchanged is not drawn again.
 */
function previewKey(tl: any, sceneId: string, captions: boolean): string {
  const k = tl.scenes.findIndex((s: any) => s.scene_id === sceneId);
  const cur = tl.scenes[k];
  if (!cur) return 'none';
  const picture = (s: any) => s && [s.asset?.sha256, s.focal, s.camera, s.look, s.duration, s.transition_in, tl.overrides?.[s.scene_id]?.crop];
  const words = captions && [
    tl.captions.style,
    tl.captions.mode,
    tl.captions.words.filter((w: any) => w.start >= cur.start - 0.05 && w.start < cur.start + cur.duration - 0.05).map((w: any) => [w.text, Math.round((w.start - cur.start) * 100), Math.round((w.end - cur.start) * 100)]),
    tl.overrides?.[sceneId]?.caption_y_pct,
  ];
  const text = JSON.stringify([tl.format, tl.effects, k === tl.scenes.length - 1, picture(tl.scenes[k - 1]), picture(cur), words]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** The person's review of this video's composition, from the card where it was changed. Nothing is approved on its own. */
function ReviewActions({ artifact, onChanged }: { artifact: Artifact; onChanged: () => void }) {
  const { push } = useToast();
  const path = `/artifacts/${artifact.id}`;
  if (artifact.state === 'approved') return <Pill tone="good">Approved</Pill>;
  if (artifact.state === 'awaiting_review') {
    return (
      <>
        <span className="small dir-note">Waiting for your approval</span>
        <Btn small kind="primary" onClick={async () => { await api.post(`${path}/approve`); push('ok', 'Approved'); onChanged(); }}><Icon name="check" small /> Approve</Btn>
      </>
    );
  }
  return (
    <>
      <span className="small dir-note">Changes not approved</span>
      <Btn small kind="primary" disabled={!artifact.current_version_id} onClick={async () => {
        // work marked for revision is resumed by saving it again, unchanged, before it can be submitted
        if (['needs_revision', 'rejected', 'failed'].includes(artifact.state)) {
          const cur = await api.get<{ content: unknown }>(path);
          await api.put(`${path}/content`, { content: cur.content });
        }
        const r = await api.post(`${path}/submit`);
        push(r.warnings?.length ? 'warn' : 'ok', r.warnings?.length ? 'Submitted for review, with warnings' : 'Submitted for review: now approve it', r.warnings);
        onChanged();
      }}>Submit for review</Btn>
    </>
  );
}

/** Review and override camera, transitions and style, per scene or for the whole video. */
export function DirectionCard({ artifact, timeline, onChanged, sceneDetails }: { artifact: Artifact; timeline: any; onChanged: () => void; sceneDetails: (sceneId: string) => ReactNode }) {
  const compId = artifact.id;
  const version = artifact.current_version_id ?? '';
  const size: { width: number; height: number } = timeline.format;
  const opts = useCinematic();
  const data = useAsync(() => api.get<any>(`/artifacts/${compId}/directions`), [compId, version]);
  const { push } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  // remembered in this browser
  const [captions, setCaptions] = useState(() => { try { return localStorage.getItem('wander-preview-captions') !== 'off'; } catch { return true; } });
  const showCaptions = (on: boolean) => { setCaptions(on); try { localStorage.setItem('wander-preview-captions', on ? 'on' : 'off'); } catch { /* storage unavailable */ } };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  if (!opts.data || !data.data) return <Card title="Scenes, camera, transitions & style">{opts.error || data.error ? <div className="notice bad">{(opts.error ?? data.error)!.message}</div> : <Loading />}</Card>;
  const o = opts.data;
  const d = data.data;
  const done = (text: string) => { push('ok', text); setOpen(null); data.reload(); onChanged(); };
  const save = async (path: string, change: Obj, text: string) => {
    await withReopen((reopen) => api.put(path, { ...change, reopen }));
    done(text);
  };
  const clear = { camera: null, transition: null, look: null };
  const name = {
    camera: (v: Obj) => o.cameras.find((c) => c.id === v.movement)?.label ?? v.movement,
    transition: (v: Obj) => `${o.transitions.find((t) => t.id === v.type)?.label ?? v.type}${v.duration ? ` ${v.duration}s` : ''}`,
    look: (v: Obj | null) => (!v ? 'No style' : v.style === 'none' ? 'Own effects' : o.styles.find((s) => s.id === v.style)?.label ?? v.style),
  };
  const tag = (label: string, text: string, source: string) => (
    <Pill tone={source === 'scene_override' || source === 'composition_override' ? 'info' : 'neutral'}>{label}: {text} · {SOURCE[source] ?? source}</Pill>
  );
  return (
    <Card title="Scenes, camera, transitions & style" className={artifact.state === 'approved' ? '' : 'dir-changed'} actions={<ReviewActions artifact={artifact} onChanged={onChanged} />}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>What wins, strongest first: a scene setting here, your own storyboard edits, the whole-video setting, then generated directions. Changing anything here only affects this video.{d.classic && ' The classic folklore style is on: it decides camera, cuts and grade except where you set a scene here.'}</p>
        <details className="dir-all">
          <summary><b>Whole video</b> <span className="muted small">{Object.keys(d.overrides_all).length ? 'has settings' : 'no settings'}</span></summary>
          <div style={{ marginTop: 10 }}>
            <Editor opts={o} wholeVideo initial={d.overrides_all}
              onApply={(change) => save(`/artifacts/${compId}/override-all`, change, 'Whole-video settings applied')}
              onReset={() => save(`/artifacts/${compId}/override-all`, clear, 'Whole-video settings removed')} />
          </div>
        </details>
        <p className="muted small" style={{ margin: 0 }}>Press play on a preview to watch the change into the scene and its start. Previews are silent, small and drawn by the renderer; the first visit takes a little while, and they are drawn again after a change. Moving a scene’s captions overrides the format’s safe-zone default for that scene only.</p>
        <label className="row gap"><input type="checkbox" checked={captions} onChange={(e) => showCaptions(e.target.checked)} />Show captions in the previews</label>
        <div className="dir-wrap">
          <ul className="dir-list">
            {d.scenes.map((s: any) => (
              <li key={s.scene_id} className={size.width > size.height ? 'wide' : ''}>
                <ScenePreview src={url(`/artifacts/${compId}/scenes/${s.scene_id}/preview?captions=${captions}&v=${previewKey(timeline, s.scene_id, captions)}`)} label={`Preview of scene ${s.index + 1}`} aspect={`${size.width} / ${size.height}`} still={s.index > 0 ? 1.3 : 0.1} />
                <div className="dir-info">
                  <div className="row gap wrap">
                    <span className="scene-n">{s.index + 1}</span>
                    <b className="grow">{s.title}</b>
                  </div>
                  <div className="row gap wrap">
                    {tag('Camera', name.camera(s.camera.value), s.camera.source)}
                    {s.index > 0 && tag('Transition', name.transition(s.transition.value), s.transition.source)}
                    {tag('Style', d.classic && !s.look.value ? 'Dark folklore (classic)' : name.look(s.look.value), s.look.source)}
                  </div>
                  {sceneDetails(s.scene_id)}
                  <button type="button" className="dir-adjust" onClick={() => setOpen(s.scene_id)} aria-label={`Make adjustments to scene ${s.index + 1}`}><Icon name="gear" small /> Make Adjustments</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        {artifact.state !== 'approved' && <div className="row gap wrap dir-review"><ReviewActions artifact={artifact} onChanged={onChanged} /></div>}
      </div>
      {(() => {
        const s = d.scenes.find((x: any) => x.scene_id === open);
        if (!s) return null;
        const own = d.overrides[s.scene_id] ?? {};
        const initial = Object.fromEntries(['camera', 'transition', 'look'].filter((k) => own[k]).map((k) => [k, own[k]]));
        return (
          <Modal title={`Adjust scene ${s.index + 1}: ${s.title}`} wide onClose={() => setOpen(null)}>
            <Editor opts={o} firstScene={s.index === 0} initial={initial}
              onApply={(change) => save(`/artifacts/${compId}/scenes/${s.scene_id}/override`, change, `Scene ${s.index + 1} updated`)}
              onReset={() => save(`/artifacts/${compId}/scenes/${s.scene_id}/override`, clear, `Scene ${s.index + 1} back to its generated direction`)} />
          </Modal>
        );
      })()}
    </Card>
  );
}

export interface CinematicChoice { camera: string; style: string; transition: string; custom_text: string }
export const NO_CHOICE: CinematicChoice = { camera: 'automatic', style: 'automatic', transition: 'automatic', custom_text: '' };

/** The Cinematic Direction fields of the Script step. */
export function CinematicDirectionFields({ opts, value, onChange, onDone }: { opts: CinematicOptions; value: CinematicChoice; onChange: (v: CinematicChoice) => void; onDone: (v: CinematicChoice) => void }) {
  const pick = (key: 'camera' | 'style' | 'transition', label: string) => (
    <Field label={label} hint={opts.direction[key].find((o) => o.id === value[key])?.guide}>
      <select value={value[key]} onChange={(e) => { const next = { ...value, [key]: e.target.value }; onChange(next); onDone(next); }}>
        {opts.direction[key].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </Field>
  );
  const custom = [value.camera, value.style, value.transition].includes('custom');
  return (
    <>
      <div className="form">
        {pick('camera', 'Cinematic camera movement')}
        {pick('style', 'Cinematic visual style')}
        {pick('transition', 'Scene transition style')}
      </div>
      {(custom || value.custom_text) && (
        <Field label="Custom direction (optional)" wide hint="For example: slow establishing shots, close-ups on emotional moments, subtle transitions except during reveals.">
          <textarea rows={3} maxLength={600} value={value.custom_text} onChange={(e) => onChange({ ...value, custom_text: e.target.value })} onBlur={() => onDone(value)} />
        </Field>
      )}
      <p className="hint">Saved with this video. It guides the next script and its scene directions; nothing already written or approved changes. You can override everything in Compose & render.</p>
    </>
  );
}

/** One line describing the instructions the writer gave a section or a storyboard scene. */
export function directionSummary(c: { camera?: any; transition?: any; look?: any } | undefined): string {
  if (!c) return '';
  const look = c.look ?? {};
  return [
    c.camera && `Camera: ${words(c.camera.movement)}${c.camera.intensity ? ` (${c.camera.intensity})` : ''}`,
    c.transition && `Transition: ${words(c.transition.type)}`,
    look.style && look.style !== 'none' && `Style: ${words(look.style)}`,
    ...['shot', 'composition', 'lighting', 'color', 'atmosphere'].map((k) => look[k] && `${k[0].toUpperCase()}${k.slice(1)}: ${look[k]}`),
    look.params && `Effects: ${Object.keys(look.params).map(words).join(', ')}`,
  ].filter(Boolean).join(' · ');
}

/** Where one scene's captions sit. It follows the pointer and saves when released. */
export function CaptionSlider({ value, label, onSave }: { value: number; label: string; onSave: (v: number) => Promise<void> }) {
  const { fail } = useToast();
  const [now, setNow] = useState(value);
  useEffect(() => setNow(value), [value]);
  const release = async (v: number) => {
    if (v === value) return;
    try { await onSave(v); } catch (e) { setNow(value); fail(e); }
  };
  return <input type="range" min={0.3} max={0.95} step={0.01} value={now} aria-label={label} onChange={(e) => setNow(Number(e.target.value))} onPointerUp={(e) => release(Number(e.currentTarget.value))} onKeyUp={(e) => release(Number(e.currentTarget.value))} />;
}
