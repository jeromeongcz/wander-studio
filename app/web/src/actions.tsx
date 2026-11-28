import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from './api';
import { Btn, Icon, Modal, StateBadge, useToast } from './ui';
import type { Artifact, State } from './types';

/**
 * Save artifact content. Approved work is protected by the server; when it refuses, ask once and retry with
 * reopen so the person knowingly accepts that downstream work will be marked for revision.
 */
export async function saveArtifact(id: string, content: unknown): Promise<{ changed: boolean; invalidated: string[] }> {
  try {
    return await api.put(`/artifacts/${id}/content`, { content });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'PROTECTED') {
      if (!confirm('This is approved. Edit it anyway?\n\nThe approved version stays in history, but anything that depends on it will be marked "needs revision".')) throw new ApiError(0, 'CANCELLED', 'Edit cancelled');
      return api.put(`/artifacts/${id}/content`, { content, reopen: true });
    }
    throw e;
  }
}

export async function withReopen<T>(fn: (reopen: boolean) => Promise<T>): Promise<T> {
  try {
    return await fn(false);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'PROTECTED') {
      if (!confirm('This is approved. Change it anyway?\n\nDependent work will be marked "needs revision"; the approved version stays in history.')) throw new ApiError(0, 'CANCELLED', 'Cancelled');
      return fn(true);
    }
    throw e;
  }
}

/** What each state means to the person: icon, headline, what to do, and how far along the Draft → Review → Approved track it is. */
const LOOK: Record<State | 'empty', { icon: string; title: string; hint: string; reached: number }> = {
  empty: { icon: 'spark', title: 'Nothing to review yet.', hint: 'Create the content below to get started.', reached: 0 },
  not_started: { icon: 'spark', title: 'Ready when you are.', hint: 'Save your work, then submit it.', reached: 0 },
  in_progress: { icon: 'spark', title: 'Draft in progress.', hint: 'Read it through, then submit it for review.', reached: 0 },
  awaiting_review: { icon: 'clock', title: 'Your decision is needed.', hint: 'Check it carefully. Nothing moves on until you approve.', reached: 1 },
  approved: { icon: 'check', title: 'Approved by you.', hint: 'Editing it asks first and keeps this version in history.', reached: 3 },
  needs_revision: { icon: 'alert', title: 'Needs another pass.', hint: 'Update it, then submit it again.', reached: 0 },
  rejected: { icon: 'alert', title: 'Rejected.', hint: 'Rework it, then submit it again.', reached: 0 },
  failed: { icon: 'alert', title: 'Something failed.', hint: 'Fix the problem below and try again.', reached: 0 },
};

/** Review actions for one artifact: submit, approve, request revision, reject, history. Approval is always a deliberate click. */
export function ArtifactBar({ artifact, onChanged, children, actions }: { artifact: Artifact; onChanged: () => void; children?: ReactNode; actions?: ReactNode }) {
  const { push, fail } = useToast();
  const [hist, setHist] = useState<any>(null);
  const [burst, setBurst] = useState(false);
  const a = artifact;
  const look = !a.current_version_id && a.state === 'not_started' ? LOOK.empty : LOOK[a.state];
  const submit = async () => {
    const r = await api.post(`/artifacts/${a.id}/submit`);
    push(r.warnings?.length ? 'warn' : 'ok', r.warnings?.length ? 'Submitted for review, with warnings' : 'Submitted for review', r.warnings);
    onChanged();
  };
  const approve = async () => {
    await api.post(`/artifacts/${a.id}/approve`);
    push('ok', `${a.label} approved`);
    setBurst(true);
    setTimeout(() => setBurst(false), 1400);
    onChanged();
  };
  const simple = (path: string, msg: string) => async () => {
    const note = path === 'reject' || path === 'request-revision' ? prompt('Note (optional)') ?? undefined : undefined;
    await api.post(`/artifacts/${a.id}/${path}`, { note });
    push('ok', msg);
    onChanged();
  };
  const openHistory = async () => {
    try {
      setHist(await api.get(`/artifacts/${a.id}/history`));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <section className={`review rv-${a.state}${burst ? ' celebrate' : ''}`} aria-label={`Review: ${a.label}`}>
        <span className="rv-icon" aria-hidden="true">
          <Icon name={look.icon} />
          {burst && <span className="rv-burst">{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--a': `${i * 36}deg` } as React.CSSProperties} />)}</span>}
        </span>
        <div className="rv-main">
          <div className="row gap wrap">
            <h3>{a.label}</h3>
            <StateBadge state={a.state} />
            {children}
          </div>
          <p className="rv-msg">{look.title} <span className="muted">{look.hint}</span></p>
          {a.last_error && <p className="small" style={{ color: 'var(--bad)', margin: 0 }}>{a.last_error}</p>}
          <ol className="rv-track">
            {['Draft', 'In review', 'Approved'].map((label, i) => (
              <li key={label} className={i < look.reached ? 'done' : i === look.reached ? 'now' : ''} aria-current={i === look.reached ? 'step' : undefined}>{label}</li>
            ))}
          </ol>
        </div>
        <div className={`rv-actions${actions ? ' rv-actions-forward' : ''}`}>
          {actions && <div className="rv-save-action">{actions}</div>}
          {a.state === 'awaiting_review' && <button type="button" className="btn btn-primary btn-lg" onClick={() => approve().catch(fail)}><Icon name="check" small /> Approve</button>}
          {a.state !== 'awaiting_review' && a.state !== 'approved' && (
            <Btn kind="primary" onClick={submit} disabled={!a.current_version_id} title={a.current_version_id ? 'Run readiness checks and ask for approval' : 'There is nothing to review yet'}>Submit for review <Icon name="arrow" small /></Btn>
          )}
          <div className="rv-more">
            {(a.state === 'awaiting_review' || a.state === 'approved') && <Btn small onClick={simple('request-revision', 'Marked as needing revision')}>Request changes</Btn>}
            {a.state === 'awaiting_review' && <Btn small kind="danger" onClick={simple('reject', 'Rejected')}>Reject</Btn>}
            {a.current_version_id && <Btn small kind="ghost" onClick={openHistory}><Icon name="clock" small /> History</Btn>}
          </div>
        </div>
      </section>
      {hist && (
        <Modal title={`History: ${a.label}`} wide onClose={() => setHist(null)}>
          <div className="grid g2">
            <div>
              <h4>Versions</h4>
              <table>
                <tbody>
                  {[...hist.versions].reverse().map((v: any) => (
                    <tr key={v.id}>
                      <td>#{v.seq}</td>
                      <td className="small">{new Date(v.created_at).toLocaleString()}</td>
                      <td>{v.approved_at ? <span className="pill pill-good">approved</span> : <span className="muted small">{v.created_by}</span>}</td>
                      <td>
                        <Btn
                          small
                          onClick={async () => {
                            await withReopen((reopen) => api.post(`/artifacts/${a.id}/restore`, { versionId: v.id, reopen }).catch((e) => { throw e; }));
                            push('ok', `Restored version #${v.seq} as a new version`);
                            setHist(null);
                            onChanged();
                          }}
                        >
                          Restore
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4>Review events</h4>
              <table>
                <tbody>
                  {[...hist.events].reverse().map((e: any) => (
                    <tr key={e.id}>
                      <td className="small">{new Date(e.created_at).toLocaleTimeString()}</td>
                      <td className="small">
                        {e.from_state} → <strong>{e.to_state}</strong>
                      </td>
                      <td className="small muted">{e.actor}{e.note ? `: ${e.note}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
