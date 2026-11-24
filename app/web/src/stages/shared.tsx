import { useEffect, useState } from 'react';
import { api } from '../api';
import { Btn, Field, Pill, fmtSec } from '../ui';
import { SECTION_KINDS } from '../types';

export const sid = () => `s${Math.random().toString(36).slice(2, 7)}`;

export interface Section { id: string; kind: string; text: string; delivery_note?: string; tts_text?: string }

/** Ordered list of script sections with optional pronunciation text. */
export function SectionsEditor({ sections, onChange, withTts, lockKinds }: { sections: Section[]; onChange: (s: Section[]) => void; withTts?: boolean; lockKinds?: boolean }) {
  const set = (i: number, patch: Partial<Section>) => onChange(sections.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="stack">
      {sections.map((s, i) => (
        <div key={s.id} className="scene">
          <div className="row gap">
            <span className="scene-n">{i + 1}</span>
            <select aria-label="Section kind" style={{ width: 120 }} value={s.kind} disabled={lockKinds} onChange={(e) => set(i, { kind: e.target.value })}>
              {SECTION_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <span className="muted small">{s.text.split(/\s+/).filter(Boolean).length} words</span>
            <span className="grow" />
            {!lockKinds && (<>
              <Btn small kind="ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</Btn>
              <Btn small kind="ghost" onClick={() => move(i, 1)} disabled={i === sections.length - 1}>↓</Btn>
              <Btn small kind="ghost" onClick={() => onChange(sections.filter((_, k) => k !== i))}>Remove</Btn>
            </>)}
          </div>
          <textarea aria-label="Narration text" style={{ marginTop: 8 }} value={s.text} placeholder={s.delivery_note ? `Guidance: ${s.delivery_note}` : 'What the narrator says. This exact text is also what the captions show.'} onChange={(e) => set(i, { text: e.target.value })} />
          <div className="form" style={{ marginTop: 8 }}>
            <Field label="Delivery note"><input value={s.delivery_note ?? ''} onChange={(e) => set(i, { delivery_note: e.target.value })} placeholder="e.g. slow, curious" /></Field>
            {withTts && <Field label="Pronunciation text (voice only)" hint="Phonetic respelling for the voice. Never shown in captions."><input value={s.tts_text ?? ''} onChange={(e) => set(i, { tts_text: e.target.value })} /></Field>}
          </div>
        </div>
      ))}
      {!lockKinds && <div><Btn onClick={() => onChange([...sections, { id: sid(), kind: sections.length ? 'main' : 'hook', text: '' }])}>Add section</Btn></div>}
    </div>
  );
}

/** Live duration estimate from calibrated words per minute. */
export function EstimateBar({ sections, lang, preset, target }: { sections: Section[]; lang: string; preset: string; target?: number }) {
  const [est, setEst] = useState<any>(null);
  const key = JSON.stringify([sections.map((s) => s.text), lang, preset, target]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post('/estimate', { lang, sections: sections.map((s) => ({ text: s.text })), preset, target_seconds: target }).then(setEst).catch(() => setEst(null));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!est) return null;
  const tone = est.overHardLimit ? 'bad' : est.fit === 'ok' ? 'good' : est.fit === 'unknown' ? 'neutral' : 'warn';
  return (
    <div className="bar">
      <strong>{est.words} words</strong>
      <Pill tone={tone}>≈ {fmtSec(est.seconds)}{est.fit !== 'unknown' ? ` · ${est.fit === 'ok' ? 'fits the preset' : est.fit === 'over' ? 'over the preset' : 'under the preset'}` : ''}</Pill>
      {est.overHardLimit && <Pill tone="bad">over the 60s Shorts limit</Pill>}
      <span className="muted small">{est.note}</span>
    </div>
  );
}
