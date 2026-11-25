import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Loading, Modal, Pill, Tabs, fmtSec, useToast } from '../ui';
import { langName } from '../types';
import { runJob } from '../progress';

export function CaptionsStage() {
  const { project } = useProject();
  const [lang, setLang] = useState(project.languages[0]);
  return (
    <>
      <Tabs value={lang} onChange={setLang} items={project.languages.map((l) => ({ id: l, label: langName(l) }))} />
      <LangCaptions key={lang} lang={lang} />
    </>
  );
}

const conf = (c: string) => (c === 'high' ? 'good' : c === 'medium' ? 'warn' : 'bad');

function LangCaptions({ lang }: { lang: string }) {
  const { project, find, reload } = useProject();
  const art = find('caption', lang)!;
  const audio = find('audio', lang)!;
  const exportArt = find('subtitle_export', lang);
  const { push } = useToast();
  const doc = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const whisper = useAsync(() => api.get<any>('/alignment/whisper'), []);
  const styles = useAsync(() => api.get<any[]>('/templates?kind=caption_style'), []);
  const fonts = useAsync(() => api.get<any[]>('/fonts'), []);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [exp, setExp] = useState<any>(null);
  useEffect(() => { if (doc.data) { setC(doc.data.content); setDirty(false); } }, [doc.data]);
  const done = () => { reload(); doc.reload(); };
  if (doc.loading && !doc.data) return <Loading />;

  const align = (method: 'heuristic' | 'asr') => async () => {
    const reopen = art.state === 'approved';
    if (reopen && !confirm('Captions are approved. Align again?\n\nThis replaces word timings and marks renders as needing revision.')) return;
    await runJob(project.id, 'align_captions', art.id, { captionId: art.id, method, reopen });
    push('ok', 'Captions aligned to the narration');
    done();
  };
  const header = (
    <Card title="Timing">
      <p className="muted small" style={{ marginTop: 0 }}>Caption text always comes from your approved script. The audio only supplies the timing, so Tagalog and Taglish spelling is never replaced by a speech recogniser's guess.</p>
      {audio.state !== 'approved' && <div className="notice warn" style={{ marginBottom: 10 }}>The narration is {audio.state.replace('_', ' ')}. Align captions to the final audio, then approve both.</div>}
      <div className="row gap wrap">
        <Btn kind="primary" disabled={!audio.current_version_id} onClick={align('heuristic')}>{c ? 'Re-align' : 'Align'} to narration</Btn>
        <Btn disabled={!whisper.data?.ready || !audio.current_version_id} title={whisper.data?.ready ? '' : 'Needs a whisper model file; see Jobs & settings'} onClick={align('asr')}>Align with Whisper</Btn>
        {c && <><Pill tone={conf(c.confidence)}>{c.confidence} confidence</Pill><Pill>{c.method}</Pill></>}
      </div>
      {c?.note && <p className="muted small" style={{ marginBottom: 0 }}>{c.note}</p>}
    </Card>
  );
  if (!c) return <><ArtifactBar artifact={art} onChanged={done} />{header}<Empty>Generate narration for this language, then align.</Empty></>;

  const edit = (patch: any) => { setC({ ...c, ...patch }); setDirty(true); };
  const setWord = (i: number, patch: any) => edit({ words: c.words.map((w: any, k: number) => (k === i ? { ...w, ...patch } : w)) });
  const setStyle = (patch: any) => edit({ style: { ...c.style, ...patch } });
  const s = c.style;
  const bad = (i: number) => c.words[i].end < c.words[i].start || (i > 0 && c.words[i].start < c.words[i - 1].end - 0.001);
  return (
    <>
      <ArtifactBar artifact={art} onChanged={done}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      {header}
      <Card title="Style" actions={
        <select aria-label="Apply a saved style" style={{ width: 190 }} value="" onChange={async (e) => {
          const t = styles.data?.find((x) => x.id === e.target.value);
          if (t) { setC({ ...c, style: t.content }); setDirty(true); }
        }}><option value="">Start from a style…</option>{(styles.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      }>
        <div className="form">
          <Field label="Font" hint="Must be installed or in templates/fonts"><input list="fonts" value={s.font_family} onChange={(e) => setStyle({ font_family: e.target.value })} /><datalist id="fonts">{(fonts.data ?? []).slice(0, 200).map((f) => <option key={f.path} value={f.family} />)}</datalist></Field>
          <Field label={`Size ×${s.font_scale}`}><input type="range" min={0.6} max={1.6} step={0.05} value={s.font_scale} onChange={(e) => setStyle({ font_scale: Number(e.target.value) })} /></Field>
          <Field label="Text colour"><input type="color" value={s.color} onChange={(e) => setStyle({ color: e.target.value })} /></Field>
          <Field label="Outline colour"><input type="color" value={s.stroke_color} onChange={(e) => setStyle({ stroke_color: e.target.value })} /></Field>
          <Field label={`Outline thickness ${Math.round(s.stroke_width * 100)}%`}><input type="range" min={0} max={0.2} step={0.01} value={s.stroke_width} onChange={(e) => setStyle({ stroke_width: Number(e.target.value) })} /></Field>
          <Field label="Entrance"><select value={s.animation} onChange={(e) => setStyle({ animation: e.target.value })}><option value="none">None</option><option value="fade">Fade in</option><option value="pop">Pop</option></select></Field>
          <Field label="Options"><div className="row gap wrap">
            <label className="row gap"><input type="checkbox" checked={s.bold} onChange={(e) => setStyle({ bold: e.target.checked })} />Bold</label>
            <label className="row gap"><input type="checkbox" checked={s.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} />UPPERCASE</label>
            <label className="row gap"><input type="checkbox" checked={s.pill.enabled} onChange={(e) => setStyle({ pill: { ...s.pill, enabled: e.target.checked } })} />Background box</label>
          </div></Field>
          <Field label="Highlight the spoken word"><div className="row gap">
            <input type="checkbox" checked={s.active_word.enabled} onChange={(e) => setStyle({ active_word: { ...s.active_word, enabled: e.target.checked } })} aria-label="Highlight spoken word" />
            <input type="color" value={s.active_word.color} onChange={(e) => setStyle({ active_word: { ...s.active_word, color: e.target.value } })} aria-label="Highlight colour" style={{ width: 52 }} />
          </div></Field>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>See the result on a real frame in Compose &amp; render. Caption size and position adapt per format and stay inside each platform's safe zone.</p>
      </Card>
      <Card title={`Words (${c.words.length})`} actions={<span className="muted small">narration {fmtSec(c.duration)}</span>}>
        <p className="muted small" style={{ marginTop: 0 }}>Nudge start and end times if a word lands early or late. Changing a word's text is blocked unless you tick “edit”: that is a deliberate override of the approved script.</p>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="words">
            <thead><tr><th>#</th><th>Word</th><th>Start</th><th>End</th><th>Edit text</th></tr></thead>
            <tbody>
              {c.words.map((w: any, i: number) => (
                <tr key={i} style={bad(i) ? { background: 'var(--bad-bg)' } : undefined}>
                  <td>{i + 1}</td>
                  <td><input aria-label={`Word ${i + 1}`} disabled={!w.override} value={w.text} onChange={(e) => setWord(i, { text: e.target.value })} /></td>
                  <td><input type="number" step={0.01} min={0} aria-label="Start" value={w.start} onChange={(e) => setWord(i, { start: Number(e.target.value) })} /></td>
                  <td><input type="number" step={0.01} min={0} aria-label="End" value={w.end} onChange={(e) => setWord(i, { end: Number(e.target.value) })} /></td>
                  <td><input type="checkbox" checked={!!w.override} onChange={(e) => setWord(i, { override: e.target.checked || undefined })} aria-label="Allow text edit" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="row gap wrap">
        <Btn kind="primary" disabled={!dirty} onClick={async () => { const r = await saveArtifact(art.id, c); push('ok', r.changed ? 'Captions saved' : 'No changes'); done(); }}>Save captions</Btn>
        <Btn onClick={async () => { const r = await api.post(`/artifacts/${art.id}/captions/export`); setExp(r); push('ok', 'Subtitle files written to the project folder'); reload(); }}>Export .srt / .vtt</Btn>
        {exportArt && <span className="muted small">Subtitle export: {exportArt.state.replace('_', ' ')}</span>}
      </div>
      {exportArt && exportArt.current_version_id && <ArtifactBar artifact={exportArt} onChanged={done} />}
      {exp && (
        <Modal title="Subtitle files" wide onClose={() => setExp(null)}>
          <div className="grid g2"><div><div className="row gap"><h4>SRT</h4><CopyBtn text={exp.srt} /></div><pre>{exp.srt}</pre></div><div><div className="row gap"><h4>VTT</h4><CopyBtn text={exp.vtt} /></div><pre>{exp.vtt}</pre></div></div>
          <p className="muted small">Saved as {exp.files.join(', ')} in this project's folder.</p>
        </Modal>
      )}
    </>
  );
}
