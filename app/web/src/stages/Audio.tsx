import { useEffect, useRef, useState } from 'react';
import { api, url } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, Empty, Field, FilePick, Loading, Pill, Tabs, fmtSec, useToast } from '../ui';
import { langName } from '../types';
import { runJob, startTask } from '../progress';

export function AudioStage() {
  const { project } = useProject();
  const [lang, setLang] = useState(project.languages[0]);
  return (
    <>
      <Tabs value={lang} onChange={setLang} items={project.languages.map((l) => ({ id: l, label: langName(l) }))} />
      <LangAudio key={lang} lang={lang} />
    </>
  );
}

function Wave({ clipId }: { clipId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = useAsync(() => api.get<{ peaks: number[] }>(`/audio/${clipId}/peaks?buckets=160`), [clipId]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks.data) return;
    const dpr = devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = getComputedStyle(c).getPropertyValue('--brand') || '#4f46e5';
    const n = peaks.data.peaks.length;
    peaks.data.peaks.forEach((p, i) => {
      const h = Math.max(2 * dpr, p * c.height);
      g.fillRect((i / n) * c.width, (c.height - h) / 2, Math.max(1, c.width / n - 1), h);
    });
  }, [peaks.data]);
  return <canvas ref={ref} className="wave" aria-label="Waveform" />;
}

function LangAudio({ lang }: { lang: string }) {
  const { project, find, reload } = useProject();
  const art = find('audio', lang)!;
  const script = find('script_lang', lang)!;
  const { push } = useToast();
  const doc = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const scriptDoc = useAsync(() => api.get<any>(`/artifacts/${script.id}`), [script.id, script.current_version_id]);
  const clips = useAsync(() => api.get<any[]>(`/projects/${project.id}/audio`), [project.id, art.current_version_id]);
  const tts = useAsync(() => api.get<any[]>('/tts/providers'), []);
  const [prov, setProv] = useState('macos-say');
  const allVoices = useAsync(() => api.get<any[]>(`/tts/providers/${prov}/voices`).catch(() => []), [prov]);
  // Offer voices that match this language when we can tell; otherwise show everything.
  const wanted = lang === 'en' ? /^en/i : lang === 'tl' || lang === 'taglish' ? /^(fil|tl)/i : null;
  const matching = wanted ? (allVoices.data ?? []).filter((v) => wanted.test(v.locale ?? '') || wanted.test(v.id)) : (allVoices.data ?? []);
  const voices = { data: matching.length ? matching : allVoices.data, filtered: !!wanted && matching.length > 0, total: allVoices.data?.length ?? 0 };
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(175);
  const [picked, setPicked] = useState<string[]>([]);
  const [mix, setMix] = useState<any>(null);
  const [musicFile, setMusicFile] = useState<{ path: string; name: string } | null>(null);
  const [musicLic, setMusicLic] = useState<any>({ type: 'own', commercial_use: 'yes' });
  useEffect(() => { if (doc.data?.content) { setMix(doc.data.content.mix ?? {}); if (doc.data.content.voice) { setProv(doc.data.content.voice.provider); setVoice(doc.data.content.voice.voice); if (doc.data.content.voice.rate) setRate(doc.data.content.voice.rate); } } }, [doc.data]);
  useEffect(() => {
    if (!voices.data?.length || voices.data.some((v) => v.id === voice)) return;
    const prefer = lang === 'en' ? ['en-PH-RosaNeural'] : ['fil-PH-BlessicaNeural'];
    setVoice(voices.data.find((v) => prefer.includes(v.id))?.id ?? voices.data.find((v) => lang === 'en' && /^en/i.test(v.locale ?? ''))?.id ?? voices.data[0].id);
  }, [voices.data]); // eslint-disable-line
  // Filipino voices exist only in the online provider: suggest it (still visible and changeable) once we know it is installed.
  useEffect(() => {
    if (lang !== 'en' && !doc.data?.content?.voice && tts.data?.find((p) => p.id === 'edge-tts')?.status.ok) setProv('edge-tts');
  }, [tts.data, doc.data]); // eslint-disable-line
  const done = () => { reload(); doc.reload(); clips.reload(); };
  const sections: any[] = (scriptDoc.data?.content?.sections ?? []).filter((s: any) => s.text.trim());
  const content = doc.data?.content;
  const chosen = sections.filter((s) => picked.includes(s.id)).length;
  const allPicked = sections.length > 0 && chosen === sections.length;
  const somePicked = chosen > 0 && !allPicked;
  const clipOf = (sid: string) => { const ch = content?.chunks?.find((c: any) => c.section_ids.includes(sid)); return ch && clips.data?.find((c) => c.id === ch.clip_id); };
  const provInfo = tts.data?.find((p) => p.id === prov);
  const musicClips = (clips.data ?? []).filter((c) => c.kind === 'music');
  if (doc.loading && !doc.data) return <Loading />;
  if (!scriptDoc.data?.content) return <><ArtifactBar artifact={art} onChanged={done} /><Empty>Write the {langName(lang)} script first (Localization). Narration is generated from it.</Empty></>;

  const synth = async (ids?: string[]) => {
    if (provInfo?.terms.online && !sessionStorage.getItem('wander-online-tts-ok')) {
      if (!confirm(`${provInfo.name} is an online service.\n\nThe text of your script is sent to the provider's servers to make the audio. Continue?`)) return;
      sessionStorage.setItem('wander-online-tts-ok', '1');
    }
    const reopen = art.state === 'approved';
    if (reopen && !confirm('Narration is approved. Regenerate it anyway?\n\nCaptions and renders for this language will need revision.')) return;
    await runJob(project.id, 'synthesize_narration', art.id, { audioId: art.id, voice: { provider: prov, voice, rate }, sectionIds: ids, reopen });
    push('ok', 'Narration generated');
    done();
  };
  const saveMix = async (m: any) => {
    setMix(m);
    const call = (reopen: boolean) => api.put(`/artifacts/${art.id}/mix`, { mix: m, reopen });
    try { await call(false); } catch (e: any) { if (e.code === 'PROTECTED' && confirm('Narration is approved. Change the mix anyway?')) await call(true); else throw e; }
    done();
  };

  return (
    <>
      <ArtifactBar artifact={art} onChanged={done} />
      <Card title="Voice">
        <div className="form">
          <Field label="Provider" hint={provInfo ? provInfo.languages : ''}>
            <select value={prov} onChange={(e) => setProv(e.target.value)}>{(tts.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.status.ok ? '' : ' (not set up)'}</option>)}</select>
          </Field>
          <Field label="Voice" hint={voices.filtered ? `${voices.data?.length} voices for this language` : wanted ? `No ${langName(lang)} voices from this provider: showing all ${voices.total}` : undefined}><select value={voice} onChange={(e) => setVoice(e.target.value)}>{(voices.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.locale ? ` (${v.locale})` : ''}</option>)}</select></Field>
          <Field label={`Speed: ${rate} words/min`}><input type="range" min={110} max={260} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></Field>
        </div>
        {provInfo && (
          <div className={`notice${provInfo.terms.online ? ' warn' : ''}`} style={{ marginTop: 10 }}>
            {provInfo.status.ok ? `${provInfo.status.detail}. ` : <strong>{provInfo.status.detail}. </strong>}{provInfo.terms.online && <strong>Online: the text of your script is sent to the provider. </strong>}Commercial use: {provInfo.terms.commercialUse}
          </div>
        )}
        {lang !== 'en' && <p className="muted small" style={{ marginBottom: 0 }}>Standard macOS voices have no Filipino voice. For Tagalog or Taglish, use Edge TTS (online), Piper with a model you provide, or import your own recording below. Mixed-language lines can mispronounce words: use pronunciation respellings in Localization.</p>}
      </Card>

      <Card title="Narration by section" actions={content && <span className="muted small">measured total ≈ {fmtSec(content.chunks.reduce((n: number, c: any) => n + (clips.data?.find((x) => x.id === c.clip_id)?.duration_seconds ?? 0), 0))}</span>}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input type="checkbox" id="select-all-sections" disabled={!sections.length} checked={allPicked}
                  ref={(el) => { if (el) el.indeterminate = somePicked; }}
                  onChange={() => setPicked(allPicked ? [] : sections.map((s) => s.id))} />
              </th>
              <th colSpan={3} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}><label htmlFor="select-all-sections" style={{ cursor: 'pointer', color: 'var(--text)' }}>Select all</label> <span className="muted">· {chosen} of {sections.length} selected</span></th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => {
              const clip = clipOf(s.id);
              return (
                <tr key={s.id}>
                  <td style={{ width: 28 }}><input type="checkbox" aria-label={`Select ${s.kind}`} checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} /></td>
                  <td style={{ width: 80 }}><Pill>{s.kind}</Pill></td>
                  <td className="small">{s.text}</td>
                  <td style={{ width: 260 }}>{clip ? <div className="stack"><audio controls preload="none" style={{ width: '100%', height: 32 }} src={url(`/audio/${clip.id}/file`)} /><Wave clipId={clip.id} /><span className="muted small">{fmtSec(clip.duration_seconds)} · {clip.provider}{clip.voice ? ` / ${clip.voice}` : ''}</span></div> : <span className="muted small">no audio yet</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small" style={{ marginBottom: 0 }}>The measured length of the audio becomes the authoritative timing for scenes and captions once you approve it.</p>
        <div className="row gap wrap" style={{ marginTop: 14 }}>
          <Btn kind="primary" disabled={!provInfo?.status.ok || !voice} onClick={() => synth()}>Generate narration for the whole script</Btn>
          <Btn disabled={!picked.length || !provInfo?.status.ok} onClick={() => synth(picked)}>Regenerate {picked.length || ''} selected</Btn>
          <FilePick accept="audio/*,.wav,.mp3,.m4a,.aiff,.flac,.ogg" label="Import my own voiceover…" onFile={async (f) => {
            const u = await api.upload(f);
            const call = (reopen: boolean) => api.post(`/artifacts/${art.id}/narration/import`, { path: u.path, name: f.name, section_ids: picked.length ? picked : undefined, reopen });
            const finished = startTask(art.id, 'Importing your voiceover…', f.name);
            try { await call(false); } catch (e: any) { if (e.code === 'PROTECTED' && confirm('Narration is approved. Replace it?')) await call(true); else throw e; } finally { finished(); }
            push('ok', 'Voiceover imported'); done();
          }} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>A voiceover file covers the whole script unless you tick sections above. Imported recordings are your own (license “own”).</p>
      </Card>

      <Card title="Music and mix">
        {!content ? <Empty>Generate or import narration first.</Empty> : (
          <div className="stack">
            <div className="row gap wrap">
              <FilePick accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg" label="Add music file…" onFile={async (f) => { const u = await api.upload(f); setMusicFile({ path: u.path, name: f.name }); }} />
              <span className="muted small">Record where it came from: music must have a license before it can be approved.</span>
            </div>
            {musicFile && (
              <div className="scene stack">
                <strong>{musicFile.name}</strong>
                <div className="form">
                  <Field label="License"><select value={musicLic.type} onChange={(e) => setMusicLic({ ...musicLic, type: e.target.value })}>{['own', 'cc0', 'public-domain', 'cc-by', 'cc-by-sa', 'stock-licensed', 'other', 'unknown'].map((t) => <option key={t}>{t}</option>)}</select></Field>
                  <Field label="Commercial use"><select value={musicLic.commercial_use} onChange={(e) => setMusicLic({ ...musicLic, commercial_use: e.target.value })}><option value="yes">Allowed</option><option value="no">Not allowed</option><option value="unknown">Not sure</option></select></Field>
                  <Field label="Attribution / source" wide><input value={musicLic.attribution_text ?? ''} onChange={(e) => setMusicLic({ ...musicLic, attribution_text: e.target.value })} placeholder='"Track" by Artist, CC BY 4.0' /></Field>
                </div>
                <div className="row gap"><Btn kind="primary" onClick={async () => { const c = await api.post(`/projects/${project.id}/audio/import`, { path: musicFile.path, kind: 'music', name: musicFile.name, license: { ...musicLic, source_url: musicLic.attribution_text } }); setMusicFile(null); await saveMix({ ...(mix ?? {}), music: [...(mix?.music ?? []), { clip_id: c.id, gain_db: -18, fade_in: 0.5, fade_out: 1, loop: true }], ducking: mix?.ducking ?? { enabled: true, amount: 8 } }); push('ok', 'Music added'); }}>Import and add to the mix</Btn><Btn kind="ghost" onClick={() => setMusicFile(null)}>Cancel</Btn></div>
              </div>
            )}
            {(mix?.music ?? []).map((m: any, i: number) => {
              const clip = musicClips.find((c) => c.id === m.clip_id);
              const set = (patch: any) => setMix({ ...mix, music: mix.music.map((x: any, k: number) => (k === i ? { ...x, ...patch } : x)) });
              return (
                <div key={m.clip_id} className="scene stack">
                  <div className="row gap"><strong>{clip?.name ?? 'Music'}</strong>{clip && <Pill tone={clip.license.type === 'unknown' ? 'bad' : 'neutral'}>{clip.license.type}</Pill>}<span className="grow" /><Btn small kind="ghost" onClick={() => saveMix({ ...mix, music: mix.music.filter((_: any, k: number) => k !== i) })}>Remove</Btn></div>
                  <div className="form">
                    <Field label={`Volume ${m.gain_db ?? -14} dB`}><input type="range" min={-40} max={0} value={m.gain_db ?? -14} onChange={(e) => set({ gain_db: Number(e.target.value) })} onMouseUp={() => saveMix(mix)} onKeyUp={() => saveMix(mix)} /></Field>
                    <Field label="Fade in (s)"><input type="number" min={0} max={10} step={0.5} value={m.fade_in ?? 0} onChange={(e) => set({ fade_in: Number(e.target.value) })} onBlur={() => saveMix(mix)} /></Field>
                    <Field label="Fade out (s)"><input type="number" min={0} max={10} step={0.5} value={m.fade_out ?? 0} onChange={(e) => set({ fade_out: Number(e.target.value) })} onBlur={() => saveMix(mix)} /></Field>
                    <Field label="Loop to fill the video"><label className="row gap"><input type="checkbox" checked={!!m.loop} onChange={(e) => saveMix({ ...mix, music: mix.music.map((x: any, k: number) => (k === i ? { ...x, loop: e.target.checked } : x)) })} />Loop</label></Field>
                  </div>
                </div>
              );
            })}
            {(mix?.music?.length ?? 0) > 0 && (
              <label className="row gap"><input type="checkbox" checked={mix.ducking?.enabled !== false} onChange={(e) => saveMix({ ...mix, ducking: { ...(mix.ducking ?? {}), enabled: e.target.checked } })} />Lower the music automatically while someone is speaking (ducking)</label>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
