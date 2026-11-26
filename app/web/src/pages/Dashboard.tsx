import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Card, Empty, ErrorBox, Icon, Loading, Pill } from '../ui';
import { STEPS, analyze } from '../pipeline';
import { ResearchWorkspace } from './ResearchStudio';
import { Stepper } from '../Stepper';
import { formatName, langName } from '../types';
import type { Project } from '../types';

function useBoard() {
  const projects = useAsync(async () => {
    const list: { id: string }[] = await api.get('/projects');
    return Promise.all(list.map((p) => api.get<Project>(`/projects/${p.id}`)));
  }, []);
  const jobs = useAsync(() => api.get<any[]>('/jobs'), []);
  useInterval(jobs.reload, 3000);
  const rows = (projects.data ?? []).map((p) => ({ p, flow: analyze(p.artifacts) }));
  return { projects, jobs, rows };
}

function JobsCard({ jobs }: { jobs: any[] | null }) {
  const active = (jobs ?? []).filter((j) => j.state === 'running' || j.state === 'queued');
  const failed = (jobs ?? []).filter((j) => j.state === 'failed').slice(0, 3);
  if (!active.length && !failed.length) return null;
  return (
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
  );
}

/** Dashboard: what needs you right now. */
export function Dashboard() {
  const { projects, jobs, rows } = useBoard();
  const research = useAsync(() => api.get<any>('/studio/research'), []);
  const needsYou = rows.filter((r) => r.flow.steps.some((s) => s.waiting || s.attention));
  const inProgress = rows.filter((r) => !needsYou.includes(r) && !r.flow.allDone);
  const finished = rows.filter((r) => r.flow.allDone);
  const approved = (research.data?.ideas ?? []).filter((i: any) => i.status === 'approved');
  const toReview = (research.data?.ideas ?? []).filter((i: any) => i.status === 'new').length;
  const kpis = [
    { cls: 'k-teal', icon: 'film', n: rows.length - finished.length, label: 'Videos in production' },
    { cls: 'k-amber', icon: 'clock', n: rows.filter((r) => r.flow.steps.some((s) => s.waiting)).length, label: 'Waiting for your approval' },
    { cls: 'k-blue', icon: 'alert', n: rows.filter((r) => r.flow.steps.some((s) => s.attention)).length, label: 'Need attention' },
    { cls: 'k-green', icon: 'check', n: finished.length, label: 'Ready to publish' },
  ];
  return (
    <div className="stack">
      <section className="hero">
        <div className="grow">
          <h1>Dashboard</h1>
          <p>What needs you today. You choose the topic and approve every step; nothing is published for you.</p>
        </div>
        <a className="btn btn-primary" href="#/research"><Icon name="spark" small /> Research a topic</a>
      </section>
      <div className="kpis">{kpis.map((k) => <div key={k.label} className={`kpi ${k.cls}`}><span className="kpi-ico"><Icon name={k.icon} /></span><div><b>{k.n}</b><span>{k.label}</span></div></div>)}</div>
      <JobsCard jobs={jobs.data} />
      {projects.loading && !projects.data && <Loading what="Loading" />}
      {projects.error && <ErrorBox error={projects.error} retry={projects.reload} />}
      {(approved.length > 0 || toReview > 0) && (
        <Card title="Research Studio" actions={<a href="#/research">Open</a>}>
          <div className="stack">
            {toReview > 0 && <div className="row gap"><Pill tone="warn">{toReview}</Pill><span>topic{toReview === 1 ? '' : 's'} researched and waiting for your review</span></div>}
            {approved.length > 0 && <div className="row gap"><Pill tone="good">{approved.length}</Pill><span>approved topic{approved.length === 1 ? '' : 's'} ready to become a video: {approved.slice(0, 3).map((i: any) => i.title).join(', ')}</span></div>}
          </div>
        </Card>
      )}
      {needsYou.length > 0 && <><div className="section-h"><h2>Needs you</h2><span className="muted">Approvals and fixes waiting on you</span></div><div className="stack">{needsYou.map((r) => <VideoCard key={r.p.id} {...r} />)}</div></>}
      {inProgress.length > 0 && <><div className="section-h"><h2>In progress</h2></div><div className="stack">{inProgress.map((r) => <VideoCard key={r.p.id} {...r} />)}</div></>}
      {finished.length > 0 && <><div className="section-h"><h2>Ready to publish</h2></div><div className="stack">{finished.map((r) => <VideoCard key={r.p.id} {...r} />)}</div></>}
      {projects.data && rows.length === 0 && <Empty>No videos yet. Go to the <a href="#/research">Research Studio</a> to search and approve a topic.</Empty>}
    </div>
  );
}

/** Video Production: the chosen step's title on top, then the horizontal stepper, then that step's panel. Step 1 is the research workspace. */
export function VideoProduction({ stepId }: { stepId?: string }) {
  const { projects, jobs, rows } = useBoard();
  const idx = Math.max(0, STEPS.findIndex((s) => s.id === stepId));
  const step = STEPS[idx];
  const at = (i: number) => rows.filter((r) => (r.flow.allDone ? i === STEPS.length - 1 : r.flow.current === i));
  const list = at(idx);
  return (
    <div className="stack">
      <Stepper
        current={idx}
        title={idx === 0 ? 'Research Studio' : step.label}
        blurb={idx === 0 ? 'Search a topic, approve it, then start a video from it.' : step.blurb}
        items={STEPS.map((x, i) => {
          const n = at(i).length;
          return { key: x.id, label: x.label, sub: n ? `${n} video${n === 1 ? '' : 's'}` : x.short, href: `#/projects/${x.id}` };
        })}
      />
      <JobsCard jobs={jobs.data} />
      {projects.error && <ErrorBox error={projects.error} retry={projects.reload} />}
      {idx === 0 && <ResearchWorkspace />}
      {projects.loading && !projects.data && <Loading what="Loading videos" />}
      {idx === 0 && list.length > 0 && <h3>Videos at this step</h3>}
      {list.length > 0 && <div className="stack">{list.map((r) => <VideoCard key={r.p.id} {...r} />)}</div>}
      {idx > 0 && projects.data && list.length === 0 && <Empty>No videos at this step. Approve a topic in <a href="#/projects/topic">step 1</a> and start a video from it.</Empty>}
    </div>
  );
}

/** Video card (Dashboard and Video Production), in the same style as a Research Studio topic: state and the next action across the top. */
function VideoCard({ p, flow }: { p: Project; flow: ReturnType<typeof analyze> }) {
  const cur = flow.steps[flow.current];
  const href = `#/p/${p.id}/${cur.step.parts[0].id}`;
  const state = flow.allDone ? { id: 'ready', icon: 'check', label: 'Ready to publish' }
    : cur.attention ? { id: 'attention', icon: 'alert', label: 'Needs a fix' }
    : cur.waiting ? { id: 'waiting', icon: 'clock', label: 'Waiting for your approval' }
    : { id: 'progress', icon: 'film', label: 'In progress' };
  return (
    <section className={`card topic topic-video v-${state.id}`}>
      <header className="topic-top">
        <span className="topic-state">
          <i><Icon name={state.icon} small /></i>
          <span><b>{state.label}</b><span>{flow.allDone ? 'All steps approved' : `Step ${cur.step.n} of 6`}</span></span>
        </span>
        <a className="topic-go" href={href}>Open video <Icon name="arrow" small /></a>
      </header>
      <h3>{p.name}</h3>
      <div className="row gap wrap">
        {p.category && <Pill tone="info">{p.category}</Pill>}
        {p.languages.map((l) => <Pill key={l}>{langName(l)}</Pill>)}
        {(p.settings.formats ?? []).map((f) => <Pill key={f}>{formatName(f)}</Pill>)}
      </div>
      <div className="pipe" aria-hidden="true">
        {flow.steps.map((s, i) => <i key={s.step.id} className={s.done ? 'done' : s.attention ? 'attention' : i === flow.current ? 'current' : ''} />)}
      </div>
      <div className="next">
        {flow.allDone ? <><Icon name="check" small /><b>All steps approved</b></> : <><Icon name="arrow" small /><span>Step {cur.step.n} of 6 · <b>{cur.waiting ? `Approve ${cur.step.label.toLowerCase()}` : cur.attention ? `Fix ${cur.step.label.toLowerCase()}` : cur.step.action}</b></span></>}
      </div>
    </section>
  );
}
