import { useEffect, useMemo, useRef, useState } from 'react';
import { api, url } from '../api';
import { withReopen } from '../actions';
import { useAsync, useInterval } from '../hooks';
import { Btn, CopyBtn, Field, Loading, Modal, Pill, useToast } from '../ui';
import { MAX_REFERENCE_IMAGES, prepareSceneReference, topLevelSvgGroups } from './animatedReferences';
import type { SceneReferenceImage } from './animatedReferences';
import { listAnimatedVectors, VECTOR_KINDS } from '../animatedLibrary';
import type { VectorKind } from '../animatedLibrary';

const MAX_REFINEMENT_LAYERS = 6;
const GROUP_ID = /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/;

const STYLES = {
  'dark-folklore': 'Dark Folklore Horror',
  'cinematic-25d': 'Cinematic Semi-realistic 2.5D',
  'professional-cartoon': 'Professional 2D Cartoon',
  anime: 'Anime-inspired',
  folklore: 'Folklore',
  'graphic-novel': 'Graphic Novel',
  'historical-graphic-novel': 'Historical Graphic Novel',
  'cinematic-anime': 'Cinematic Anime',
  'painterly-storybook': 'Painterly Storybook',
  'engraved-horror': 'Engraved Horror',
  custom: 'Custom Art Direction',
  watercolor: 'Watercolor Illustration',
  documentary: 'Documentary Illustration',
  'motion-graphics': 'Motion Graphics',
  minimalist: 'Minimalist Vector',
} as const;
const MODES = { static: 'Static SVG (current workflow)', animated: 'Animated SVG', mixed: 'Mixed (choose per scene)' } as const;
const QUALITIES = { draft: 'Draft', standard: 'Standard', professional: 'Professional', studio: 'Studio' } as const;
const COMPLEXITIES = { basic: 'Basic: environment and simple motion', standard: 'Standard: characters and objects', advanced: 'Advanced: articulated characters and interactions' } as const;
const PRESETS = { draft: 'Draft · 360p', preview: 'Preview · 480p', balanced: 'Balanced · 720p', professional: 'Professional · 1080p', ultra: 'Ultra · 4K' } as const;
const STRATEGIES = { 'single-pass': 'Single pass (faster)', 'multi-pass': 'Multi-pass (recommended for final scenes)' } as const;
const CAPABILITIES = {
  character: 'Character animation', environment: 'Environmental animation', dialogue: 'Dialogue and lip-sync', camera: 'Cinematic camera movement',
  advancedShading: 'Advanced shading and textures', visualReview: 'Review rendered artwork when supported', reuseApproved: 'Reuse approved assets',
} as const;
type Capability = keyof typeof CAPABILITIES;

export interface AnimatedSvgSettings {
  mode: keyof typeof MODES;
  quality: keyof typeof QUALITIES;
  style: keyof typeof STYLES;
  fps: 24 | 30 | 60;
  complexity: keyof typeof COMPLEXITIES;
  character: boolean;
  environment: boolean;
  dialogue: boolean;
  camera: boolean;
  detail: number;
  strategy: keyof typeof STRATEGIES;
  advancedShading: boolean;
  visualReview: boolean;
  reuseApproved: boolean;
  customDirection: string;
}
export const DEFAULT_ANIMATED_SVG: AnimatedSvgSettings = {
  mode: 'static', quality: 'professional', style: 'dark-folklore', fps: 30, complexity: 'standard',
  character: true, environment: true, dialogue: false, camera: true,
  detail: 70, strategy: 'multi-pass', advancedShading: true, visualReview: true, reuseApproved: true, customDirection: '',
};

export function AnimatedSvgSettingsFields({ value, change }: { value: AnimatedSvgSettings; change: (value: AnimatedSvgSettings) => void }) {
  const set = <K extends keyof AnimatedSvgSettings>(key: K, val: AnimatedSvgSettings[K]) => change({ ...value, [key]: val });
  const opts = (list: Record<string, string>) => Object.entries(list).map(([v, label]) => <option key={v} value={v}>{label}</option>);
  return (
    <fieldset className="choices">
      <legend>5. Illustration &amp; Animation Quality</legend>
      <div className="form">
        <Field label="Visual generation mode"><select value={value.mode} onChange={(e) => set('mode', e.target.value as AnimatedSvgSettings['mode'])}>{opts(MODES)}</select></Field>
        <Field label="Illustration quality"><select value={value.quality} onChange={(e) => set('quality', e.target.value as AnimatedSvgSettings['quality'])}>{opts(QUALITIES)}</select></Field>
        <Field label="Visual art style"><select value={value.style} onChange={(e) => set('style', e.target.value as AnimatedSvgSettings['style'])}>{opts(STYLES)}</select></Field>
        <Field label="Animation complexity"><select value={value.complexity} onChange={(e) => set('complexity', e.target.value as AnimatedSvgSettings['complexity'])}>{opts(COMPLEXITIES)}</select></Field>
        <Field label="Generation strategy"><select value={value.strategy} onChange={(e) => set('strategy', e.target.value as AnimatedSvgSettings['strategy'])}>{opts(STRATEGIES)}</select></Field>
        <Field label="Animation frame rate"><select value={value.fps} onChange={(e) => set('fps', Number(e.target.value) as AnimatedSvgSettings['fps'])}>{[24, 30, 60].map((n) => <option key={n}>{n}</option>)}</select></Field>
      </div>
      <Field label={`Detail preference · ${value.detail}%`} wide><input aria-label="Illustration detail preference" type="range" min={0} max={100} value={value.detail} onChange={(e) => set('detail', Number(e.target.value))} /></Field>
      <Field label="Custom art direction (optional)" wide><textarea rows={2} maxLength={1600} value={value.customDirection} onChange={(e) => set('customDirection', e.target.value)} placeholder="Specify silhouette, palette, light, composition, textures and other techniques." /></Field>
      <div className="row gap wrap" role="group" aria-label="Animation and illustration capabilities">
        {(Object.keys(CAPABILITIES) as Capability[]).map((key) => <label key={key} className="row gap small"><input type="checkbox" checked={value[key]} onChange={(e) => set(key, e.target.checked)} /> {CAPABILITIES[key]}</label>)}
      </div>
      <div className="row gap wrap">
        <p className="hint">{MODES[value.mode]} · {QUALITIES[value.quality]} · {value.fps} FPS. Static remains the default; animated clips are reviewed separately.</p>
        <CopyBtn text={JSON.stringify(value, null, 2)} label="Copy configuration" />
      </div>
    </fieldset>
  );
}

type RecordState = 'draft' | 'approved' | 'rendered' | 'attached';
type ObjectRecord = Record<string, unknown>;
interface AnimatedRecord {
  revision: string;
  state: RecordState;
  svg?: string;
  animation?: ObjectRecord;
  rig?: ObjectRecord;
  scene?: ObjectRecord;
  duration?: number;
  video?: unknown;
  assetId?: string;
  passes?: unknown[];
  hasArtworkPrompt?: boolean;
  hasMotionPrompt?: boolean;
  job?: { id: string };
  layers?: string[];
}
interface Job {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  kind?: string;
  params?: { sceneId?: string };
  created_at?: string;
  message?: string | null;
  error?: { message?: string; recovery?: string };
}
const busyJob = (j?: Job) => j?.state === 'queued' || j?.state === 'running';
const stringify = (v?: ObjectRecord) => v ? JSON.stringify(v, null, 2) : '';
const parse = (text: string, label: string, optional = false) => {
  if (!text.trim() && optional) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
};
const readFile = async (file: File, max: number) => {
  if (file.size > max) throw new Error('This file is too large. Pick a smaller SVG or JSON file.');
  return file.text();
};

function PackageField({ label, value, change, accept, max, required }: { label: string; value: string; change: (s: string) => void; accept: string; max: number; required?: boolean }) {
  const { fail } = useToast();
  return (
    <Field label={label} wide>
      <input aria-label={`Choose ${label} file`} type="file" accept={accept} onChange={async (e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file) { try { change(await readFile(file, max)); } catch (err) { fail(err); } }
      }} />
      <textarea aria-label={label} value={value} onChange={(e) => change(e.target.value)} required={required} spellCheck={false} rows={4} className="animated-code" />
    </Field>
  );
}

export function AnimatedSvgSceneModal({ artifactId, projectId, sceneId, index, title, brief, targetDuration, approvedStoryboard, onAttached, onClose }: {
  artifactId: string; projectId: string; sceneId?: string; index: number; title: string; brief: string; targetDuration: number; approvedStoryboard: boolean; onAttached: () => void; onClose: () => void;
}) {
  const path = `/artifacts/${artifactId}/animated-svg/${index}`;
  const data = useAsync(() => api.get<(AnimatedRecord | null)[]>(`/artifacts/${artifactId}/animated-svg`), [artifactId]);
  const jobs = useAsync(() => api.get<Job[]>(`/jobs?project_id=${projectId}`), [projectId]);
  const library = useAsync(listAnimatedVectors, []);
  const provider = useAsync(() => api.get<{ active: string | null; selectedModel?: string | null }>('/llm/active'), []);
  const { push, fail } = useToast();
  const record = data.data?.[index] ?? null;
  const revision = record?.revision;
  const [jobId, setJob] = useState<string>();
  const recent = (jobs.data ?? []).filter((j) => sceneId && j.params?.sceneId === sceneId && j.kind?.startsWith('animated_svg_'))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  const pending = (jobId ?? record?.job?.id) ? jobs.data?.find((j) => j.id === (jobId ?? record?.job?.id)) : recent;
  const working = !!(jobId && !pending) || busyJob(pending);
  const completedJob = useRef<string | undefined>(undefined);
  const [prompt, setPrompt] = useState(brief);
  const [references, setReferences] = useState('');
  const [providerPrompt, setProviderPrompt] = useState<{revision: string; stage: 'artwork' | 'motion'; prompt: string}>();
  const [referenceImages, setReferenceImages] = useState<SceneReferenceImage[]>([]);
  const [preparingImages, setPreparingImages] = useState(false);
  const [reviewPreview, setReviewPreview] = useState(false);
  const [reuseSource, setReuseSource] = useState('');
  const [reuseGroup, setReuseGroup] = useState('');
  const [reuseTarget, setReuseTarget] = useState('');
  const [targetLayers, setTargetLayers] = useState<string[]>([]);
  const [refineFeedback, setRefineFeedback] = useState('');
  const topLayers = useMemo(() => topLevelSvgGroups(record?.svg), [record?.svg]);
  const [reuseIndex, setReuseIndex] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [libraryTarget, setLibraryTarget] = useState('');
  const [librarySourceGroup, setLibrarySourceGroup] = useState('');
  const [libraryName, setLibraryName] = useState('');
  const [libraryKind, setLibraryKind] = useState<VectorKind>('character');
  const libraryEntries = Array.isArray(library.data) ? library.data : [];
  const [tab, setTab] = useState<'artwork' | 'animation' | 'layers' | 'render'>('artwork');
  const [svg, setSvg] = useState('');
  const [animation, setAnimation] = useState('');
  const [rig, setRig] = useState('');
  const [scene, setScene] = useState('');
  const [editing, setEditing] = useState(false);
  const editRevision = useRef<string | undefined>(undefined);
  const [time, setTime] = useState(0);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewError, setPreviewError] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewedRevision, setPreviewedRevision] = useState<string>();
  const [preset, setPreset] = useState<keyof typeof PRESETS>('balanced');

  useInterval(() => { jobs.reload(); data.reload(); }, working ? 1700 : null);
  useEffect(() => {
    if (pending && !busyJob(pending) && pending.id !== completedJob.current) {
      completedJob.current = pending.id;
      data.reload();
    }
  }, [pending, data.reload]);
  useEffect(() => {
    setTime(0); setPreviewTime(0); setPreviewError(false);
    setTargetLayers([]);
    setProviderPrompt(undefined);
    setLibrarySourceGroup('');
    setLibraryName('');
  }, [revision]);
  useEffect(() => {
    const timer = setTimeout(() => { setPreviewTime(time); setPreviewError(false); }, 220);
    return () => clearTimeout(timer);
  }, [time]);

  const start = async (action: 'generate' | 'render', body: ObjectRecord) => {
    const r = await api.post<{ job: { id: string } }>(`${path}/${action}`, { revision, ...body });
    setJob(r.job.id);
    jobs.reload();
    data.reload();
  };
  const mutate = async (action: 'import' | 'approve' | 'attach' | 'reuse', body?: ObjectRecord) => {
    if (action === 'attach') await withReopen((reopen) => api.post(`${path}/attach`, { revision, reopen, ...body }));
    else await api.post(`${path}/${action}`, { revision, ...body });
    data.reload();
    if (action === 'attach') onAttached();
  };
  const beginEdit = () => {
    editRevision.current = record?.revision;
    setSvg(record?.svg ?? '');
    setAnimation(stringify(record?.animation));
    setRig(stringify(record?.rig));
    setScene(stringify(record?.scene));
    setTab('artwork');
    setEditing(true);
  };
  const savePackage = async () => {
    if (!svg.trim()) throw new Error('Supply the layered SVG.');
    if (record && record.state !== 'draft' && !confirm('Save this as a new draft? It must be approved again before rendering.')) return;
    await mutate('import', {
      revision: editRevision.current, svg, animation: parse(animation, 'Animation'), rig: parse(rig, 'Rig', true), scene: parse(scene, 'Scene metadata', true),
    });
    setEditing(false);
    push('ok', 'Animated package saved as a draft.');
  };
  const addReferences = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.length + referenceImages.length > MAX_REFERENCE_IMAGES) {
      fail(new Error(`You can use up to ${MAX_REFERENCE_IMAGES} reference images for one scene.`));
      return;
    }
    setPreparingImages(true);
    try {
      // Decode serially: simultaneous high-resolution images waste RAM on low-powered devices.
      const prepared: SceneReferenceImage[] = [];
      for (const file of files) prepared.push(await prepareSceneReference(file));
      setReferenceImages((old) => [...old, ...prepared].slice(0, MAX_REFERENCE_IMAGES));
    } catch (error) { fail(error); }
    finally { setPreparingImages(false); }
  };
  const generateScene = async (targeted: boolean) => {
    // Refresh before displaying consent: Settings may have changed in another tab.
    const active = await api.get<{ active: string | null; selectedModel?: string | null }>('/llm/active');
    if (!active.active) throw new Error('Select an AI provider in Settings first.');
    provider.setData(active);
    const providerName = active.active;
    const intent = targeted ? 'Refine the selected layers only?' : 'Generate a layered scene?';
    if (!confirm(`${intent} The scene brief and reference notes will be sent to ${providerName}. The result will need fresh human approval.`)) return;
    const images = referenceImages;
    const allowVision = images.length > 0 || reviewPreview;
    if (allowVision) {
      const what = images.length ? `${images.length} resized reference image${images.length === 1 ? '' : 's'} and any generated previews used for visual review` : 'generated previews used for visual review';
      if (!confirm(`Also send ${what} to ${providerName}? Only include images you have permission to share.`)) return;
    }
    const libraryReuse = !targeted && libraryId ? { id: libraryId, targetId: libraryTarget.trim() } : undefined;
    const reuseLayer = !targeted && reuseSource ? { fromIndex: Number(reuseSource), sourceGroupId: reuseGroup, targetId: reuseTarget.trim() } : undefined;
    await start('generate', {
      brief: targeted ? refineFeedback.trim() : prompt,
      referenceNotes: references,
      consent: true,
      expectedProvider: providerName,
      ...(images.length ? { references: images } : {}),
      ...(allowVision ? { visionConsent: true } : {}),
      ...(reuseLayer ? { reuseLayer } : {}),
      ...(libraryReuse ? { libraryReuse } : {}),
      ...(targeted ? { targetLayerIds: targetLayers } : {}),
    });
  };
  const duration = record?.duration ?? (typeof record?.animation?.duration === 'number' ? record.animation.duration : targetDuration);
  const maxTime = Number.isFinite(duration) ? Math.max(0, duration - 0.001) : 0;
  const tracks = Array.isArray(record?.animation?.tracks) ? record.animation.tracks as ObjectRecord[] : [];
  const layerIds = record?.layers ?? (record?.svg ? [...new Set([...record.svg.matchAll(/<g\b[^>]*\bid=["']([^"'<>]+)["']/g)].map((m) => m[1]))] : []);
  const hasVideo = record?.state === 'rendered' || record?.state === 'attached';
  const reusable = (data.data ?? []).flatMap((entry, i) => i < index && entry && entry.state !== 'draft' ? [i] : []);
  const reuseEntry = reuseSource ? data.data?.[Number(reuseSource)] : undefined;
  const reuseGroupIds = useMemo(() => reuseEntry?.layers ?? topLevelSvgGroups(reuseEntry?.svg), [reuseEntry]);
  const reuseReady = !reuseSource || (reusable.includes(Number(reuseSource)) && reuseGroupIds.includes(reuseGroup) && GROUP_ID.test(reuseTarget.trim()));
  const libraryReady = !libraryId || (libraryEntries.some((entry) => entry.id === libraryId) && GROUP_ID.test(libraryTarget.trim()) && (!reuseSource || reuseTarget.trim() !== libraryTarget.trim()));
  const saveLibraryGroup = async () => {
    if (record?.state === 'draft' || !revision || !layerIds.includes(librarySourceGroup) || !libraryName.trim()) return;
    await api.post(`${path}/library`, { revision, groupId: librarySourceGroup, name: libraryName.trim(), kind: libraryKind });
    library.reload();
    setLibrarySourceGroup('');
    setLibraryName('');
    push('ok', 'Approved layer copied to the local vector library.');
  };
  const partFiles = record ? ['scene.svg', 'animation.json', ...(record.rig ? ['rig.json'] : []), 'scene.json'] : [];
  const packageUrl = (file: string) => url(`${path}/package/${file}?revision=${encodeURIComponent(revision ?? '')}`);
  const previewUrl = url(`${path}/preview?revision=${encodeURIComponent(revision ?? '')}&time=${previewTime}&attempt=${previewAttempt}`);

  const exactPrompt = (stage: 'artwork' | 'motion') => {
    if (!revision || !(stage === 'artwork' ? record?.hasArtworkPrompt : record?.hasMotionPrompt)) return null;
    const visible = providerPrompt?.revision === revision && providerPrompt.stage === stage ? providerPrompt.prompt : undefined;
    return <div className="stack">
      <Btn small onClick={async () => {
        if (visible) { setProviderPrompt(undefined); return; }
        const result = await api.get<{prompt: string}>(`${path}/prompt/${stage}?revision=${encodeURIComponent(revision)}`);
        setProviderPrompt({revision, stage, prompt: result.prompt});
      }}>{visible ? 'Hide' : 'Show'} exact {stage} prompt</Btn>
      {visible && <>
        <p className="hint">This is the exact {stage === 'artwork' ? 'base artwork' : 'motion'} prompt sent for this revision, including any earlier planning details. It does not include image bytes.</p>
        <textarea className="animated-code" aria-label={`Exact ${stage} prompt`} value={visible} readOnly rows={6} />
        <CopyBtn text={visible} label={`Copy exact ${stage} prompt`} />
      </>}
    </div>;
  };

  return (
    <Modal title={`Animated SVG · Scene ${index + 1}${title ? ` · ${title}` : ''}`} wide onClose={onClose}>
      <div className="stack animated-svg-studio">
        <p className="muted small">Create or import detailed layered SVG art with a separate motion timeline. This is optional and does not replace the static scene workflow.</p>
        {data.loading && !data.data && <Loading />}
        {data.error && <div className="notice bad" role="alert">{data.error.message}</div>}
        {!data.error && <div className="row gap wrap">
          {record && <Pill tone={record.state === 'draft' ? 'warn' : 'good'}>{record.state}</Pill>}
          <Pill>{duration.toFixed(2)} s</Pill>
          {record?.assetId && <Pill tone="good">In Asset Library</Pill>}
          {working && <span className="muted small" role="status">{pending?.message ?? (pending?.state === 'running' ? 'Working…' : 'Queued…')}</span>}
        </div>}
        {working && typeof pending?.progress === 'number' && <progress aria-label="Current animation job progress" max={1} value={Math.max(0, Math.min(1, pending.progress))} />}
        {jobs.error && working && <div className="notice warn">Could not check the job. <Btn small onClick={jobs.reload}>Retry status</Btn></div>}
        {pending?.state === 'cancelled' && <p role="status" className="notice warn">The last animation job was cancelled.</p>}
        {busyJob(pending) && pending && <div><Btn small onClick={async () => { await api.post(`/jobs/${pending.id}/cancel`); jobs.reload(); }}>Cancel current job</Btn></div>}
        {pending?.state === 'failed' && <div role="alert" className="notice bad">{pending.error?.message ?? 'The animation job failed.'}{pending.error?.recovery && <div>{pending.error.recovery}</div>}</div>}
        <div className="row gap wrap" role="group" aria-label="Animated SVG sections">
          {(['artwork', 'animation', 'layers', 'render'] as const).map((name) => <button key={name} type="button" className={`chip${tab === name ? ' on' : ''}`} aria-pressed={tab === name} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}
        </div>
        {tab === 'artwork' && <>
          <Field label="Scene art direction" wide><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} rows={3} placeholder="Anatomy, materials, foreground, background, lighting and mood…" /></Field>
          <Field label="Reference notes (optional)" wide><textarea value={references} onChange={(e) => setReferences(e.target.value)} maxLength={3000} rows={2} placeholder="Describe an approved character, background, costume, palette or style reference." /></Field>
          <Field label="Reference images (optional)" hint="Choose up to two PNG, JPEG, or WebP files. They are resized on this device and not sent until you explicitly agree. A compatible vision model is required." wide>
            <input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple disabled={preparingImages || working || referenceImages.length >= MAX_REFERENCE_IMAGES}
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = '';
                void addReferences(files);
              }} />
          </Field>
          {preparingImages && <p role="status" className="muted small">Preparing references on this device…</p>}
          {referenceImages.length > 0 && <div className="row gap wrap" aria-label="Selected reference images">
            {referenceImages.map((ref, i) => <figure key={i} className="animated-reference">
              <img src={`data:${ref.mime};base64,${ref.base64}`} alt={`Resized reference: ${ref.label}`} />
              <figcaption title={ref.label}>{ref.label}</figcaption>
              <Btn small disabled={working || preparingImages} onClick={() => setReferenceImages((v) => v.filter((_, n) => n !== i))}>Remove reference {i + 1}</Btn>
            </figure>)}
          </div>}
          <label className="row gap small"><input type="checkbox" checked={reviewPreview} disabled={working}
            onChange={(e) => setReviewPreview(e.target.checked)} /> Allow the model to review rendered previews (optional; compatible vision model required)</label>
          {reusable.some((i) => data.data?.[i]?.layers?.length) && <details className="stack animated-reuse">
            <summary>Keep one approved artwork layer during generation</summary>
            <div className="form">
              <Field label="Source scene"><select value={reuseSource} disabled={working} onChange={(e) => {
                setReuseSource(e.target.value); setReuseGroup(''); setReuseTarget('');
              }}>
                <option value="">No locked layer</option>
                {reusable.filter((i) => data.data?.[i]?.layers?.length).map((i) => <option key={i} value={i}>Scene {i + 1}</option>)}
              </select></Field>
              {reuseSource && <>
                <Field label="Approved group"><select value={reuseGroup} disabled={working} onChange={(e) => { setReuseGroup(e.target.value); setReuseTarget(e.target.value); }}>
                  <option value="">Choose a group</option>{reuseGroupIds.map((id) => <option key={id}>{id}</option>)}
                </select></Field>
                <Field label="Layer ID in the new scene"><input value={reuseTarget} disabled={working} onChange={(e) => setReuseTarget(e.target.value)}
                  maxLength={80} pattern="[A-Za-z_][A-Za-z0-9_.:\-]{0,79}" placeholder="e.g. lantern_traveler" /></Field>
              </>}
            </div>
            {reuseSource && !reuseReady && <p className="hint">Choose a source group and a receiving ID. Start the ID with a letter or underscore, then use letters, digits, dots, colons, hyphens, or underscores.</p>}
          </details>}
          <details className="stack animated-reuse">
            <summary>Keep an approved layer from the shared vector library</summary>
            {library.loading && !library.data && <Loading what="Loading approved vector layers" />}
            {library.error && <div className="notice warn">Could not load the vector library. <Btn small onClick={library.reload}>Retry</Btn></div>}
            {!library.loading && !library.error && libraryEntries.length === 0 && <p className="hint">No approved layers saved. Save artwork from this menu’s Layers section after approval.</p>}
            {libraryEntries.length > 0 && <div className="form">
              <Field label="Library asset"><select value={libraryId} disabled={working} onChange={(e) => {
                const id = e.target.value;
                setLibraryId(id);
                setLibraryTarget(libraryEntries.find((entry) => entry.id === id)?.groupId ?? '');
              }}>
                <option value="">No library layer</option>
                {libraryEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {VECTOR_KINDS[entry.kind] ?? entry.kind}</option>)}
              </select></Field>
              {libraryId && <Field label="Library layer ID in the new scene"><input value={libraryTarget} disabled={working}
                onChange={(e) => setLibraryTarget(e.target.value)} maxLength={80} placeholder="e.g. lantern_traveler" /></Field>}
            </div>}
            {libraryId && !libraryReady && <p className="hint">Use a valid receiving group ID distinct from any scene-layer reuse ID.</p>}
          </details>
          <div className="row gap wrap">
            <Btn kind="primary" disabled={!provider.data?.active || !prompt.trim() || !reuseReady || !libraryReady || working || preparingImages || !!data.error || (data.loading && !data.data)}
              onClick={() => generateScene(false)}>Generate layered scene</Btn>
            <Btn disabled={working} onClick={beginEdit}>{record ? 'Edit or replace package…' : 'Import layered SVG + JSON…'}</Btn>
          </div>
          {provider.data && !provider.data.active && <p className="hint">Select Codex, Claude, Ollama, or another available provider in <a href="#/settings">Settings</a> to generate. Import is always available.</p>}
          {provider.data?.active && <p className="hint">Provider: {provider.data.active}{provider.data.selectedModel ? ` · ${provider.data.selectedModel}` : ''}</p>}
          {reusable.length > 0 && <div className="row gap wrap">
            <Field label="Reuse approved artwork and motion"><select value={reuseIndex} onChange={(e) => setReuseIndex(e.target.value)}>
              <option value="">Choose a previous scene</option>{reusable.map((i) => <option key={i} value={i}>Scene {i + 1}</option>)}
            </select></Field>
            <Btn disabled={!reuseIndex || working} onClick={async () => {
              if (record && !confirm('Replace this scene’s package with a draft copy of the selected scene?')) return;
              await mutate('reuse', { fromIndex: Number(reuseIndex) });
              setReuseIndex('');
              setTab('animation');
              push('ok', 'Copied as a new draft. Review and adjust its timing before approval.');
            }}>Copy previous scene</Btn>
          </div>}
          {exactPrompt('artwork')}
          {record?.passes && record.passes.length > 0 && <details><summary>Generation passes ({record.passes.length})</summary><pre>{JSON.stringify(record.passes, null, 2)}</pre></details>}
        </>}
        {tab === 'animation' && <>
          {exactPrompt('motion')}
          {record && !previewError && <img className="animated-preview" key={previewUrl} src={previewUrl} alt={`Scene ${index + 1} at ${previewTime.toFixed(2)} seconds`} onLoad={() => setPreviewedRevision(revision)} onError={() => setPreviewError(true)} />}
          {record && previewError && <div className="notice warn">This frame could not be previewed. <Btn small onClick={() => { setPreviewError(false); setPreviewAttempt((x) => x + 1); }}>Retry frame</Btn></div>}
          {record ? <Field label={`Preview playhead · ${time.toFixed(2)} s`} wide><input type="range" aria-label="Preview playhead in seconds" min={0} max={maxTime} step={0.02} value={time} onChange={(e) => setTime(Number(e.target.value))} /></Field> : <p className="muted small">Generate or import a package first to preview it.</p>}
          {tracks.length > 0 && <p className="muted small">{tracks.length} motion track{tracks.length === 1 ? '' : 's'} over {duration.toFixed(2)} seconds.</p>}
          {record?.state === 'draft' && <Btn kind="primary" disabled={working || previewError || previewedRevision !== revision} onClick={() => mutate('approve')}>Approve previewed animation</Btn>}
          {record && <Btn disabled={working} onClick={beginEdit}>Edit animation JSON…</Btn>}
        </>}
        {tab === 'layers' && <>
          {layerIds.length ? <><h3>Artwork layers</h3><ul className="animated-layers">{layerIds.slice(0, 120).map((id) => <li key={id}><code>{id}</code></li>)}</ul>{layerIds.length > 120 && <p className="muted small">Showing the first 120 layers.</p>}</> : <p className="muted small">No named layers to show yet.</p>}
          {topLayers.length > 0 && <fieldset className="choices animated-refine">
            <legend>Refine selected artwork layers</legend>
            <p className="muted small">Choose up to {MAX_REFINEMENT_LAYERS} top-level groups for a targeted refinement. The result returns as a new draft for preview and approval.</p>
            <div className="row gap wrap">
              {topLayers.map((id) => {
                const checked = targetLayers.includes(id);
                return <label key={id} className="row gap small"><input type="checkbox" checked={checked}
                  disabled={working || (!checked && targetLayers.length >= MAX_REFINEMENT_LAYERS)}
                  onChange={() => setTargetLayers((old) => checked ? old.filter((layer) => layer !== id) : [...old, id])} /> <code>{id}</code></label>;
              })}
            </div>
            <Field label="Refinement feedback" wide><textarea value={refineFeedback} onChange={(e) => setRefineFeedback(e.target.value)} maxLength={3000}
              rows={3} placeholder="For example: improve the character's hand anatomy and make the cloth catch warm rim light." /></Field>
            <Btn disabled={!revision || !provider.data?.active || !targetLayers.length || !refineFeedback.trim() || working || preparingImages}
              onClick={() => generateScene(true)}>Refine selected layers</Btn>
          </fieldset>}
          {tracks.length > 0 && <details><summary>Track timing and keyframes</summary><pre>{JSON.stringify(tracks, null, 2)}</pre></details>}
          {record?.rig && <details><summary>Character rig</summary><pre>{stringify(record.rig)}</pre></details>}
          {record?.scene && <details><summary>Scene and continuity metadata</summary><pre>{stringify(record.scene)}</pre></details>}
          {record && layerIds.length > 0 && <fieldset className="choices animated-library-save">
            <legend>Save approved artwork to Asset Library</legend>
            {record.state === 'draft' ? <p className="hint">Preview and approve this revision before sharing any of its vector groups across projects.</p> : <>
              <p className="muted small">This copies the artwork and its linked definitions to the local reusable vector library. It does not change the current scene or save its motion tracks.</p>
              <div className="form">
                <Field label="Artwork group for library"><select disabled={working} value={librarySourceGroup}
                  onChange={(e) => { setLibrarySourceGroup(e.target.value); if (!libraryName) setLibraryName(e.target.value.replace(/[_-]+/g, ' ')); }}>
                  <option value="">Select a named group</option>{layerIds.map((id) => <option key={id}>{id}</option>)}
                </select></Field>
                <Field label="Library name"><input disabled={working} value={libraryName} onChange={(e) => setLibraryName(e.target.value)} maxLength={80} /></Field>
                <Field label="Library category"><select disabled={working} value={libraryKind} onChange={(e) => setLibraryKind(e.target.value as VectorKind)}>
                  {Object.entries(VECTOR_KINDS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select></Field>
              </div>
              <Btn disabled={working || !librarySourceGroup || !libraryName.trim()} onClick={saveLibraryGroup}>Copy approved group to library</Btn>
            </>}
          </fieldset>}
          {record && <details>
            <summary>Download scene package files</summary>
            <div className="row gap wrap" style={{ marginTop: '.5rem' }}>
              {partFiles.map((file) => <a key={file} className="btn btn-sm" href={packageUrl(file)} download={file}>{file}</a>)}
              <a className="btn btn-sm" href={previewUrl} download="preview.png">preview.png</a>
              {hasVideo && <a className="btn btn-sm" href={url(`${path}/video?revision=${encodeURIComponent(revision ?? '')}`)} download="scene.mp4">scene.mp4</a>}
            </div>
          </details>}
        </>}
        {tab === 'render' && <>
          <Field label="Rendering preset"><select value={preset} onChange={(e) => setPreset(e.target.value as keyof typeof PRESETS)}>{Object.entries(PRESETS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
          <p className="muted small">Higher resolutions take longer on CPU. The MP4 is rendered locally without executing SVG scripts.</p>
          {hasVideo && <video className="animated-preview" controls preload="metadata" src={url(`${path}/video?revision=${encodeURIComponent(revision ?? '')}`)} aria-label="Rendered scene video" />}
          <div className="row gap wrap">
            <Btn busy={working} kind="primary" disabled={!record || record.state === 'draft' || record.state === 'attached'} onClick={() => start('render', { preset })}>Render MP4</Btn>
            {hasVideo && <a className="btn" download={`scene-${index + 1}.mp4`} href={url(`${path}/video?revision=${encodeURIComponent(revision ?? '')}`)}>Download scene clip</a>}
            <Btn disabled={!hasVideo || !approvedStoryboard || record?.state === 'attached' || working} title={!approvedStoryboard ? 'Approve the storyboard first' : undefined} onClick={async () => {
              await mutate('attach');
              push('ok', 'Animated clip attached. Approve the visual in Visuals, then rebuild the composition timeline.');
            }}>Use in composition</Btn>
          </div>
          {!approvedStoryboard && <p className="hint">Approve the storyboard before attaching the clip to composition.</p>}
        </>}
        {editing && <section className="stack animated-import" aria-label="Edit layered scene package">
          <h3>Layered scene package</h3>
          <p className="muted small">The artwork must be a standalone, inert SVG. Its named groups are animated by the JSON tracks, not by scripts embedded in the SVG.</p>
          <PackageField label="Layered SVG" value={svg} change={setSvg} accept=".svg,image/svg+xml" max={700_000} required />
          <PackageField label="Animation JSON" value={animation} change={setAnimation} accept=".json,application/json" max={250_000} required />
          <PackageField label="Rig JSON (optional)" value={rig} change={setRig} accept=".json,application/json" max={100_000} />
          <PackageField label="Scene JSON (optional)" value={scene} change={setScene} accept=".json,application/json" max={100_000} />
          <div className="row gap"><Btn kind="primary" disabled={working || !svg.trim() || !animation.trim()} onClick={savePackage}>Save as draft</Btn><Btn kind="ghost" onClick={() => setEditing(false)}>Cancel editing</Btn></div>
        </section>}
      </div>
    </Modal>
  );
}
