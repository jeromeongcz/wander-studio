import { useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Icon, Loading, Pill, useToast } from '../ui';
import { STEPS, analyze } from '../pipeline';
import { LANG_LABEL, formatName, langName } from '../types';
import { CategoryPicker } from '../stages/shared';
import type { Project } from '../types';

export function Dashboard() {
  const projects = useAsync(async () => {
    const list: { id: string }[] = await api.get('/projects');
    return Promise.all(list.map((p) => api.get<Project>(`/projects/${p.id}`)));
  }, []);
  const jobs = useAsync(() => api.get<any[]>('/jobs'), []);
  useInterval(jobs.reload, 3000);
  const [creating, setCreating] = useState(false);
  const active = (jobs.data ?? []).filter((j) => j.state === 'running' || j.state === 'queued');
  const failed = (jobs.data ?? []).filter((j) => j.state === 'failed').slice(0, 3);
  const rows = (projects.data ?? []).map((p) => ({ p, flow: analyze(p.artifacts) }));
  const needsYou = rows.filter((r) => r.flow.steps.some((s) => s.waiting || s.attention));
  const finished = rows.filter((r) => r.flow.allDone);
  const kpis = [
    { cls: 'k-teal', icon: 'film', n: rows.length, label: 'Videos in progress' },
    { cls: 'k-amber', icon: 'clock', n: rows.filter((r) => r.flow.steps.some((s) => s.waiting)).length, label: 'Waiting for your approval' },
    { cls: 'k-blue', icon: 'alert', n: rows.filter((r) => r.flow.steps.some((s) => s.attention)).length, label: 'Need attention' },
    { cls: 'k-green', icon: 'check', n: finished.length, label: 'Ready to publish' },
  ];
  return (
    <div className="stack">
      <section className="hero">
        <div className="grow">
          <h1>Make your next video</h1>
          <p>Six steps from idea to export. You choose the topic and approve every step; nothing is published for you.</p>
        </div>
        <Btn kind="primary" onClick={() => setCreating(true)}><Icon name="plus" small /> New video</Btn>
      </section>
      <div className="how" aria-label="How it works">
        {STEPS.map((s) => <div key={s.id}><em>{s.n}</em><b>{s.label}</b><span>{s.short}</span></div>)}
      </div>
      {creating && <NewProject onDone={(id) => { location.hash = `#/p/${id}/research`; }} onCancel={() => setCreating(false)} />}
      {rows.length > 0 && <div className="kpis">{kpis.map((k) => <div key={k.label} className={`kpi ${k.cls}`}><span className="kpi-ico"><Icon name={k.icon} /></span><div><b>{k.n}</b><span>{k.label}</span></div></div>)}</div>}
      {(active.length > 0 || failed.length > 0) && (
        <Card title="Background jobs" actions={<a href="#/settings">All jobs</a>}>
          <div className="stack">
            {active.map((j) => (
              <div key={j.id} className="row gap wrap">
                <Pill tone="info">{j.state}</Pill>
                <span>{j.kind.replace(/_/g, ' ')}</span>
                <div className="bar-prog grow"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
                <span className="muted small">{j.message ?? ''}</span>
              </div>
            ))}
            {failed.map((j) => (
              <div key={j.id} className="row gap"><Pill tone="bad">failed</Pill><span>{j.kind.replace(/_/g, ' ')}</span><span className="muted small">{j.error?.message}</span></div>
            ))}
          </div>
        </Card>
      )}
      {projects.loading && !projects.data && <Loading what="Loading projects" />}
      {projects.error && <ErrorBox error={projects.error} retry={projects.reload} />}
      {projects.data && projects.data.length === 0 && !creating && <Empty>No videos yet. Press <strong>New video</strong> to pick a category and start researching topics.</Empty>}
      {needsYou.length > 0 && <><div className="section-h"><h2>Needs you</h2><span className="muted">Approvals and fixes waiting on you</span></div><div className="grid g2">{needsYou.map((r) => <ProjectCard key={r.p.id} {...r} />)}</div></>}
      {rows.length - needsYou.length > 0 && <><div className="section-h"><h2>{needsYou.length ? 'Everything else' : 'Your videos'}</h2></div><div className="grid g2">{rows.filter((r) => !needsYou.includes(r)).map((r) => <ProjectCard key={r.p.id} {...r} />)}</div></>}
    </div>
  );
}

function ProjectCard({ p, flow }: { p: Project; flow: ReturnType<typeof analyze> }) {
  const cur = flow.steps[flow.current];
  const first = cur.step.parts[0].id;
  return (
    <a href={`#/p/${p.id}/${first}`} className="pcard">
      <div className="row gap wrap"><h3 className="grow">{p.name}</h3>{p.category && <Pill tone="info">{p.category}</Pill>}</div>
      <div className="row gap wrap">
        {p.languages.map((l) => <Pill key={l}>{langName(l)}</Pill>)}
        {(p.settings.formats ?? []).map((f) => <Pill key={f}>{formatName(f)}</Pill>)}
      </div>
      <div className="pipe" aria-hidden="true">
        {flow.steps.map((s, i) => <i key={s.step.id} className={s.done ? 'done' : s.attention ? 'attention' : i === flow.current ? 'current' : ''} />)}
      </div>
      <div className="next">
        {flow.allDone ? <><Icon name="check" small /><b>All steps approved</b></> : <><Icon name="arrow" small /><span>Step {cur.step.n} of 6 · <b>{cur.waiting ? `Approve ${cur.step.label.toLowerCase()}` : cur.attention ? `Fix ${cur.step.label.toLowerCase()}` : cur.step.action}</b></span></>}
      </div>
    </a>
  );
}

function NewProject({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { fail } = useToast();
  const locales = useAsync(() => api.get<{ code: string; name: string }[]>('/locales'), []);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [langs, setLangs] = useState<string[]>(['en']);
  const [formats, setFormats] = useState<string[]>(['vertical_9x16']);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const valid = name.trim() && langs.length && formats.length;
  return (
    <Card title="New video" actions={<Btn small kind="ghost" onClick={onCancel}>Cancel</Btn>}>
      <div className="form">
        <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Why octopuses have three hearts" /></Field>
        <CategoryPicker value={category} onChange={setCategory} />
        <Field label="Languages" hint="Each language gets its own script, voice, captions, approvals and renders">
          <div className="row gap wrap">
            {(locales.data ?? []).map((l) => <label key={l.code} className="row gap"><input type="checkbox" checked={langs.includes(l.code)} onChange={() => toggle(langs, l.code, setLangs)} />{LANG_LABEL[l.code] ?? l.name}</label>)}
          </div>
        </Field>
        <Field label="Formats">
          <div className="row gap wrap">
            {['vertical_9x16', 'horizontal_16x9', 'square_1x1'].map((f) => <label key={f} className="row gap"><input type="checkbox" checked={formats.includes(f)} onChange={() => toggle(formats, f, setFormats)} />{formatName(f)}</label>)}
          </div>
        </Field>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Btn kind="primary" disabled={!valid} onClick={async () => {
          try {
            const r = await api.post('/projects', { name: name.trim(), category, languages: langs, formats });
            onDone(r.id);
          } catch (e) { fail(e); }
        }}>Create video</Btn>
      </div>
    </Card>
  );
}
