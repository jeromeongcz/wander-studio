import { useState } from 'react';
import { api } from '../api';
import { withReopen } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Field, Icon, Loading, Modal, Pill, useToast } from '../ui';
import { FORMAT_LABEL, langName } from '../types';
import { startTask, useTask } from '../progress';
import { CinematicDirectionFields, NO_CHOICE, useCinematic } from './Direction';
import type { CinematicChoice } from './Direction';
import { AnimatedSvgSettingsFields, DEFAULT_ANIMATED_SVG } from './AnimatedSvg';
import type { AnimatedSvgSettings } from './AnimatedSvg';

const LENGTHS = [15, 30, 45, 60, 90, 180];
const SHAPES: Record<string, { w: number; h: number; use: string }> = {
  vertical_9x16: { w: 18, h: 32, use: 'Shorts, Reels, TikTok' },
  horizontal_16x9: { w: 36, h: 20, use: 'YouTube, TV' },
  square_1x1: { w: 28, h: 28, use: 'Feed posts' },
};
const lengthLabel = (s: number) => (s < 60 ? `${s} sec` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} sec`);

/** Choose how long and what shape the video is, then have Claude write narration and a detailed visual brief from the approved topic. */
const recommended = (seconds: number) => Math.max(4, Math.round(seconds / 4));
const mostScenes = (seconds: number) => Math.min(150, Math.floor(seconds / 2.5));

export function ScriptWriterCard({ artifactId, initialSeconds, initialScenes, hasText, onWritten }: { artifactId: string; initialSeconds: number; initialScenes?: number; hasText: boolean; onWritten: () => void }) {
  const { project, find, reload } = useProject();
  const research = find('research')!;
  const approved = research.state === 'approved';
  const topic = useAsync(() => api.get<any>(`/artifacts/${research.id}`), [research.id, research.current_version_id]);
  const status = useAsync(() => api.get<any>('/research/status'), []);
  const { push, fail } = useToast();
  const [seconds, setSeconds] = useState(initialSeconds);
  // null means "follow the length"
  const [picked, setPicked] = useState<number | null>(initialScenes ?? null);
  const scenes = picked ?? recommended(seconds);
  const [notes, setNotes] = useState('');
  const options = useCinematic();
  const [direction, setDirection] = useState<CinematicChoice>({ ...NO_CHOICE, ...project.settings.cinematic });
  const saveDirection = async (v: CinematicChoice) => { await api.put(`/projects/${project.id}/cinematic`, v); reload(); };
  const [animatedSvg, setAnimatedSvg] = useState<AnimatedSvgSettings>({ ...DEFAULT_ANIMATED_SVG, ...project.settings.animatedSvg });
  const [animationSettingsChanged, setAnimationSettingsChanged] = useState(false);
  const saveWritingSettings = async () => {
    await api.put(`/projects/${project.id}/cinematic`, direction);
    if (animationSettingsChanged || project.settings.animatedSvg) {
      await api.put(`/projects/${project.id}/animated-svg-settings`, animatedSvg);
      setAnimationSettingsChanged(false);
    }
    reload();
  };
  const writing = !!useTask(artifactId);
  const [manual, setManual] = useState(false);
  const formats = project.settings.formats ?? ['vertical_9x16'];
  const secondsOk = Number.isInteger(seconds) && seconds >= 15 && seconds <= 600;
  const scenesOk = Number.isInteger(scenes) && scenes >= 3 && scenes <= mostScenes(seconds);
  const valid = secondsOk && scenesOk;

  const toggle = async (f: string) => {
    try {
      if (formats.includes(f)) await api.del(`/projects/${project.id}/formats/${f}`);
      else await api.post(`/projects/${project.id}/formats`, { format: f });
      reload();
    } catch (e) { fail(e); }
  };

  const generate = async () => {
    if (hasText && !confirm('Replace the current script with a new one?\n\nThe current version stays in History.')) return;
    if (!sessionStorage.getItem('wander-cc-script-ok-2')) {
      if (!confirm('This asks Claude Code on this computer to write the script, using your Claude plan.\n\nIt gets no tools. Only the topic, its facts, the category, length, format, language, your cinematic direction (including any custom text) and your notes are sent.\n\nContinue?')) return;
      sessionStorage.setItem('wander-cc-script-ok-2', '1');
    }
    await saveWritingSettings();
    const done = startTask(artifactId, 'Writing the script…', `${scenes} scenes for a ${lengthLabel(seconds)} video. This can take a few minutes.`);
    try {
      const r: any = await withReopen((reopen) => api.post(`/artifacts/${artifactId}/script/generate`, { seconds, scenes, notes, reopen }));
      push(r.sections === r.requested ? 'ok' : 'warn', r.sections === r.requested ? `Script written: ${r.sections} scenes. Read it, edit it, then submit it for review.` : `Script written with ${r.sections} scenes, not the ${r.requested} you asked for. Add or remove scenes, or rewrite.`);
      reportDirections(push, r);
      onWritten();
    } finally {
      done();
    }
  };

  return (
    <Card title="Write the script from your topic">
      <div className="stack">
        <div className="callout">
          <span className="icon-wrap"><Icon name="spark" /></span>
          <div className="grow">
            <h3>{topic.data?.content?.topic ?? project.name}</h3>
            {topic.data?.content?.angle && <p className="muted small" style={{ margin: '4px 0 6px' }}>{topic.data.content.angle}</p>}
            <div className="row gap wrap">
              <Pill tone={approved ? 'good' : 'warn'}>{approved ? 'Approved topic' : 'Topic not approved yet'}</Pill>
              {topic.data?.content && <Pill>{topic.data.content.claims.length} facts</Pill>}
              <Pill>{langName(project.languages[0] ?? 'en')}</Pill>
            </div>
          </div>
        </div>

        <fieldset className="choices">
          <legend>1. How long is the video?</legend>
          <div className="row gap wrap">
            {LENGTHS.map((s) => <button key={s} type="button" className={`chip${seconds === s ? ' on' : ''}`} aria-pressed={seconds === s} onClick={() => setSeconds(s)}>{lengthLabel(s)}</button>)}
            <label className="row gap small">or <input type="number" min={15} max={600} value={seconds} style={{ width: 90 }} aria-label="Length in seconds" onChange={(e) => setSeconds(Math.round(Number(e.target.value)))} /> seconds</label>
          </div>
          {seconds > 60 && <p className="hint">Over 60 seconds is long-form: it will not fit YouTube Shorts.</p>}
          {!secondsOk && <p className="hint" style={{ color: 'var(--bad)' }}>Choose between 15 and 600 seconds.</p>}
        </fieldset>

        <fieldset className="choices">
          <legend>2. How many storyboard scenes?</legend>
          <div className="row gap wrap">
            <button type="button" className={`chip${picked === null ? ' on' : ''}`} aria-pressed={picked === null} onClick={() => setPicked(null)}>Recommended ({recommended(seconds)})</button>
            {[4, 6, 8, 10, 12, 16, 20].filter((n) => n <= mostScenes(seconds)).map((n) => <button key={n} type="button" className={`chip${picked === n ? ' on' : ''}`} aria-pressed={picked === n} onClick={() => setPicked(n)}>{n}</button>)}
            <label className="row gap small">or <input type="number" min={3} max={mostScenes(seconds)} value={scenes} style={{ width: 90 }} aria-label="Number of scenes" onChange={(e) => setPicked(Math.round(Number(e.target.value)))} /> scenes</label>
          </div>
          {scenesOk ? <p className="hint">About {Math.round((seconds / scenes) * 10) / 10} seconds per scene. Each scene gets its own narration and picture description.</p> : secondsOk && <p className="hint" style={{ color: 'var(--bad)' }}>For {lengthLabel(seconds)} choose between 3 and {mostScenes(seconds)} scenes.</p>}
        </fieldset>

        <fieldset className="choices">
          <legend>3. Which dimension?</legend>
          <div className="row gap wrap">
            {Object.entries(SHAPES).map(([f, s]) => {
              const on = formats.includes(f);
              return (
                <button key={f} type="button" className={`shape${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(f)}>
                  <span className="shape-box"><i style={{ width: s.w, height: s.h }} /></span>
                  <span><b>{FORMAT_LABEL[f]}</b><span className="muted small">{s.use}</span></span>
                  {on && <Icon name="check" small />}
                </button>
              );
            })}
          </div>
          <p className="hint">Pick one or more. Each gets its own composition and render.</p>
        </fieldset>

        <fieldset className="choices">
          <legend>4. Cinematic Direction</legend>
          {options.data ? <CinematicDirectionFields opts={options.data} value={direction} onChange={setDirection} onDone={(v) => saveDirection(v).catch(fail)} /> : options.error ? <div className="notice bad">{options.error.message}</div> : <Loading />}
        </fieldset>

        <AnimatedSvgSettingsFields value={animatedSvg} change={(v) => { setAnimatedSvg(v); setAnimationSettingsChanged(true); }} />
        {animationSettingsChanged && <div className="row"><Btn onClick={saveWritingSettings}>Save illustration settings</Btn></div>}

        <Field label="6. Anything else for the writer? (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} placeholder="e.g. mysterious tone, narrator speaks to the viewer, painterly illustration style" /></Field>

        {!approved && <div className="notice warn">Approve the topic first (step 1). The script is written only from the approved research.</div>}
        {status.data && !status.data.loggedIn && <div className="notice warn"><strong>{status.data.detail}.</strong> {status.data.fix}</div>}
        {status.error && <div className="notice bad">Could not check Claude Code. Restart the server (<code>npm start</code>) and refresh.</div>}
        <div className="row gap wrap">
          <Btn kind="primary" disabled={!approved || !valid || writing || !status.data?.loggedIn} busy={writing} onClick={generate}><Icon name="spark" small /> {writing ? 'Writing the script…' : hasText ? 'Rewrite script' : 'Generate script'}</Btn>
          <Btn disabled={!approved || !valid || writing} onClick={async () => { await saveWritingSettings(); setManual(true); }}>Use a prompt instead…</Btn>
          <span className="muted small">{writing ? 'This can take a few minutes. Keep this page open.' : 'You get narration plus setting, characters, action, shot, mood and props for every scene.'}</span>
        </div>
      </div>
      {manual && <ManualScript artifactId={artifactId} seconds={seconds} scenes={scenes} notes={notes} onClose={() => setManual(false)} onDone={() => { setManual(false); onWritten(); }} />}
    </Card>
  );
}

/** Say plainly which of the writer's instructions could not be used. */
function reportDirections(push: (kind: 'ok' | 'warn', text: string, list?: string[]) => void, r: { sections: number; directed?: number; dropped?: string[] }) {
  if ((r.directed ?? 0) < r.sections) push('warn', `${r.sections - (r.directed ?? 0)} scene(s) came without camera and style directions; automatic ones will be used.`);
  if (r.dropped?.length) push('warn', 'Some directions were not understood and were left out', r.dropped);
}

function ManualScript({ artifactId, seconds, scenes, notes, onClose, onDone }: { artifactId: string; seconds: number; scenes: number; notes: string; onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const prompt = useAsync(() => api.post<{ prompt: string }>(`/artifacts/${artifactId}/script/prompt`, { seconds, scenes, notes }), []);
  const [text, setText] = useState('');
  return (
    <Modal title="Write the script with a prompt" wide onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>1) Copy the prompt into any AI. 2) Paste its JSON answer below. It is checked before it is saved.</p>
        {prompt.error ? <div className="notice bad">{prompt.error.message}</div> : !prompt.data ? <Loading /> : <><div className="row gap"><CopyBtn text={prompt.data.prompt} label="Copy prompt" /></div><pre>{prompt.data.prompt}</pre></>}
        <Field label="Paste the answer here" wide><textarea style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"title":"","characters":[],"sections":[]}' /></Field>
        <div className="row gap">
          <Btn kind="primary" disabled={!text.trim()} onClick={async () => { const r: any = await withReopen((reopen) => api.post(`/artifacts/${artifactId}/script/import`, { text, seconds, scenes, reopen })); push('ok', `Script imported: ${r.sections} scenes`); reportDirections(push, r); onDone(); }}>Import script</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
