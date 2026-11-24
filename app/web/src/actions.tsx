import { useState } from 'react';
import { api, ApiError } from './api';
import { Btn, Modal, StateBadge, useToast } from './ui';
import type { Artifact } from './types';

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

/** Review actions for one artifact: submit, approve, request revision, reject, history. Approval is always a deliberate click. */
export function ArtifactBar({ artifact, onChanged, children }: { artifact: Artifact; onChanged: () => void; children?: React.ReactNode }) {
  const { push, fail } = useToast();
  const [hist, setHist] = useState<any>(null);
  const a = artifact;
  const submit = async () => {
    const r = await api.post(`/artifacts/${a.id}/submit`);
    push(r.warnings?.length ? 'warn' : 'ok', r.warnings?.length ? 'Submitted for review, with warnings' : 'Submitted for review', r.warnings);
    onChanged();
  };
  const approve = async () => {
    await api.post(`/artifacts/${a.id}/approve`);
    push('ok', `${a.label} approved`);
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
      <div className="bar">
        <strong>{a.label}</strong>
        <StateBadge state={a.state} />
        {a.last_error && <span className="small" style={{ color: 'var(--bad)' }}>{a.last_error}</span>}
        <span className="grow" />
        {children}
        <Btn small onClick={submit} disabled={!a.current_version_id || a.state === 'approved' || a.state === 'awaiting_review'} title="Run readiness checks and ask for approval">
          Submit for review
        </Btn>
        <Btn small kind="primary" onClick={approve} disabled={a.state !== 'awaiting_review'} title="Only you can approve">
          Approve
        </Btn>
        <Btn small onClick={simple('request-revision', 'Marked as needing revision')} disabled={a.state !== 'awaiting_review' && a.state !== 'approved'}>
          Needs revision
        </Btn>
        <Btn small kind="danger" onClick={simple('reject', 'Rejected')} disabled={a.state !== 'awaiting_review'}>
          Reject
        </Btn>
        <Btn small kind="ghost" onClick={openHistory} disabled={!a.current_version_id}>
          History
        </Btn>
      </div>
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
