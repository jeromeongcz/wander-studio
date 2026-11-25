import { useState } from 'react';
import { api } from '../api';
import { withReopen } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Field, Icon, Loading, Modal, Pill, useToast } from '../ui';
import { FORMAT_LABEL, langName } from '../types';

const LENGTHS = [15, 30, 45, 60, 90, 180];
const SHAPES: Record<string, { w: number; h: number; use: string }> = {
  vertical_9x16: { w: 18, h: 32, use: 'Shorts, Reels, TikTok' },
  horizontal_16x9: { w: 36, h: 20, use: 'YouTube, TV' },
  square_1x1: { w: 28, h: 28, use: 'Feed posts' },
};
const lengthLabel = (s: number) => (s < 60 ? `${s} sec` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} sec`);

/** Choose how long and what shape the video is, then have Claude write narration and a detailed visual brief from the approved topic. */
export function ScriptWriterCard({ artifactId, initialSeconds, hasText, onWritten }: { artifactId: string; initialSeconds: number; hasText: boolean; onWritten: () => void }) {
  const { project, find, reload } = useProject();
  const research = find('research')!;
  const approved = research.state === 'approved';
  const topic = useAsync(() => api.get<any>(`/artifacts/${research.id}`), [research.id, research.current_version_id]);
  const status = useAsync(() => api.get<any>('/research/status'), []);
  const { push, fail } = useToast();
  const [seconds, setSeconds] = useState(initialSeconds);
  const [notes, setNotes] = useState('');
  const [writing, setWriting] = useState(false);
  const [manual, setManual] = useState(false);
  const formats = project.settings.formats ?? ['vertical_9x16'];
  const valid = Number.isInteger(seconds) && seconds >= 15 && seconds <= 600;

  const toggle = async (f: string) => {
    try {
      if (formats.includes(f)) await api.del(`/projects/${project.id}/formats/${f}`);
      else await api.post(`/projects/${project.id}/formats`, { format: f });
      reload();
    } catch (e) { fail(e); }
  };

  const generate = async () => {
    if (hasText && !confirm('Replace the current script with a new one?\n\nThe current version stays in History.')) return;
    if (!sessionStorage.getItem('wander-cc-script-ok')) {
      if (!confirm('This asks Claude Code on this computer to write the script, using your Claude plan.\n\nIt gets no tools. Only the topic, its facts, the category, length, format, language and your notes are sent.\n\nContinue?')) return;
      sessionStorage.setItem('wander-cc-script-ok', '1');
    }
    setWriting(true);
    try {
      const r: any = await withReopen((reopen) => api.post(`/artifacts/${artifactId}/script/generate`, { seconds, notes, reopen }));
      push('ok', `Script written: ${r.sections} scenes. Read it, edit it, then submit it for review.`);
      onWritten();
    } finally {
      setWriting(false);
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
          {!valid && <p className="hint" style={{ color: 'var(--bad)' }}>Choose between 15 and 600 seconds.</p>}
        </fieldset>

        <fieldset className="choices">
          <legend>2. Which dimension?</legend>
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

        <Field label="3. Anything else for the writer? (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} placeholder="e.g. mysterious tone, narrator speaks to the viewer, painterly illustration style" /></Field>

        {!approved && <div className="notice warn">Approve the topic first (step 1). The script is written only from the approved research.</div>}
        {status.data && !status.data.loggedIn && <div className="notice warn"><strong>{status.data.detail}.</strong> {status.data.fix}</div>}
        {status.error && <div className="notice bad">Could not check Claude Code. Restart the server (<code>npm start</code>) and refresh.</div>}
        <div className="row gap wrap">
          <Btn kind="primary" disabled={!approved || !valid || writing || !status.data?.loggedIn} busy={writing} onClick={generate}><Icon name="spark" small /> {writing ? 'Writing the script…' : hasText ? 'Rewrite script' : 'Generate script'}</Btn>
          <Btn disabled={!approved || !valid || writing} onClick={() => setManual(true)}>Use a prompt instead…</Btn>
          <span className="muted small">{writing ? 'This can take a few minutes. Keep this page open.' : 'You get narration plus setting, characters, action, shot, mood and props for every scene.'}</span>
        </div>
      </div>
      {manual && <ManualScript artifactId={artifactId} seconds={seconds} notes={notes} onClose={() => setManual(false)} onDone={() => { setManual(false); onWritten(); }} />}
    </Card>
  );
}

function ManualScript({ artifactId, seconds, notes, onClose, onDone }: { artifactId: string; seconds: number; notes: string; onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const prompt = useAsync(() => api.post<{ prompt: string }>(`/artifacts/${artifactId}/script/prompt`, { seconds, notes }), []);
  const [text, setText] = useState('');
  return (
    <Modal title="Write the script with a prompt" wide onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>1) Copy the prompt into any AI. 2) Paste its JSON answer below. It is checked before it is saved.</p>
        {prompt.error ? <div className="notice bad">{prompt.error.message}</div> : !prompt.data ? <Loading /> : <><div className="row gap"><CopyBtn text={prompt.data.prompt} label="Copy prompt" /></div><pre>{prompt.data.prompt}</pre></>}
        <Field label="Paste the answer here" wide><textarea style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"title":"","characters":[],"sections":[]}' /></Field>
        <div className="row gap">
          <Btn kind="primary" disabled={!text.trim()} onClick={async () => { const r: any = await withReopen((reopen) => api.post(`/artifacts/${artifactId}/script/import`, { text, seconds, reopen })); push('ok', `Script imported: ${r.sections} scenes`); onDone(); }}>Import script</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
