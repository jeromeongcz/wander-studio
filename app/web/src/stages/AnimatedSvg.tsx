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
  'archival-sepia': 'Archival Sepia',
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
const OPTIONAL_STAGES = {
  referenceAnalysis:'Reference analysis', artDirection:'Art direction', composition:'Composition planning',
  anatomy:'Anatomy cleanup', environmentMaterials:'Materials cleanup', lighting:'Lighting refinement',
  texture:'Texture refinement', renderedReview:'Rendered quality review', targetedCorrections:'Targeted corrections',
  animationPreparation:'Animation preparation',
} as const;
type OptionalStage = keyof typeof OPTIONAL_STAGES;

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
  stages?: Partial<Record<OptionalStage, boolean>>;
  maxRevisions?: number;
  reviewFallback?: 'source-only' | 'skip';
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
      <details className="stack">
        <summary>Optional generation and review passes</summary>
        <div className="form">
          {(Object.keys(OPTIONAL_STAGES) as OptionalStage[]).map((stage) => <Field key={stage} label={OPTIONAL_STAGES[stage]}>
            <select value={value.stages?.[stage] === undefined ? 'auto' : value.stages[stage] ? 'on' : 'off'} onChange={(e) => {
              const next = {...value.stages};
              if (e.target.value === 'auto') delete next[stage]; else next[stage] = e.target.value === 'on';
              set('stages', next);
            }}><option value="auto">Use workflow default</option><option value="on">On</option><option value="off">Off</option></select>
          </Field>)}
          <Field label="Automatic correction limit"><select value={value.maxRevisions ?? 1} onChange={(e) => set('maxRevisions', Number(e.target.value))}>
            {[0,1,2,3].map(n => <option key={n} value={n}>{n}</option>)}
          </select></Field>
          <Field label="When pixel review is unavailable"><select value={value.reviewFallback ?? 'source-only'} onChange={(e) => set('reviewFallback', e.target.value as 'source-only'|'skip')}>
            <option value="source-only">Use source review, clearly labeled</option><option value="skip">Skip review</option>
          </select></Field>
        </div>
      </details>
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
  artworkApproved?: boolean;
  parentRevision?: string;
  artworkHash?: string;
  artworkSource?: {kind:string;assetId?:string;revision?:string};
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

export function AnimatedSvgSceneModal({ artifactId, projectId, sceneId, index, title, brief, targetDuration, approvedStoryboard, hasApprovedStill, onAttached, onClose }: {
  artifactId: string; projectId: string; sceneId?: string; index: number; title: string; brief: string; targetDuration: number; approvedStoryboard: boolean; hasApprovedStill?: boolean; onAttached: () => void; onClose: () => void;
}) {
  const path = `/artifacts/${artifactId}/animated-svg/${index}`;
  const data = useAsync(() => api.get<(AnimatedRecord | null)[]>(`/artifacts/${artifactId}/animated-svg`), [artifactId]);
  const jobs = useAsync(() => api.get<Job[]>(`/jobs?project_id=${projectId}`), [projectId]);
  const library = useAsync(listAnimatedVectors, []);
  const history = useAsync(() => api.get<{revision:string;saved_at:string;state:string;current:boolean;hasVideo?:number}[]>(`${path}/history`), [path]);
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
  const [motionBrief, setMotionBrief] = useState('');
  const [dialogueCues, setDialogueCues] = useState('');
  const [dialogueRecognizer, setDialogueRecognizer] = useState('phonetic');
  const [timingAudio, setTimingAudio] = useState<File>();
  const [analyzingTiming, setAnalyzingTiming] = useState(false);
  const [motionTargets, setMotionTargets] = useState<string[]>([]);
  const savedMotion = useAsync(() => api.get<{id:string;name:string}[]>('/animated-motion-library'), []);
  const [clipRoles, setClipRoles] = useState('');
  const [clipName, setClipName] = useState('');
  const [clipData, setClipData] = useState('');
  const [clipBindings, setClipBindings] = useState('');
  const [artworkPreviewed, setArtworkPreviewed] = useState<string>();
  const [artworkPreviewError, setArtworkPreviewError] = useState(false);
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
    history.reload();
    setTargetLayers([]);
    setMotionTargets([]);
    setArtworkPreviewError(false);
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
  const mutate = async (action: 'import' | 'approve' | 'approve-artwork' | 'from-still' | 'restore' | 'attach' | 'reuse', body?: ObjectRecord) => {
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
      revision: editRevision.current, svg, artworkOnly: !animation.trim(), animation: parse(animation, 'Animation', true), rig: parse(rig, 'Rig', true), scene: parse(scene, 'Scene metadata', true),
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
  const generateScene = async (operation: 'artwork' | 'motion' | 'refine-motion', targeted = false) => {
    const isArt = operation === 'artwork';
    const isMotionRefinement = operation === 'refine-motion';
    // Refresh before displaying consent: Settings may have changed in another tab.
    const active = await api.get<{ active: string | null; selectedModel?: string | null }>('/llm/active');
    if (!active.active) throw new Error('Select an AI provider in Settings first.');
    provider.setData(active);
    const providerName = active.active;
    const intent = isMotionRefinement ? 'Refine motion on the selected targets?' : !isArt ? 'Generate motion for this approved artwork?' : targeted ? 'Refine the selected artwork layers only?' : 'Generate layered artwork?';
    if (!confirm(`${intent} The scene brief and reference notes will be sent to ${providerName}. The result will need fresh human approval.`)) return;
    const images = isArt ? referenceImages : [];
    if (images.length && !confirm(`Send ${images.length} resized reference image(s) to ${providerName} for analysis? Only include images you have permission to share.`)) return;
    const allowReview = isArt && reviewPreview;
    if (allowReview && !confirm(`Send rendered artwork previews to ${providerName} for visual review?`)) return;
    const libraryReuse = isArt && !targeted && libraryId ? { id: libraryId, targetId: libraryTarget.trim() } : undefined;
    const reuseLayer = isArt && !targeted && reuseSource ? { fromIndex: Number(reuseSource), sourceGroupId: reuseGroup, targetId: reuseTarget.trim() } : undefined;
    let cues:unknown;
    if(operation==='motion'&&dialogueCues.trim()){
      try { cues = JSON.parse(dialogueCues); } catch { throw new Error('Dialogue cues must be a valid JSON array.'); }
      if(!Array.isArray(cues)) throw new Error('Dialogue cues must be a JSON array.');
    }
    await start('generate', {
      operation, brief: isArt ? (targeted ? refineFeedback.trim() : prompt) : motionBrief,
      ...(isArt ? { referenceNotes: references } : {}),
      consent: true, expectedProvider: providerName,
      ...(images.length ? { references: images, referenceVisionConsent: true } : {}),
      ...(allowReview ? { reviewVisionConsent: true } : {}),
      ...(reuseLayer ? { reuseLayer } : {}),
      ...(libraryReuse ? { libraryReuse } : {}),
      ...(targeted || isMotionRefinement ? { targetLayerIds: isArt ? targetLayers : motionTargets } : {}),
      ...(cues ? { dialogueCues: cues } : {}),
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
  const partFiles = record ? ['scene.svg', ...(record.animation ? ['animation.json'] : []), ...(record.rig ? ['rig.json'] : []), 'scene.json'] : [];
  const packageUrl = (file: string) => url(`${path}/package/${file}?revision=${encodeURIComponent(revision ?? '')}`);
  const artworkPreviewUrl = url(`${path}/preview?revision=${encodeURIComponent(revision ?? '')}&artwork=1`);
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
          {record && revision && <>
            <Pill tone={record.artworkApproved ? 'good' : 'warn'}>{record.artworkApproved ? 'Artwork approved' : 'Artwork awaiting approval'}</Pill>
            {!artworkPreviewError && <img className="animated-preview" key={artworkPreviewUrl} src={artworkPreviewUrl} alt="Current layered artwork without motion" onLoad={() => setArtworkPreviewed(revision)} onError={() => setArtworkPreviewError(true)} />}
            {artworkPreviewError && <p role="status" className="notice warn">The artwork preview could not be loaded.</p>}
            {!record.artworkApproved && <Btn kind="primary" disabled={working || artworkPreviewError || artworkPreviewed !== revision} onClick={() => mutate('approve-artwork')}>Approve previewed artwork</Btn>}
          </>}
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
              onClick={() => generateScene('artwork')}>Generate layered artwork</Btn>
            {hasApprovedStill && <Btn disabled={working} onClick={async () => {
              if (record && !confirm('Start a new layered draft from the approved still? The existing revision stays in history.')) return;
              await mutate('from-still');
            }}>Copy approved still SVG</Btn>}
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
          {record?.artworkApproved ? <>
            <Field label="Motion direction" wide><textarea value={motionBrief} onChange={e => setMotionBrief(e.target.value)} maxLength={3000} rows={2} placeholder="Describe the beats, contacts, holds, atmosphere and camera." /></Field>
            <details className="stack"><summary>Optional dialogue timing</summary>
              <Field label="Scene-relative viseme cues (JSON array)" wide><textarea value={dialogueCues} onChange={e => setDialogueCues(e.target.value)} maxLength={7000} rows={3} placeholder='[{"start":0.2,"end":0.4,"shape":"open"}]' /></Field>
              <p className="hint">Enable dialogue in the project settings. Enter your own cues, or estimate them from a WAV excerpt that starts at this scene’s first frame. Review the estimates before sending timing to the AI. The WAV is processed locally, not sent to the provider.</p>
              <div className="form">
                <Field label="Scene WAV excerpt"><input type="file" accept=".wav,audio/wav,audio/x-wav" disabled={analyzingTiming} onChange={e=>setTimingAudio(e.target.files?.[0])}/></Field>
                <Field label="Speech recognizer"><select value={dialogueRecognizer} onChange={e=>setDialogueRecognizer(e.target.value)} disabled={analyzingTiming}>
                  <option value="phonetic">Multilingual phonetic</option><option value="pocketSphinx">English</option>
                </select></Field>
              </div>
              <Btn busy={analyzingTiming} disabled={!timingAudio || working} onClick={async()=>{
                if(!timingAudio)return;
                if(timingAudio.size>12*1024*1024)throw new Error('Choose a WAV no larger than 12 MB.');
                setAnalyzingTiming(true);
                try {
                  const result=await api.postBinary<{cues:unknown[]}>(`${path}/dialogue-cues?recognizer=${dialogueRecognizer}`,timingAudio);
                  setDialogueCues(JSON.stringify(result.cues,null,2));push('ok','Estimated cues are ready for review.');
                }finally{setAnalyzingTiming(false);}
              }}>Estimate cues locally</Btn>
            </details>
            <Btn kind="primary" disabled={!provider.data?.active || working} onClick={() => generateScene('motion')}>{record.animation ? 'Generate replacement motion' : 'Generate motion for approved artwork'}</Btn>
            <details className="stack"><summary>Reuse motion without replacing artwork</summary>
              <p className="hint">Transfer reusable track timing, opacity and transforms by role. Drawings, path geometry and source pivots are not copied.</p>
              {!!record.animation && record.state !== 'draft' && <>
                <Field label="Source roles (JSON object)" wide><textarea value={clipRoles} maxLength={5000} rows={2} onChange={e=>setClipRoles(e.target.value)} placeholder='{"lantern":"source_lantern"}'/></Field>
                <Btn disabled={working || !clipRoles.trim()} onClick={async () => {
                  const clip = await api.post(`${path}/motion-clip/export`, {revision,roles:parse(clipRoles,'Motion roles')});
                  setClipData(JSON.stringify(clip,null,2)); push('ok','Reusable motion JSON is ready to copy.');
                }}>Export reusable motion</Btn>
              </>}
              {!!record.animation && record.state !== 'draft' && <div className="row gap wrap">
                <Field label="Preset name"><input value={clipName} onChange={e=>setClipName(e.target.value)} maxLength={100}/></Field>
                <Btn disabled={working || !clipName.trim() || !clipRoles.trim()} onClick={async()=>{
                  await api.post(`${path}/motion-clip/save`,{revision,name:clipName,roles:parse(clipRoles,'Motion roles')});
                  savedMotion.reload();setClipName('');push('ok','Saved to the local motion library.');
                }}>Save reusable motion preset</Btn>
              </div>}
              {(savedMotion.data?.length ?? 0)>0 && <Field label="Load saved motion">
                <select value="" onChange={async e=>{
                  try{
                    const clip=await api.get(`/animated-motion-library/${encodeURIComponent(e.target.value)}`);
                    setClipData(JSON.stringify(clip,null,2));
                  }catch(err){fail(err);}
                }}><option value="" disabled>Choose a saved motion preset</option>{savedMotion.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
              </Field>}
              <Field label="Reusable motion clip JSON" wide><textarea value={clipData} maxLength={240000} rows={3} onChange={e=>setClipData(e.target.value)}/></Field>
              {!!clipData && <CopyBtn label="Copy motion clip JSON" text={clipData}/>}
              <Field label="Destination bindings (JSON object)" wide><textarea value={clipBindings} maxLength={8000} rows={2} onChange={e=>setClipBindings(e.target.value)} placeholder='{"lantern":{"target":"new_lantern","pivot":[100,150]}}'/></Field>
              <Btn disabled={working || !clipData.trim() || !clipBindings.trim()} onClick={async () => {
                if(!confirm('Bind this reusable motion as a new draft? The current artwork remains unchanged.'))return;
                await api.post(`${path}/motion-clip/bind`,{revision,clip:parse(clipData,'Reusable motion'),bindings:parse(clipBindings,'Destination bindings')});
                data.reload();push('ok','Motion bound without changing the artwork. Review the new draft.');
              }}>Bind motion to this artwork</Btn>
            </details>
            {record.animation && tracks.length > 0 && <fieldset className="choices">
              <legend>Refine selected motion targets only</legend>
              <div className="row gap wrap">
                {[...new Set(tracks.map(t => String(t.target)))].map(id => <label className="row gap small" key={id}>
                  <input type="checkbox" checked={motionTargets.includes(id)} disabled={working || (!motionTargets.includes(id) && motionTargets.length >= 6)}
                    onChange={e => setMotionTargets(old => e.target.checked ? [...old,id] : old.filter(x => x !== id))}/><code>{id}</code>
                </label>)}
              </div>
              <Btn disabled={!provider.data?.active || working || !motionTargets.length || !motionBrief.trim()} onClick={() => generateScene('refine-motion')}>Refine selected motion</Btn>
            </fieldset>}
          </> : <p className="hint">Review and approve the layered artwork before asking for motion.</p>}
          {record?.animation && !previewError && <img className="animated-preview" key={previewUrl} src={previewUrl} alt={`Scene ${index + 1} at ${previewTime.toFixed(2)} seconds`} onLoad={() => setPreviewedRevision(revision)} onError={() => setPreviewError(true)} />}
          {record?.animation && previewError && <div className="notice warn">This frame could not be previewed. <Btn small onClick={() => { setPreviewError(false); setPreviewAttempt((x) => x + 1); }}>Retry frame</Btn></div>}
          {record?.animation ? <Field label={`Preview playhead · ${time.toFixed(2)} s`} wide><input type="range" aria-label="Preview playhead in seconds" min={0} max={maxTime} step={0.02} value={time} onChange={(e) => setTime(Number(e.target.value))} /></Field> : <p className="muted small">Generate or import motion to use the playhead.</p>}
          {tracks.length > 0 && <details className="stack"><summary>Track timeline</summary>
            {tracks.map((track,idx)=><div key={String(track.id ?? idx)} className="row gap wrap">
              <code>{String(track.target)} · {String(track.property)}</code>
              {Array.isArray(track.keys) && (track.keys as {time:number}[]).map((key,i)=><button key={i} type="button" className="chip"
                title={`Preview ${String(track.target)} at ${key.time.toFixed(2)} seconds`} onClick={()=>setTime(key.time)}>{key.time.toFixed(2)}s</button>)}
            </div>)}
          </details>}
          {tracks.length > 0 && <p className="muted small">{tracks.length} motion track{tracks.length === 1 ? '' : 's'} over {duration.toFixed(2)} seconds.</p>}
          {record?.state === 'draft' && record.animation && <Btn kind="primary" disabled={working || previewError || previewedRevision !== revision} onClick={() => mutate('approve')}>Approve previewed animation</Btn>}
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
              onClick={() => generateScene('artwork', true)}>Refine selected layers</Btn>
          </fieldset>}
          {history.data && history.data.length > 0 && <details className="stack">
            <summary>Revision history ({history.data.length})</summary>
            <ul>{history.data.map(item => <li key={item.revision}>
              <code>{item.revision.slice(0,8)}</code> · {item.state}{item.current ? ' · current' : ' '}
              {!item.current && <>
                <a className="btn btn-sm" href={url(`${path}/package/scene.svg?revision=${encodeURIComponent(item.revision)}`)} download={`scene-${item.revision.slice(0,8)}.svg`}>Download SVG</a>
                {!!item.hasVideo && <a className="btn btn-sm" href={url(`${path}/package/scene.mp4?revision=${encodeURIComponent(item.revision)}`)} download={`scene-${item.revision.slice(0,8)}.mp4`}>Download MP4</a>}
                <Btn small disabled={working} onClick={async () => {
                  if(confirm('Restore this revision as a new draft for review?')) await mutate('restore', {sourceRevision:item.revision});
                }}>Restore as draft</Btn>
              </>}
            </li>)}</ul>
          </details>}
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
          <PackageField label="Animation JSON (optional for artwork-only draft)" value={animation} change={setAnimation} accept=".json,application/json" max={250_000} />
          <PackageField label="Rig JSON (optional)" value={rig} change={setRig} accept=".json,application/json" max={100_000} />
          <PackageField label="Scene JSON (optional)" value={scene} change={setScene} accept=".json,application/json" max={100_000} />
          <div className="row gap"><Btn kind="primary" disabled={working || !svg.trim() || !animation.trim()} onClick={savePackage}>Save as draft</Btn><Btn kind="ghost" onClick={() => setEditing(false)}>Cancel editing</Btn></div>
        </section>}
      </div>
    </Modal>
  );
}
