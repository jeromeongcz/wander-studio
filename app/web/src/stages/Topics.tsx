import { useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { useProject } from '../pages/Project';
import { Btn, Card, CopyBtn, Empty, Field, Loading, Modal, Pill, Tabs, useToast } from '../ui';

const CONF: Record<string, { tone: 'good' | 'warn' | 'info'; label: string; help: string }> = {
  'well-documented': { tone: 'good', label: 'Well documented', help: 'Several reliable sources agree' },
  disputed: { tone: 'warn', label: 'Disputed', help: 'Sources disagree or the origin is unclear' },
  legend: { tone: 'info', label: 'Legend or belief', help: 'The facts describe what is recorded about the story, not that it is true' },
};
const LINK: Record<string, { mark: string; tone: string; help: string }> = {
  reachable: { mark: '✓', tone: 'var(--good)', help: 'The page loads. Still read it: this does not prove it says what the fact claims.' },
  unclear: { mark: '?', tone: 'var(--warn)', help: 'Could not confirm: the site may block automated checks. Open it yourself.' },
  dead: { mark: '✗', tone: 'var(--bad)', help: 'The page was not found. Treat this fact as unconfirmed: it may be a wrong or made-up link.' },
  unchecked: { mark: '–', tone: 'var(--muted)', help: 'Not checked yet.' },
};
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export function TopicsPanel({ onUsed, hasNotes }: { onUsed: () => void; hasNotes: boolean }) {
  const { project, reload } = useProject();
  const { push, fail } = useToast();
  const status = useAsync(() => api.get<any>('/research/status'), []);
  const data = useAsync(() => api.get<any>(`/projects/${project.id}/research/topics`), [project.id]);
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState('');
  const [notes, setNotes] = useState('');
  const [filter, setFilter] = useState<'new' | 'used' | 'dismissed'>('new');
  const [job, setJob] = useState<any>(null);
  const [manual, setManual] = useState(false);

  const batches: any[] = data.data?.batches ?? [];
  const ideas: any[] = data.data?.ideas ?? [];
  const running = batches.find((b) => b.state === 'queued' || b.state === 'running');
  // follow the running job so progress and the finished topics show up without reloading
  useInterval(async () => {
    try {
      if (running?.job_id) setJob(await api.get(`/jobs/${running.job_id}`));
      data.reload();
    } catch { /* the next tick retries */ }
  }, running ? 2000 : null);
  const last = batches[0];
  const cc = status.data;
  const ready = !!cc?.loggedIn;
  const shown = ideas.filter((i) => i.status === filter);
  const counts = { new: ideas.filter((i) => i.status === 'new').length, used: ideas.filter((i) => i.status === 'used').length, dismissed: ideas.filter((i) => i.status === 'dismissed').length };

  const start = async () => {
    if (!sessionStorage.getItem('wander-cc-research-ok')) {
      if (!confirm('This runs Claude Code on this computer, using your Claude plan.\n\nIt can search the web and open pages, but it cannot read your files or run commands. Only the category, your focus and notes, and the number of topics are sent.\n\nIt can take several minutes. Continue?')) return;
      sessionStorage.setItem('wander-cc-research-ok', '1');
    }
    const r = await api.post(`/projects/${project.id}/research/batches`, { count, focus, notes });
    setJob(r.job);
    push('ok', `Researching ${count} topic${count === 1 ? '' : 's'}…`);
    data.reload();
  };

  const useIt = async (id: string) => {
    if (hasNotes && !confirm('Replace the current research notes with this topic?\n\nYour earlier notes stay in the version history.')) return;
    const call = (reopen: boolean) => api.post(`/topic-ideas/${id}/use`, { reopen });
    try { await call(false); } catch (e: any) {
      if (e.code === 'PROTECTED' && confirm('The research is approved. Replace it with this topic?\n\nThe approved version stays in history, and everything that depends on it will need revision.')) await call(true); else throw e;
    }
    push('ok', 'Topic added to your research notes. Open the sources and verify the facts.');
    reload();
    onUsed();
  };

  return (
    <>
      <Card title="Research topics with AI">
        <div className="stack">
          <div className="form">
            <Field label="How many topics?" hint="You choose; Claude researches that many (1 to 20)">
              <div className="row gap">
                <input type="range" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of topics" />
                <input type="number" min={1} max={20} value={count} style={{ width: 70 }} onChange={(e) => setCount(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} aria-label="Number of topics (number)" />
              </div>
            </Field>
            <Field label="Category" hint="Change it under Details & settings"><input value={project.category ?? 'None (general)'} readOnly /></Field>
            <Field label="Focus or country (optional)" hint="For example: Philippines, Visayas, Japan"><input value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={200} placeholder="Philippines" /></Field>
            <Field label="Extra notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} placeholder="e.g. skip anything about wars" /></Field>
          </div>

          {!status.data && <Loading what="Checking Claude Code" />}
          {cc && ready && <div className="notice">✓ {cc.detail}. It will search the web with web tools only: it cannot read your files or run commands, and it uses your Claude plan.</div>}
          {cc && !ready && (
            <div className="notice warn">
              <strong>{cc.detail}.</strong>
              {cc.fix && <div style={{ marginTop: 6 }}>{cc.fix}</div>}
              <div className="row gap" style={{ marginTop: 8 }}>
                <CopyBtn text="claude auth login" label="Copy: claude auth login" />
                <Btn small onClick={async () => { status.reload(); }}>Check again</Btn>
              </div>
            </div>
          )}

          <div className="row gap wrap">
            <Btn kind="primary" disabled={!ready || !!running} onClick={start}>{running ? 'Researching…' : `Research ${count} topic${count === 1 ? '' : 's'}`}</Btn>
            <Btn onClick={() => setManual(true)}>Use a prompt instead…</Btn>
            <span className="muted small">A run takes a few minutes: it reads real web pages.</span>
          </div>

          {running && (
            <div className="stack">
              <div className="row gap">
                <Pill tone="info">{running.state === 'queued' ? 'waiting' : 'researching'}</Pill>
                <div className="bar-prog grow"><i style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} /></div>
                <Btn small kind="danger" onClick={async () => { if (running.job_id) await api.post(`/jobs/${running.job_id}/cancel`); data.reload(); }}>Cancel</Btn>
              </div>
              <div className="muted small">{job?.message ?? 'Starting…'} Topics already found are kept if you cancel.</div>
            </div>
          )}
          {last && !running && last.state !== 'done' && (
            <div className={`notice ${last.state === 'failed' ? 'bad' : 'warn'}`}>
              <strong>Last run {last.state}.</strong> {last.message}
              {last.rejected?.length > 0 && <ul>{last.rejected.slice(0, 5).map((r: any, i: number) => <li key={i}>{r.title}: {r.reason}</li>)}</ul>}
            </div>
          )}
        </div>
      </Card>

      <div className="notice small">AI research can be wrong. <strong>Nothing here is verified.</strong> A ✓ only means the link loads. Open each source and read it before you mark a fact verified.</div>

      {ideas.length > 0 && <Tabs value={filter} onChange={setFilter} items={[{ id: 'new', label: `New (${counts.new})` }, { id: 'used', label: `Used (${counts.used})` }, { id: 'dismissed', label: `Dismissed (${counts.dismissed})` }]} />}
      {data.loading && !data.data && <Loading />}
      {shown.length === 0 && ideas.length === 0 && !running && <Empty>No topics yet. Choose how many you want and press Research.</Empty>}
      {shown.length === 0 && ideas.length > 0 && <Empty>Nothing in this list.</Empty>}
      <div className="grid g2">
        {shown.map((t) => {
          const c = CONF[t.confidence];
          return (
            <section key={t.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="row gap wrap"><h3 style={{ flex: 1 }}>{t.title}</h3><span title={c.help}><Pill tone={c.tone}>{c.label}</Pill></span></div>
              <div>{t.hook}</div>
              {t.note && <div className="muted small">{t.note}</div>}
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {t.facts.map((f: any, i: number) => {
                  const l = LINK[f.link_status ?? 'unchecked'];
                  return (
                    <li key={i} className="small" style={{ marginBottom: 4 }}>
                      {f.text}{' '}
                      <a href={f.source_url} target="_blank" rel="noopener noreferrer">{f.source_title ? `${f.source_title} · ` : ''}{host(f.source_url)}</a>{' '}
                      <span title={`${l.help}${f.link_note ? ` (${f.link_note})` : ''}`} style={{ color: l.tone, fontWeight: 700 }}>{l.mark}</span>
                    </li>
                  );
                })}
              </ul>
              {t.links.dead > 0 && <div className="notice bad small">{t.links.dead} source link{t.links.dead === 1 ? '' : 's'} did not load. Do not trust {t.links.dead === 1 ? 'that fact' : 'those facts'} until you find a real source.</div>}
              <div className="row gap wrap" style={{ marginTop: 'auto' }}>
                {t.status !== 'used' && <Btn small kind="primary" onClick={() => useIt(t.id)}>Use for this video</Btn>}
                {t.status !== 'used' && <Btn small onClick={async () => { const r = await api.post(`/topic-ideas/${t.id}/new-project`); push('ok', 'New video project created'); location.hash = `#/p/${r.projectId}/research`; }}>New video from this</Btn>}
                {t.status === 'new' && <Btn small kind="ghost" onClick={async () => { await api.post(`/topic-ideas/${t.id}/dismiss`); data.reload(); }}>Dismiss</Btn>}
                {t.status === 'dismissed' && <Btn small onClick={async () => { await api.post(`/topic-ideas/${t.id}/restore`); data.reload(); }}>Restore</Btn>}
                {t.status === 'used' && <Pill tone="good">used</Pill>}
              </div>
            </section>
          );
        })}
      </div>
      {manual && <ManualResearch count={count} focus={focus} notes={notes} onClose={() => setManual(false)} onDone={() => { setManual(false); data.reload(); }} fail={fail} />}
    </>
  );
}

function ManualResearch({ count, focus, notes, onClose, onDone, fail }: { count: number; focus: string; notes: string; onClose: () => void; onDone: () => void; fail: (e: unknown) => void }) {
  const { project } = useProject();
  const { push } = useToast();
  const prompt = useAsync(() => api.post<{ prompt: string }>(`/projects/${project.id}/research/prompt`, { count, focus, notes }), []);
  const [text, setText] = useState('');
  return (
    <Modal title="Research with a prompt" wide onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>1) Copy the prompt into any AI that can search the web. 2) Paste its JSON answer below. The answer is checked the same way, including whether each source link loads.</p>
        {!prompt.data ? <Loading /> : <><div className="row gap"><CopyBtn text={prompt.data.prompt} label="Copy prompt" /></div><pre>{prompt.data.prompt}</pre></>}
        <Field label="Paste the answer here" wide><textarea style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"topics":[ ... ]}' /></Field>
        <div className="row gap">
          <Btn kind="primary" disabled={!text.trim()} onClick={async () => {
            try { const b = await api.post(`/projects/${project.id}/research/import`, { text, focus }); push('ok', b.message); onDone(); } catch (e) { fail(e); }
          }}>Import topics</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
