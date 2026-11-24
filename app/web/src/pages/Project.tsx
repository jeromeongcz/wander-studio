import { createContext, useContext, useMemo } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Card, ErrorBox, Loading, Pill, StateBadge } from '../ui';
import { formatName, langName } from '../types';
import type { Artifact, Project, State } from '../types';
import { ResearchStage } from '../stages/Research';
import { ScriptStage } from '../stages/Script';
import { LocalizeStage } from '../stages/Localize';
import { StoryboardStage } from '../stages/Storyboard';
import { VisualsStage } from '../stages/Visuals';
import { AudioStage } from '../stages/Audio';
import { CaptionsStage } from '../stages/Captions';
import { ComposeStage } from '../stages/Compose';
import { PublishStage } from '../stages/Publish';

interface Ctx {
  project: Project;
  reload: () => void;
  find: (kind: string, lang?: string, format?: string) => Artifact | undefined;
  all: (kind: string, lang?: string) => Artifact[];
}
const ProjectCtx = createContext<Ctx>(null as never);
export const useProject = () => useContext(ProjectCtx);

export const STAGES = [
  { id: 'overview', label: 'Overview', kinds: [] as string[] },
  { id: 'research', label: 'Research', kinds: ['research'] },
  { id: 'script', label: 'Script', kinds: ['script_base'] },
  { id: 'localize', label: 'Localization', kinds: ['script_lang'] },
  { id: 'storyboard', label: 'Storyboard', kinds: ['storyboard'] },
  { id: 'visuals', label: 'Visuals', kinds: ['scene_asset'] },
  { id: 'audio', label: 'Voice & audio', kinds: ['audio'] },
  { id: 'captions', label: 'Captions', kinds: ['caption'] },
  { id: 'compose', label: 'Compose & render', kinds: ['composition', 'final_render'] },
  { id: 'publish', label: 'Publish', kinds: ['subtitle_export'] },
];

const aggregate = (arts: Artifact[]): State | 'none' => {
  if (!arts.length) return 'none';
  if (arts.some((a) => a.state === 'needs_revision' || a.state === 'rejected' || a.state === 'failed')) return 'needs_revision';
  if (arts.every((a) => a.state === 'approved')) return 'approved';
  if (arts.some((a) => a.state === 'awaiting_review')) return 'awaiting_review';
  if (arts.every((a) => a.state === 'not_started')) return 'not_started';
  return 'in_progress';
};

export function ProjectPage({ id, stage }: { id: string; stage: string }) {
  const p = useAsync(() => api.get<Project>(`/projects/${id}`), [id]);
  const ctx = useMemo<Ctx | null>(() => {
    if (!p.data) return null;
    const arts = p.data.artifacts;
    return {
      project: p.data,
      reload: p.reload,
      find: (kind, lang, format) => arts.find((a) => a.kind === kind && (!lang || a.lang_code === lang) && (!format || a.format === format)),
      all: (kind, lang) => arts.filter((a) => a.kind === kind && (!lang || a.lang_code === lang)),
    };
  }, [p.data, p.reload]);

  if (p.error) return <ErrorBox error={p.error} retry={p.reload} />;
  if (!ctx) return <Loading what="Loading project" />;
  const current = STAGES.find((s) => s.id === stage) ?? STAGES[0];
  const proj = ctx.project;
  return (
    <ProjectCtx.Provider value={ctx}>
      <div className="stack">
        <div className="row gap wrap">
          <h1>{proj.name}</h1>
          {proj.category && <Pill>{proj.category}</Pill>}
          {proj.languages.map((l) => <Pill key={l} tone="info">{langName(l)}</Pill>)}
          {(proj.settings.formats ?? []).map((f) => <Pill key={f}>{formatName(f)}</Pill>)}
        </div>
        <div className="project">
          <nav className="side" aria-label="Production stages">
            {STAGES.map((s) => {
              const st = aggregate(proj.artifacts.filter((a) => s.kinds.includes(a.kind)));
              return (
                <a key={s.id} href={`#/p/${id}/${s.id}`} className={current.id === s.id ? 'on' : ''} title={st === 'none' ? '' : st.replace('_', ' ')}>
                  <span className={`dot ${st === 'none' ? '' : st}`} />
                  {s.label}
                </a>
              );
            })}
          </nav>
          <div className="stack" style={{ minWidth: 0 }}>
            {current.id === 'overview' && <Overview />}
            {current.id === 'research' && <ResearchStage />}
            {current.id === 'script' && <ScriptStage />}
            {current.id === 'localize' && <LocalizeStage />}
            {current.id === 'storyboard' && <StoryboardStage />}
            {current.id === 'visuals' && <VisualsStage />}
            {current.id === 'audio' && <AudioStage />}
            {current.id === 'captions' && <CaptionsStage />}
            {current.id === 'compose' && <ComposeStage />}
            {current.id === 'publish' && <PublishStage />}
          </div>
        </div>
      </div>
    </ProjectCtx.Provider>
  );
}

function Overview() {
  const { project, reload } = useProject();
  const arts = project.artifacts;
  const counts = (Object.entries(
    arts.reduce<Record<string, number>>((m, a) => ((m[a.state] = (m[a.state] ?? 0) + 1), m), {}),
  ) as [State, number][]);
  const next = STAGES.slice(1).find((s) => aggregate(arts.filter((a) => s.kinds.includes(a.kind))) !== 'approved');
  const attention = arts.filter((a) => a.state === 'awaiting_review' || a.state === 'needs_revision' || a.state === 'failed' || a.state === 'rejected');
  const stageOf = (a: Artifact) => STAGES.find((s) => s.kinds.includes(a.kind))?.id ?? 'overview';
  return (
    <>
      <Card title="Where things stand" actions={<button className="btn btn-sm" onClick={reload}>Refresh</button>}>
        <div className="row gap wrap">{counts.map(([s, n]) => <span key={s} className="row gap"><StateBadge state={s} /> {n}</span>)}</div>
        {next && <p style={{ margin: '12px 0 0' }}>Next up: <a href={`#/p/${project.id}/${next.id}`}><strong>{next.label}</strong></a>. Every stage needs your explicit approval before the next can be approved.</p>}
      </Card>
      {attention.length > 0 && (
        <Card title="Needs your attention">
          <table><tbody>
            {attention.map((a) => <tr key={a.id}><td><a href={`#/p/${project.id}/${stageOf(a)}`}>{a.label}</a></td><td><StateBadge state={a.state} /></td><td className="small muted">{a.state === 'needs_revision' ? 'Something it depends on changed' : a.state === 'awaiting_review' ? 'Review and approve or send back' : ''}</td></tr>)}
          </tbody></table>
        </Card>
      )}
      <Card title="All steps">
        <table>
          <thead><tr><th>Step</th><th>State</th></tr></thead>
          <tbody>
            {STAGES.slice(1).flatMap((s) => arts.filter((a) => s.kinds.includes(a.kind)).map((a) => (
              <tr key={a.id}><td><a href={`#/p/${project.id}/${s.id}`}>{a.label}</a></td><td><StateBadge state={a.state} /></td></tr>
            )))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
