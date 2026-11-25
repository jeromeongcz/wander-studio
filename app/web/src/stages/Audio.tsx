import { useEffect, useRef, useState } from 'react';
import { api, url } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, Empty, Field, FilePick, Icon, Loading, Pill, Tabs, fmtSec, useToast } from '../ui';
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

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** A narration clip: one play button and a waveform you can click to jump. Starting one clip pauses the others. */
function Player({ clipId, seconds, label }: { clipId: string; seconds: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const peaks = useAsync(() => api.get<{ peaks: number[] }>(`/audio/${clipId}/peaks?buckets=110`), [clipId]);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(0); setPlaying(false); }, [clipId]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks.data) return;
    const dpr = devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext('2d')!;
    const css = getComputedStyle(c);
    const played = css.getPropertyValue('--brand').trim() || '#0F766E';
    const rest = css.getPropertyValue('--line-strong').trim() || '#A9CFCA';
    const n = peaks.data.peaks.length;
    const step = c.width / n;
    peaks.data.peaks.forEach((p, i) => {
      const h = Math.max(3 * dpr, p * c.height);
      g.fillStyle = i / n < at / (seconds || 1) ? played : rest;
      g.beginPath();
      g.roundRect(i * step, (c.height - h) / 2, Math.max(1.5, step * 0.6), h, 2 * dpr);
      g.fill();
    });
  }, [peaks.data, at, seconds]);
  const toggle = () => {
    const el = audio.current!;
    if (!el.paused) return el.pause();
    document.querySelectorAll('audio').forEach((o) => o !== el && o.pause());
    void el.play();
  };
  const seek = (ratio: number) => { const el = audio.current!; el.currentTime = Math.max(0, Math.min(1, ratio)) * seconds; setAt(el.currentTime); };
  return (
    <div className="player">
      <button type="button" className="play" onClick={toggle} aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}><Icon name={playing ? 'pause' : 'play'} /></button>
      <canvas ref={canvas} className="player-wave" role="slider" tabIndex={0} aria-label={`Position in ${label}`} aria-valuemin={0} aria-valuemax={Math.round(seconds)} aria-valuenow={Math.round(at)}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); }}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek((at + (e.key === 'ArrowRight' ? 1 : -1)) / (seconds || 1)); } }} />
      <span className="player-time mono">{mmss(at)} / {mmss(seconds)}</span>
      <audio ref={audio} preload="none" src={url(`/audio/${clipId}/file`)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} onEnded={() => { setPlaying(false); setAt(0); }} />
    </div>
  );
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
        <label className="narr-all">
          <input type="checkbox" id="select-all-sections" disabled={!sections.length} checked={allPicked}
            ref={(el) => { if (el) el.indeterminate = somePicked; }}
            onChange={() => setPicked(allPicked ? [] : sections.map((x) => x.id))} />
          <strong>Select all</strong>
          <span className="muted small">{chosen} of {sections.length} selected</span>
          <span className="grow" />
          <span className="muted small">{sections.filter((x) => clipOf(x.id)).length} of {sections.length} recorded</span>
        </label>
        <ol className="narr">
          {sections.map((x, i) => {
            const clip = clipOf(x.id);
            const on = picked.includes(x.id);
            return (
              <li key={x.id} className={`narr-row${on ? ' on' : ''}${clip ? '' : ' empty-row'}`}>
                <input type="checkbox" aria-label={`Select section ${i + 1}`} checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, x.id] : picked.filter((y) => y !== x.id))} />
                <div className="narr-body">
                  <div className="row gap wrap">
                    <span className="narr-n">{i + 1}</span>
                    <Pill tone="info">{x.kind}</Pill>
                    {clip && <span className="muted small">{clip.voice ? clip.voice.replace(/^[a-z]{2,3}-[A-Z]{2}-|Neural$/g, '') : clip.provider} · {fmtSec(clip.duration_seconds)}</span>}
                    <span className="grow" />
                    <Btn small kind={clip ? 'ghost' : 'default'} disabled={!provInfo?.status.ok || !voice} title={clip ? 'Record this section again with the voice chosen above' : 'Record this section'} onClick={() => synth([x.id])}><Icon name={clip ? 'refresh' : 'spark'} small /> {clip ? 'Redo' : 'Generate'}</Btn>
                  </div>
                  <p className="narr-text">{x.text}</p>
                  {clip ? <Player clipId={clip.id} seconds={clip.duration_seconds} label={`section ${i + 1}`} /> : <div className="narr-none">No audio yet</div>}
                </div>
              </li>
            );
          })}
        </ol>
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
