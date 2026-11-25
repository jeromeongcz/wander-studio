import { useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Pill, useToast } from '../ui';
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

  return (
    <div className="stack">
      <div className="row gap wrap">
        <h1>Projects</h1>
        <span className="grow" />
        <Btn kind="primary" onClick={() => setCreating(true)}>New project</Btn>
      </div>
      {creating && <NewProject onDone={(id) => { location.hash = `#/p/${id}/overview`; }} onCancel={() => setCreating(false)} />}
      {(active.length > 0 || failed.length > 0) && (
        <Card title="Background jobs" actions={<a href="#/settings">All jobs</a>}>
          <div className="stack">
            {active.map((j) => (
              <div key={j.id} className="row gap">
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
      {projects.data && projects.data.length === 0 && !creating && <Empty>No projects yet. Create one to start: topic research, script, storyboard, visuals, voice, captions, and renders, with you approving each step.</Empty>}
      <div className="grid g2">
        {(projects.data ?? []).map((p) => {
          const total = p.artifacts.length;
          const done = p.artifacts.filter((a) => a.state === 'approved').length;
          const attention = p.artifacts.filter((a) => a.state === 'awaiting_review').length;
          const stale = p.artifacts.filter((a) => a.state === 'needs_revision' || a.state === 'failed' || a.state === 'rejected').length;
          return (
            <a key={p.id} href={`#/p/${p.id}/overview`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <Card className="proj">
                <div className="row gap"><h3>{p.name}</h3><span className="grow" />{p.category && <Pill>{p.category}</Pill>}</div>
                <div className="row gap wrap" style={{ margin: '8px 0' }}>
                  {p.languages.map((l) => <Pill key={l} tone="info">{langName(l)}</Pill>)}
                  {(p.settings.formats ?? []).map((f) => <Pill key={f}>{formatName(f)}</Pill>)}
                </div>
                <div className="row gap"><div className="bar-prog grow"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div><span className="small muted">{done}/{total} approved</span></div>
                <div className="row gap small" style={{ marginTop: 8 }}>
                  {attention > 0 && <Pill tone="warn">{attention} awaiting your review</Pill>}
                  {stale > 0 && <Pill tone="bad">{stale} need attention</Pill>}
                </div>
              </Card>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function NewProject({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { fail } = useToast();
  const locales = useAsync(() => api.get<{ code: string; name: string }[]>('/locales'), []);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Interesting Facts');
  const [langs, setLangs] = useState<string[]>(['en']);
  const [formats, setFormats] = useState<string[]>(['vertical_9x16']);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const valid = name.trim() && langs.length && formats.length;
  return (
    <Card title="New project" actions={<Btn small kind="ghost" onClick={onCancel}>Cancel</Btn>}>
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
        }}>Create project</Btn>
      </div>
    </Card>
  );
}
