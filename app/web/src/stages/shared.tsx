import { useEffect, useState } from 'react';
import { api } from '../api';
import { Btn, Field, Pill, fmtSec, useToast } from '../ui';
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


/** Change a project's category (and optionally name). Drives the storyboard's visual recommendations; approvals are unaffected. */
export function ProjectDetailsEditor({ project, onSaved, compact }: { project: { id: string; name: string; category: string | null }; onSaved: () => void; compact?: boolean }) {
  const { push } = useToast();
  const [cats, setCats] = useState<{ name: string; profile: { assets: string[] } }[]>([]);
  const [name, setName] = useState(project.name);
  const [category, setCategory] = useState(project.category ?? '');
  useEffect(() => { api.get('/categories').then(setCats).catch(() => {}); }, []);
  useEffect(() => { setName(project.name); setCategory(project.category ?? ''); }, [project.name, project.category]);
  const dirty = name.trim() !== project.name || category.trim() !== (project.category ?? '');
  const known = cats.some((c) => c.name.toLowerCase() === category.trim().toLowerCase());
  return (
    <div className="stack">
      <div className="form">
        {!compact && <Field label="Project name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>}
        <CategoryPicker value={category} onChange={setCategory} />
      </div>
      <div className="row gap">
        <Btn kind="primary" disabled={!dirty || !name.trim()} onClick={async () => { await api.patch(`/projects/${project.id}`, { name: name.trim(), category: category.trim() }); push('ok', 'Project updated'); onSaved(); }}>Save</Btn>
        {dirty && <Btn kind="ghost" onClick={() => { setName(project.name); setCategory(project.category ?? ''); }}>Reset</Btn>}
        <span className="muted small">Changing the category does not change anything already approved.</span>
      </div>
    </div>
  );
}


interface CategoryInfo { name: string }

/** Category chooser: the six project topics, plus "Other" to type your own (custom categories get general recommendations). */
export function CategoryPicker({ value, onChange, label = 'Category' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [cats, setCats] = useState<CategoryInfo[]>([]);
  const [custom, setCustom] = useState(false);
  useEffect(() => { api.get<CategoryInfo[]>('/categories').then(setCats).catch(() => {}); }, []);
  const match = cats.find((c) => c.name.toLowerCase() === value.trim().toLowerCase());
  const isCustom = custom || (!!value.trim() && cats.length > 0 && !match);
  const hint = !value.trim() ? 'No category: general recommendations' : isCustom ? 'Custom category: general recommendations' : 'Uses this category’s visual recommendations';
  return (
    <Field label={label} hint={hint} wide>
      <select aria-label={label} value={isCustom ? '__other' : match?.name ?? ''} onChange={(e) => {
        if (e.target.value === '__other') { setCustom(true); onChange(match ? '' : value); } else { setCustom(false); onChange(e.target.value); }
      }}>
        <option value="">None (general)</option>
        {cats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        <option value="__other">Other: type your own…</option>
      </select>
      {isCustom && <input aria-label="Custom category" style={{ marginTop: 6 }} autoFocus value={value} onChange={(e) => onChange(e.target.value)} maxLength={60} placeholder="e.g. Cooking for beginners" />}
    </Field>
  );
}
