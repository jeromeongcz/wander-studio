import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { ProgressFooter, useTask } from '../progress';
import { Btn, Card, CardIcon, ErrorBox, Icon, Loading, Modal, Pill, StateBadge, useToast } from '../ui';
import type { Artifact, Project, State } from '../types';
import { STEPS, aggregate, analyze, stepOfPart } from '../pipeline';
import { langName } from '../types';
import type { StepInfo } from '../pipeline';
import { Stepper } from '../Stepper';
import { ProjectDetailsEditor } from '../stages/shared';
import { DeleteProject } from '../stages/DeleteProject';
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

const PARTS = STEPS.flatMap((s) => s.parts.map((p) => ({ ...p, step: s })));

/** The same stepper as Video Production, showing how far this video is. */
const stepItems = (infos: StepInfo[], projectId: string) =>
  infos.map((i, idx) => {
    const first = i.step.parts.find((p) => !i.artifacts.length || aggregate(i.artifacts.filter((a) => p.kinds.includes(a.kind))) !== 'approved') ?? i.step.parts[0];
    return {
      key: i.step.id,
      label: i.step.label,
      sub: i.locked ? 'Locked' : i.done ? 'Approved' : i.attention ? 'Needs attention' : i.waiting ? 'Waiting for you' : i.step.short,
      href: `#/p/${projectId}/${first.id}`,
      done: i.done,
      locked: i.locked,
      attention: i.attention,
      waiting: i.waiting,
      title: i.locked ? `Approve ${infos[idx - 1].step.label} first` : undefined,
    };
  });

/** Shows the running work for this video in the floating footer: the script being written, or a background job. Otherwise the step's own footer. */
const JOB_LABEL: Record<string, string> = { sketch_scenes: 'Drawing storyboard pictures', synthesize_narration: 'Generating narration', align_captions: 'Aligning captions', render_composition: 'Rendering the video', batch_render: 'Rendering videos' };

function LiveFooter({ projectId, artifactIds, reload, children }: { projectId: string; artifactIds: string[]; reload: () => void; children: React.ReactNode }) {
  const task = useTask(...artifactIds);
  const jobs = useAsync(() => api.get<any[]>(`/jobs?project_id=${projectId}`), [projectId]);
  useInterval(jobs.reload, 1000);
  const active = (jobs.data ?? []).filter((j) => j.state === 'running' || j.state === 'queued');
  const job = active.find((j) => j.state === 'running') ?? active[0];
  // a finished job changes the project, so refresh it once
  const wasActive = useRef(0);
  useEffect(() => { if (wasActive.current > active.length) reload(); wasActive.current = active.length; }, [active.length, reload]);
  if (task) return <ProgressFooter label={task.label} detail={task.detail} startedAt={task.startedAt} />;
  if (job) return <ProgressFooter label={`${JOB_LABEL[job.kind] ?? job.kind.replace(/_/g, ' ')}${job.state === 'queued' ? ' (waiting)' : ''}${active.length > 1 ? ` · ${active.length - 1} more` : ''}`} detail={job.message ?? undefined} progress={job.progress} onCancel={async () => { await api.post(`/jobs/${job.id}/cancel`); jobs.reload(); }} />;
  return <>{children}</>;
}

/** The footer of every step: what is done, what unlocks the next step, and (for the topic) the explicit approval. */
/** The part of a step that comes next once the one on screen is approved (for example Languages after the base script). */
function nextPartOf(info: StepInfo, partId: string) {
  const approved = (p: StepInfo['step']['parts'][number]) => aggregate(info.artifacts.filter((a) => p.kinds.includes(a.kind))) === 'approved';
  const here = info.step.parts.find((p) => p.id === partId);
  if (!here || !approved(here)) return undefined;
  const part = info.step.parts.find((p) => !approved(p));
  return part && { part, from: here };
}
const PART_HINT: Record<string, (languages: string) => string> = {
  script: () => 'write and approve the base script',
  localize: (l) => `create and approve the ${l} version`,
  storyboard: () => 'approve the storyboard',
  visuals: () => 'give every scene an approved visual',
  audio: (l) => `approve the ${l} narration`,
  captions: (l) => `check and approve the ${l} captions`,
};

function StepFooter({ info, next, partId, projectId, reload }: { info: StepInfo; next?: StepInfo; partId: string; projectId: string; reload: () => void }) {
  const { find, project } = useProject();
  const { push } = useToast();
  const [confirm, setConfirm] = useState(false);
  const research = find('research');
  const isTopic = info.step.id === 'topic' && research;
  const go = () => { location.hash = `#/p/${projectId}/${next!.step.parts[0].id}`; };
  if (info.done) {
    return (
      <div className="stepfoot ready">
        <Icon name="check" /><strong>{info.step.label} approved.</strong>
        <span className="grow" />
        <Btn onClick={() => { const i = STEPS.findIndex((x) => x.id === info.step.id); location.hash = i > 0 ? `#/p/${projectId}/${STEPS[i - 1].parts[0].id}` : '#/projects'; }}>← Back</Btn>
        {next && <Btn kind="primary" onClick={go}>Continue to {next.step.label} <Icon name="arrow" small /></Btn>}
        {!next && <span className="muted">Every step is approved. Export your package above.</span>}
      </div>
    );
  }
  if (isTopic) {
    const r = research!;
    return (
      <>
        <div className="stepfoot">
          <Icon name="lock" />
          <span className="grow">{r.state === 'awaiting_review' ? <><strong>Your topic is ready for your decision.</strong> Nothing moves on until you approve it.</> : r.current_version_id ? <>Submit the topic for review to run the checks, then approve it to unlock <strong>Script</strong>.</> : <>Fill in the research notes (or start from a topic approved in the <a href="#/research">Research Studio</a>). Then you approve it to unlock <strong>Script</strong>.</>}</span>
          {r.state === 'awaiting_review' ? (
            <Btn kind="primary" onClick={() => setConfirm(true)}>Approve topic &amp; continue <Icon name="arrow" small /></Btn>
          ) : (
            <Btn kind="primary" disabled={!r.current_version_id} onClick={async () => {
              const res = await api.post(`/artifacts/${r.id}/submit`);
              push(res.warnings?.length ? 'warn' : 'ok', res.warnings?.length ? 'Submitted, with warnings' : 'Submitted: review and approve it', res.warnings);
              reload();
            }}>Submit topic for review</Btn>
          )}
        </div>
        {confirm && <TopicApproval artifactId={r.id} onClose={() => setConfirm(false)} onApproved={() => { setConfirm(false); reload(); location.hash = `#/p/${projectId}/script`; }} />}
      </>
    );
  }
  const onward = nextPartOf(info, partId);
  if (onward) {
    const langs = project.languages.map(langName).join(' and ');
    return (
      <div className="stepfoot ready">
        <Icon name="check" />
        <span className="grow"><strong>{onward.from.label} approved. Next: {onward.part.label}.</strong> {PART_HINT[onward.part.id] ? `To finish ${info.step.label}, ${PART_HINT[onward.part.id](langs)}.` : ''}</span>
        <Btn kind="primary" onClick={() => { location.hash = `#/p/${projectId}/${onward.part.id}`; window.scrollTo({ top: 0 }); }}>Continue to {onward.part.label} <Icon name="arrow" small /></Btn>
      </div>
    );
  }
  return (
    <div className="stepfoot">
      <Icon name="lock" />
      <span className="grow">{partId === 'localize' ? (
        info.artifacts.some((x) => x.kind === 'script_lang' && !x.current_version_id)
          ? <>Press <strong>Create draft from base script</strong> above, then submit and approve it to unlock <strong>{next?.step.label}</strong>.</>
          : <>Submit and approve the <strong>{project.languages.map(langName).join(' and ')}</strong> script to unlock <strong>{next?.step.label}</strong>.</>
      ) : <>{info.attention ? <>Something here needs revision. </> : null}Approve everything in <strong>{info.step.label}</strong>{next ? <> to unlock <strong>{next.step.label}</strong></> : null}. Only you can approve.</>}</span>
    </div>
  );
}

function TopicApproval({ artifactId, onClose, onApproved }: { artifactId: string; onClose: () => void; onApproved: () => void }) {
  const art = useAsync(() => api.get<any>(`/artifacts/${artifactId}`), [artifactId]);
  const { push } = useToast();
  const c = art.data?.content;
  return (
    <Modal title="Approve this topic?" onClose={onClose}>
      {!c ? <Loading /> : (
        <div className="stack">
          <div>
            <h2>{c.topic}</h2>
            {c.angle && <p className="muted" style={{ margin: '6px 0 0' }}>{c.angle}</p>}
          </div>
          <div className="row gap wrap">
            <Pill tone="info">{c.claims?.length ?? 0} facts</Pill>
            <Pill>{c.sources?.length ?? 0} sources</Pill>
            <Pill tone={(c.claims ?? []).some((x: any) => x.status === 'verified') ? 'good' : 'warn'}>{(c.claims ?? []).filter((x: any) => x.status === 'verified').length} marked verified</Pill>
          </div>
          <div className="notice">Approving unlocks the Script step. You can still change the topic later; the script and everything after it will then be marked for revision.</div>
          <div className="row gap">
            <span className="grow" />
            <Btn onClick={onClose}>Not yet</Btn>
            <Btn kind="primary" onClick={async () => { await api.post(`/artifacts/${artifactId}/approve`); push('ok', 'Topic approved. On to the script.'); onApproved(); }}>Approve topic</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

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
  const proj = ctx.project;
  const flow = analyze(proj.artifacts);
  const details = stage === 'overview';
  const part = PARTS.find((x) => x.id === stage) ?? PARTS.find((x) => x.id === flow.steps[flow.current].step.parts[0].id)!;
  const viewing = details ? -1 : stepOfPart(part.id);
  const info = flow.steps[viewing];
  const next = flow.steps[viewing + 1];
  // the step panels take the colour and icon of the part on screen, the same states as the video cards
  const partState = info && aggregate(info.artifacts.filter((a) => part.kinds.includes(a.kind)));
  const look = partState === 'approved' ? { id: 'ready', icon: 'check' }
    : partState === 'awaiting_review' ? { id: 'waiting', icon: 'clock' }
    : partState === 'needs_revision' || partState === 'failed' || partState === 'rejected' ? { id: 'attention', icon: 'alert' }
    : { id: 'progress', icon: 'film' };
  return (
    <ProjectCtx.Provider value={ctx}>
      <div className="stack">
        <header className="video-head">
          <div className="row gap video-head-top">
            <a className="btn btn-ghost btn-sm" href="#/projects">← Video Production</a>
            <span className="grow" />
            <a className={`btn btn-sm${details ? ' btn-primary' : ''}`} href={`#/p/${id}/overview`}>Details &amp; settings</a>
          </div>
          <p className="muted">{details ? 'Project details, every step and deletion.' : info.step.blurb}</p>
          <h1><span className="crumb">{details ? 'Details' : info.step.label}</span> <span aria-hidden="true">&gt;</span> {proj.name}</h1>
          <div className="row gap wrap">
            {proj.category && <Pill tone="info">{proj.category}</Pill>}
          </div>
        </header>
        <Stepper items={stepItems(flow.steps, id)} current={viewing} />
        {details ? <Overview /> : (
          <>
            {info.step.parts.length > 1 && !info.locked && (
              <div className="tabs" role="tablist">
                {info.step.parts.map((x) => {
                  const st = aggregate(info.artifacts.filter((a) => x.kinds.includes(a.kind)));
                  return <button key={x.id} role="tab" aria-selected={x.id === part.id} className={x.id === part.id ? 'on' : ''} onClick={() => { location.hash = `#/p/${id}/${x.id}`; }}>{x.label}{st === 'approved' && <> <Icon name="check" small /></>}{nextPartOf(info, part.id)?.part.id === x.id && <span className="tab-next">Next</span>}</button>;
                })}
              </div>
            )}
            {info.locked ? (
              <div className="callout lock">
                <span className="icon-wrap"><Icon name="lock" /></span>
                <div className="grow">
                  <h3>{info.step.label} is locked</h3>
                  <p className="muted" style={{ margin: '4px 0 12px' }}>Approve <strong>{flow.steps[viewing - 1].step.label}</strong> first. Every step needs your approval before the next one opens.</p>
                  <a className="btn btn-primary" href={`#/p/${id}/${flow.steps[flow.current].step.parts[0].id}`}>Go to {flow.steps[flow.current].step.label}</a>
                </div>
              </div>
            ) : (
              <>
                <CardIcon.Provider value={look.icon}>
                <div className={`stack step-content v-${look.id}`}>
                {part.id === 'research' && <ResearchStage />}
                {part.id === 'script' && <ScriptStage />}
                {part.id === 'localize' && <LocalizeStage />}
                {part.id === 'storyboard' && <StoryboardStage />}
                {part.id === 'visuals' && <VisualsStage />}
                {part.id === 'audio' && <AudioStage />}
                {part.id === 'captions' && <CaptionsStage />}
                {part.id === 'compose' && <ComposeStage />}
                {part.id === 'publish' && <PublishStage />}
                </div>
                </CardIcon.Provider>
                <LiveFooter projectId={id} artifactIds={proj.artifacts.map((a) => a.id)} reload={p.reload}>
                  <StepFooter info={info} next={next} partId={part.id} projectId={id} reload={p.reload} />
                </LiveFooter>
              </>
            )}
          </>
        )}
      </div>
    </ProjectCtx.Provider>
  );
}

function Overview() {
  const { project, reload } = useProject();
  const arts = project.artifacts;
  const attention = arts.filter((a) => a.state === 'awaiting_review' || a.state === 'needs_revision' || a.state === 'failed' || a.state === 'rejected');
  const stageOf = (a: Artifact) => PARTS.find((s) => s.kinds.includes(a.kind))?.id ?? 'overview';
  return (
    <>
      <Card title="Project details"><ProjectDetailsEditor project={project} onSaved={reload} /></Card>
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
            {PARTS.flatMap((s) => arts.filter((a) => s.kinds.includes(a.kind)).map((a) => (
              <tr key={a.id}><td><a href={`#/p/${project.id}/${s.id}`}>{a.label}</a></td><td><StateBadge state={a.state} /></td></tr>
            )))}
          </tbody>
        </table>
      </Card>
      <Card title="Danger zone"><DeleteProject project={project} /></Card>
    </>
  );
}
