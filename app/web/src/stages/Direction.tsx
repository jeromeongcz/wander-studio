import { useEffect, useState } from 'react';
import { api, url } from '../api';
import { withReopen } from '../actions';
import { useAsync } from '../hooks';
import { Btn, Card, Field, Icon, Loading, Pill, useToast } from '../ui';

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
      <div className="row gap wrap">
        <Btn kind="primary" disabled={!Object.keys(change).length} onClick={() => onApply(change)}>{wholeVideo ? 'Apply to the whole video' : 'Apply to this scene'}</Btn>
        {has && <Btn onClick={onReset}><Icon name="refresh" small /> Remove these overrides</Btn>}
      </div>
    </div>
  );
}

/** Review and override camera, transitions and style, per scene or for the whole video. */
export function DirectionCard({ compId, version, onChanged }: { compId: string; version: string; onChanged: () => void }) {
  const opts = useCinematic();
  const data = useAsync(() => api.get<any>(`/artifacts/${compId}/directions`), [compId, version]);
  const { push } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  if (!opts.data || !data.data) return <Card title="Camera, transitions & style">{opts.error || data.error ? <div className="notice bad">{(opts.error ?? data.error)!.message}</div> : <Loading />}</Card>;
  const o = opts.data;
  const d = data.data;
  const done = (text: string) => { push('ok', text); setPreview(null); data.reload(); onChanged(); };
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
    <Card title="Camera, transitions & style" actions={<Btn small title="Use these overrides in the other languages and formats of this video" onClick={async () => {
      if (!confirm('Copy the camera, transition and style overrides to every other language and format of this video?\n\nTheir own camera, transition and style overrides are replaced. Caption positions and crops are kept.')) return;
      let r = await api.post<any>(`/artifacts/${compId}/copy-direction`, {});
      if (r.skipped.some((s: any) => /approved/.test(s.reason)) && confirm('Some of them are approved. Change those too? Their final renders will need revision.')) r = await api.post<any>(`/artifacts/${compId}/copy-direction`, { reopen: true });
      push(r.skipped.length ? 'warn' : 'ok', r.copied.length ? `Copied to ${r.copied.length}` : 'Nothing was copied', r.skipped.map((s: any) => `${s.label}: ${s.reason}`));
    }}>Copy to other videos</Btn>}>
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
        <ul className="dir-list">
          {d.scenes.map((s: any) => {
            const own = d.overrides[s.scene_id] ?? {};
            const initial = Object.fromEntries(['camera', 'transition', 'look'].filter((k) => own[k]).map((k) => [k, own[k]]));
            const isOpen = open === s.scene_id;
            return (
              <li key={s.scene_id}>
                <div className="row gap wrap">
                  <span className="scene-n">{s.index + 1}</span>
                  <b className="grow">{s.title}</b>
                  <Btn small onClick={() => setPreview(preview === s.scene_id ? null : s.scene_id)}><Icon name="play" small /> {preview === s.scene_id ? 'Hide preview' : 'Preview'}</Btn>
                  <Btn small kind={isOpen ? 'primary' : 'default'} onClick={() => setOpen(isOpen ? null : s.scene_id)}>{isOpen ? 'Close' : 'Adjust'}</Btn>
                </div>
                <div className="row gap wrap">
                  {tag('Camera', name.camera(s.camera.value), s.camera.source)}
                  {s.index > 0 && tag('Transition', name.transition(s.transition.value), s.transition.source)}
                  {tag('Style', d.classic && !s.look.value ? 'Dark folklore (classic)' : name.look(s.look.value), s.look.source)}
                </div>
                {preview === s.scene_id && (
                  <div>
                    <video key={version} className="dir-preview" src={url(`/artifacts/${compId}/scenes/${s.scene_id}/preview?v=${version}`)} autoPlay loop muted playsInline controls />
                    <p className="muted small">A silent, small preview from the renderer: the change into this scene and its start, without captions. It can take a little while to appear.</p>
                  </div>
                )}
                {isOpen && <Editor opts={o} firstScene={s.index === 0} initial={initial}
                  onApply={(change) => save(`/artifacts/${compId}/scenes/${s.scene_id}/override`, change, `Scene ${s.index + 1} updated`)}
                  onReset={() => save(`/artifacts/${compId}/scenes/${s.scene_id}/override`, clear, `Scene ${s.index + 1} back to its generated direction`)} />}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
