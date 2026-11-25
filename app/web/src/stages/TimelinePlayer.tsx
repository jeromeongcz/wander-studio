import { useEffect, useMemo, useRef, useState } from 'react';
import { url } from '../api';
import { Btn, Icon } from '../ui';

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Group caption words into short lines: at most four words, never across script sections. */
function captionLines(words: any[]) {
  const lines: any[][] = [];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur || cur.length >= 4 || cur[0].section_id !== w.section_id || /[.!?…]$/.test(cur[cur.length - 1].text)) lines.push([w]);
    else cur.push(w);
  }
  return lines;
}

/**
 * Plays the timeline in the browser: the scene pictures, the recorded narration and the captions in step.
 * It is a quick check, not the render: camera moves, transitions, music and exact caption styling appear in the render.
 */
export function TimelinePlayer({ timeline, time, onTime, captions, still, onEnlarge, autoPlay }: { timeline: any; time: number; onTime: (t: number) => void; captions: boolean; still?: React.ReactNode; onEnlarge?: () => void; autoPlay?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(time);
  const clock = useRef(time);
  const voices = useRef(new Map<string, HTMLAudioElement>());
  const duration: number = timeline.duration;
  const lines = useMemo(() => captionLines(timeline.captions.words), [timeline]);

  const silence = () => voices.current.forEach((a) => a.pause());
  useEffect(() => () => silence(), []);
  // the slider or the scene strip moved the time while paused
  useEffect(() => { if (!playing) { clock.current = time; setNow(time); } }, [time, playing]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let told = 0;
    const tick = (stamp: number) => {
      clock.current = Math.min(duration, clock.current + (stamp - last) / 1000);
      last = stamp;
      const t = clock.current;
      for (const c of timeline.audio.chunks) {
        let a = voices.current.get(c.clip_id);
        if (!a) voices.current.set(c.clip_id, (a = new Audio(url(`/audio/${c.clip_id}/file`))));
        const inside = t >= c.start && t < c.start + c.duration - 0.03;
        if (!inside) { if (!a.paused) a.pause(); continue; }
        const want = t - c.start;
        if (a.paused) { a.currentTime = want; void a.play().catch(() => {}); }
        else if (Math.abs(a.currentTime - want) > 0.35) a.currentTime = want;
      }
      setNow(t);
      if (stamp - told > 150) { told = stamp; onTime(Math.round(t * 10) / 10); }
      if (t >= duration) { silence(); setPlaying(false); onTime(duration); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (playing) { silence(); setPlaying(false); onTime(Math.round(clock.current * 10) / 10); return; }
    if (clock.current >= duration - 0.05) clock.current = 0;
    setNow(clock.current);
    setPlaying(true);
  };
  useEffect(() => { if (autoPlay) toggle(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scene = [...timeline.scenes].reverse().find((s: any) => now >= s.start) ?? timeline.scenes[0];
  const line = lines.find((l) => now >= l[0].start && now < l[l.length - 1].end + 0.15);
  const style = timeline.captions.style;
  const f = timeline.format;
  const y = timeline.overrides?.[scene?.scene_id]?.caption_y_pct ?? (f.height > f.width ? 0.78 : f.height === f.width ? 0.86 : 0.9);
  const moved = now > 0 && now < duration;

  return (
    <div className="tlp">
      <div className="tlp-stage" style={{ aspectRatio: `${f.width} / ${f.height}`, maxWidth: `min(100%, calc(70vh * ${f.width / f.height}))` }} onClick={toggle}>
        {!playing && still ? still : (
          <>
            {scene?.asset && (scene.asset.kind === 'video' ? <video key={scene.asset.id} src={url(`/assets/${scene.asset.id}/file`)} muted autoPlay={playing} loop playsInline /> : <img key={scene.asset.id} src={url(`/assets/${scene.asset.id}/file`)} alt={scene.title} />)}
            {captions && line && (
              <p className="tlp-cap" style={{ top: `${y * 100}%`, color: style.color, textTransform: style.uppercase ? 'uppercase' : 'none', WebkitTextStrokeColor: style.stroke_color }}>
                {line.map((w: any, i: number) => <span key={i} style={style.active_word.enabled && now >= w.start && now < w.end ? { color: style.active_word.color } : undefined}>{w.text} </span>)}
              </p>
            )}
          </>
        )}
        {!playing && <span className="tlp-big" aria-hidden="true"><Icon name="play" /></span>}
      </div>
      <div className="tlp-bar">
        <button type="button" className="play" onClick={toggle} aria-label={playing ? 'Pause preview' : 'Play preview'}><Icon name={playing ? 'pause' : 'play'} /></button>
        <input type="range" min={0} max={duration} step={0.1} value={moved || !playing ? now : 0} aria-label="Preview time" onChange={(e) => { const t = Number(e.target.value); clock.current = t; setNow(t); onTime(t); }} />
        <span className="mono muted">{mmss(now)} / {mmss(duration)}</span>
        {onEnlarge && <Btn small onClick={() => { silence(); setPlaying(false); onEnlarge(); }} title="Watch in a larger window"><Icon name="expand" small /> Popup</Btn>}
      </div>
    </div>
  );
}
