import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, Empty, Field, Loading, Pill, useToast } from '../ui';

const CHECKLIST = ['Every key fact has at least one source', 'Dates, names and numbers were double-checked', 'Unverified claims are marked or removed', 'Creative speculation is labelled as speculation', 'No AI-generated summary is treated as verified'];
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;

function ResearchNotes() {
  const { project, find, reload } = useProject();
  const art = find('research')!;
  const { push } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!loaded.data) return;
    setC(loaded.data.content ?? { topic: project.name, category: project.category ?? undefined, angle: '', notes: '', sources: [], claims: [], checklist: CHECKLIST.map((label, i) => ({ id: `chk${i + 1}`, label, done: false })) });
    setDirty(!loaded.data.content);
  }, [loaded.data, project.name, project.category]);
  if (!c) return <Loading />;
  const edit = (patch: any) => { setC({ ...c, ...patch }); setDirty(true); };
  const save = async () => {
    const r = await saveArtifact(art.id, c);
    push('ok', r.changed ? 'Research saved' : 'No changes to save');
    setDirty(false);
    reload();
  };
  const verifiedNoSource = c.claims.filter((x: any) => x.status === 'verified' && !x.sourceIds.length).length;
  return (
    <>
      <ArtifactBar artifact={art} onChanged={() => { reload(); loaded.reload(); }}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      <Card title="Topic">
        <div className="form">
          <Field label="Topic"><input value={c.topic} onChange={(e) => edit({ topic: e.target.value })} /></Field>
          <Field label="Angle or hook idea"><input value={c.angle ?? ''} onChange={(e) => edit({ angle: e.target.value })} placeholder="What makes this worth watching?" /></Field>
          <Field label="Notes" wide><textarea value={c.notes ?? ''} onChange={(e) => edit({ notes: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Sources" actions={<Btn small onClick={() => edit({ sources: [...c.sources, { id: uid('s'), url: 'https://', title: '' }] })}>Add source</Btn>}>
        {c.sources.length === 0 ? <Empty>Add the pages you are relying on. Facts marked verified must point at a source. Never paste a citation you have not opened.</Empty> : (
          <table><tbody>
            {c.sources.map((s: any, i: number) => (
              <tr key={s.id}>
                <td><input aria-label="Source URL" value={s.url} onChange={(e) => edit({ sources: c.sources.map((x: any, k: number) => (k === i ? { ...x, url: e.target.value } : x)) })} /></td>
                <td><input aria-label="Source title" placeholder="Title or note" value={s.title ?? ''} onChange={(e) => edit({ sources: c.sources.map((x: any, k: number) => (k === i ? { ...x, title: e.target.value } : x)) })} /></td>
                <td><Btn small kind="ghost" onClick={() => edit({ sources: c.sources.filter((_: any, k: number) => k !== i), claims: c.claims.map((cl: any) => ({ ...cl, sourceIds: cl.sourceIds.filter((x: string) => x !== s.id) })) })}>Remove</Btn></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>
      <Card title="Claims" actions={<Btn small onClick={() => edit({ claims: [...c.claims, { id: uid('c'), text: '', status: 'unverified', sourceIds: [] }] })}>Add claim</Btn>}>
        <p className="muted small" style={{ marginTop: 0 }}>Keep verified facts, unverified claims and creative speculation separate. Only you can mark a claim verified.</p>
        {verifiedNoSource > 0 && <div className="notice warn" style={{ marginBottom: 10 }}>{verifiedNoSource} verified claim(s) have no source yet.</div>}
        <div className="stack">
          {c.claims.map((cl: any, i: number) => (
            <div key={cl.id} className="scene">
              <div className="row gap">
                <input aria-label="Claim" value={cl.text} placeholder="State the claim" onChange={(e) => edit({ claims: c.claims.map((x: any, k: number) => (k === i ? { ...x, text: e.target.value } : x)) })} />
                <select aria-label="Status" style={{ width: 160 }} value={cl.status} onChange={(e) => edit({ claims: c.claims.map((x: any, k: number) => (k === i ? { ...x, status: e.target.value } : x)) })}>
                  <option value="verified">Verified</option><option value="unverified">Unverified</option><option value="speculation">Speculation</option>
                </select>
                <Btn small kind="ghost" onClick={() => edit({ claims: c.claims.filter((_: any, k: number) => k !== i) })}>Remove</Btn>
              </div>
              {c.sources.length > 0 && (
                <div className="row gap wrap small" style={{ marginTop: 8 }}>
                  <span className="muted">Sources:</span>
                  {c.sources.map((s: any) => (
                    <label key={s.id} className="row gap"><input type="checkbox" checked={cl.sourceIds.includes(s.id)} onChange={(e) => edit({ claims: c.claims.map((x: any, k: number) => (k === i ? { ...x, sourceIds: e.target.checked ? [...x.sourceIds, s.id] : x.sourceIds.filter((y: string) => y !== s.id) } : x)) })} />{s.title || s.url.replace(/^https?:\/\//, '').slice(0, 30)}</label>
                  ))}
                </div>
              )}
            </div>
          ))}
          {c.claims.length === 0 && <Empty>No claims yet.</Empty>}
        </div>
      </Card>
      <Card title="Fact-verification checklist" actions={<span className="muted small">{c.checklist.filter((x: any) => x.done).length}/{c.checklist.length} done</span>}>
        <div className="stack">
          {c.checklist.map((k: any, i: number) => (
            <label key={k.id} className="row gap"><input type="checkbox" checked={k.done} onChange={(e) => edit({ checklist: c.checklist.map((x: any, j: number) => (j === i ? { ...x, done: e.target.checked } : x)) })} />{k.label}</label>
          ))}
        </div>
      </Card>
      <div className="row gap"><Btn kind="primary" onClick={save} disabled={!dirty}>Save research</Btn><span className="muted small">Then submit it for review above. Submission is blocked until the checklist is complete and verified claims have sources.</span></div>
    </>
  );
}

/** Topic step inside a project: the research notes. Finding topics happens in the Research Studio. */
export function ResearchStage() {
  const { find } = useProject();
  const art = find('research')!;
  return (
    <>
      {!art.current_version_id && <div className="notice">Looking for ideas? Search and approve a topic in the <a href="#/">Research Studio</a>, then start a video from it. Or fill in your own research notes below.</div>}
      <ResearchNotes />
    </>
  );
}
