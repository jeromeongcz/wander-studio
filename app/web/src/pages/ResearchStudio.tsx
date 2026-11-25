import { useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Icon, Loading, Modal, Pill, useToast } from '../ui';
import { CategoryPicker } from '../stages/shared';
import { useTopicFilter } from './TopicFilters';
import { ProgressFooter } from '../progress';
import { LANG_LABEL, formatName } from '../types';

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


/** Research workspace: approved topics (with the rest below) on the left, the research form on the right. No project is needed. */
export function ResearchWorkspace() {
  const { push, fail } = useToast();
  const status = useAsync(() => api.get<any>('/research/status'), []);
  const data = useAsync(() => api.get<any>('/studio/research'), []);
  const videos = useAsync(() => api.get<{ id: string; name: string }[]>('/projects'), []);
  // the video started from a topic; matched by name when the server has not recorded the link
  const videoOf = (t: any): string | undefined => t.video_project_id ?? videos.data?.find((v) => v.name === t.title.slice(0, 120))?.id;
  const [category, setCategory] = useState('');
  const [focus, setFocus] = useState('');
  const [count, setCount] = useState(5);
  const [notes, setNotes] = useState('');
  const [manual, setManual] = useState(false);
  const [approving, setApproving] = useState<any>(null);
  const [starting, setStarting] = useState<any>(null);

  const batches: any[] = data.data?.batches ?? [];
  const ideas: any[] = data.data?.ideas ?? [];
  const running = batches.find((b) => b.state === 'queued' || b.state === 'running');
  useInterval(() => data.reload(), running ? 2000 : null);
  const last = batches[0];
  const cc = status.data;
  const ready = !!cc?.loggedIn;
  const by = (s: string) => ideas.filter((i) => i.status === s);
  const started = by('used'), approved = [...by('approved'), ...started], toReview = by('new'), dismissed = by('dismissed');
  // the approved list is dated by approval, the others by when they were researched
  const approvedList = useTopicFilter(approved, (t) => t.approved_at ?? t.created_at, 'approved topics');
  const reviewList = useTopicFilter(toReview, (t) => t.created_at, 'topics not approved yet');

  const start = async () => {
    if (!sessionStorage.getItem('wander-cc-research-ok')) {
      if (!confirm('This runs Claude Code on this computer, using your Claude plan.\n\nIt can search the web and open pages, but it cannot read your files or run commands. Only the category, your search, your notes and the number of topics are sent.\n\nIt can take several minutes. Continue?')) return;
      sessionStorage.setItem('wander-cc-research-ok', '1');
    }
    await api.post('/studio/research/batches', { count, focus, notes, category });
    push('ok', `Researching ${count} topic${count === 1 ? '' : 's'}…`);
    data.reload();
  };

  const card = (t: any) => {
    const c = CONF[t.confidence];
    return (
      <section key={t.id} className={`card topic topic-${t.status}`}>
        {(t.status === 'approved' || t.status === 'used') && (
          <header className="topic-top">
            <span className="topic-state">
              <i><Icon name={t.status === 'used' ? 'film' : 'check'} small /></i>
              <span><b>{t.status === 'used' ? 'Video started' : 'Approved'}</b>{t.status === 'approved' && t.approved_at && <span>{new Date(t.approved_at).toLocaleDateString()}</span>}{t.status === 'used' && <span>Pick up where you left off</span>}</span>
            </span>
            {t.status === 'approved' && <button type="button" className="topic-go" onClick={() => setStarting(t)}><Icon name="play" small /> Start a video from this</button>}
            {t.status === 'used' && <a className="topic-go open" href={videoOf(t) ? `#/p/${videoOf(t)}/research` : '#/projects'}>{videoOf(t) ? 'Open video' : 'Go to Video Production'} <Icon name="arrow" small /></a>}
          </header>
        )}
        <h3>{t.title}</h3>
        <div className="row gap wrap">
          <span title={c.help}><Pill tone={c.tone}>{c.label}</Pill></span>
          {t.category && <Pill tone="info">{t.category}</Pill>}
        </div>
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
          {t.status === 'new' && <Btn small kind="primary" onClick={() => setApproving(t)}><Icon name="check" small /> Approve topic</Btn>}
          {t.status === 'new' && <span className="muted small right">researched {new Date(t.created_at).toLocaleDateString()}</span>}
          {t.status === 'new' && <Btn small kind="ghost" onClick={async () => { await api.post(`/topic-ideas/${t.id}/dismiss`); data.reload(); }}>Dismiss</Btn>}
          {t.status === 'approved' && <Btn small kind="ghost" onClick={async () => { await api.post(`/topic-ideas/${t.id}/restore`); data.reload(); }}>Undo approval</Btn>}
          {t.status === 'dismissed' && <Btn small onClick={async () => { await api.post(`/topic-ideas/${t.id}/restore`); data.reload(); }}>Restore</Btn>}
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="ws">
        <div className="ws-form">
          <Card title="Research form">
            <div className="stack">
              <div className="form" style={{ gridTemplateColumns: '1fr' }}>
                <CategoryPicker value={category} onChange={setCategory} />
                <Field label="What should Claude look into?" hint="A subject, place or story. Leave empty for general ideas in the category."><input value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={200} placeholder="e.g. Aswang stories in the Visayas" /></Field>
                <Field label="How many topics?" hint="You choose (1 to 20)">
                  <div className="row gap">
                    <input type="range" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of topics" />
                    <input type="number" min={1} max={20} value={count} style={{ width: 70 }} onChange={(e) => setCount(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} aria-label="Number of topics (number)" />
                  </div>
                </Field>
                <Field label="Extra notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} placeholder="e.g. skip anything about wars" /></Field>
              </div>
              {!status.data && status.loading && <Loading what="Checking Claude Code" />}
              {!status.data && status.error && (
                <div className="notice bad">
                  <strong>Could not check Claude Code.</strong> {status.error.message}
                  <div style={{ marginTop: 6 }}>If you updated the app, stop the server in your terminal (Ctrl+C), run <code>npm start</code> again, then refresh this page.</div>
                  <div className="row gap" style={{ marginTop: 8 }}><Btn small onClick={async () => { status.reload(); }}>Try again</Btn></div>
                </div>
              )}
              {cc && ready && <div className="notice small">✓ {cc.detail}. It searches the web with web tools only: it cannot read your files or run commands, and it uses your Claude plan.</div>}
              {cc && !ready && (
                <div className="notice warn">
                  <strong>{cc.detail}.</strong>
                  {cc.fix && <div style={{ marginTop: 6 }}>{cc.fix}</div>}
                  <div className="row gap" style={{ marginTop: 8 }}><CopyBtn text="claude auth login" label="Copy: claude auth login" /><Btn small onClick={async () => { status.reload(); }}>Check again</Btn></div>
                </div>
              )}
              <div className="row gap wrap">
                <Btn kind="primary" disabled={!ready || !!running} onClick={start}><Icon name="spark" small /> {running ? 'Researching…' : `Research ${count} topic${count === 1 ? '' : 's'}`}</Btn>
                <Btn onClick={() => setManual(true)}>Use a prompt instead…</Btn>
              </div>
              <span className="muted small">A run takes a few minutes: it reads real web pages.</span>
              {last && !running && last.state !== 'done' && (
                <div className={`notice ${last.state === 'failed' ? 'bad' : 'warn'}`}>
                  <strong>Last run {last.state}.</strong> {last.message}
                  {last.rejected?.length > 0 && <ul>{last.rejected.slice(0, 5).map((r: any, i: number) => <li key={i}>{r.title}: {r.reason}</li>)}</ul>}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="ws-topics stack">
          <div>
            <div className="section-h" id="approved-topics" style={{ marginTop: 0 }}><h2>Approved topics</h2><span className="muted">{approved.length - started.length} ready to become a video{started.length ? ` · ${started.length} started` : ''}</span></div>
            {data.loading && !data.data && <Loading />}
            {approved.length === 0 && !(data.loading && !data.data) && <Empty>Nothing approved yet. Approve a topic from the list below.</Empty>}
            {approvedList.bar}
            {approvedList.empty && <Empty>No approved topics match these filters.</Empty>}
            <div className="stack">{approvedList.shown.map(card)}</div>
          </div>
          <div>
            <div className="section-h"><h2>Not approved yet</h2><span className="muted">{toReview.length} to review. Read the facts and open the sources first.</span></div>
            <div className="notice small" style={{ marginBottom: 12 }}>AI research can be wrong. <strong>Nothing here is verified.</strong> A ✓ only means the link loads. Approving a topic means you want to make a video about it; you still verify the facts in the video.</div>
            {toReview.length === 0 && <Empty>No topics to review. Fill in the form and press Research.</Empty>}
            {reviewList.bar}
            {reviewList.empty && <Empty>No topics match these filters.</Empty>}
            <div className="stack">{reviewList.shown.map(card)}</div>
          </div>
          {dismissed.length > 0 && <details><summary className="muted">Dismissed ({dismissed.length})</summary><div className="stack" style={{ marginTop: 10 }}>{dismissed.map(card)}</div></details>}
        </div>
      </div>

      {running && <ProgressFooter label={running.state === 'queued' ? 'Waiting to research…' : 'Researching topics…'} detail={`${running.message ?? 'Starting…'} Topics already found are kept if you cancel.`} startedAt={Date.parse(running.created_at)} onCancel={async () => { await api.post(`/studio/research/batches/${running.id}/cancel`); data.reload(); }} />}

      {approving && (
        <Modal title="Approve this topic?" onClose={() => setApproving(null)}>
          <div className="stack">
            <div><h2>{approving.title}</h2><p className="muted" style={{ margin: '6px 0 0' }}>{approving.hook}</p></div>
            <div className="row gap wrap"><Pill tone="info">{approving.facts.length} facts</Pill><Pill tone={approving.links.dead ? 'bad' : approving.links.reachable === approving.facts.length ? 'good' : 'warn'}>{approving.links.reachable} of {approving.facts.length} links load</Pill><Pill tone="warn">none verified</Pill></div>
            {approving.links.dead > 0 && <div className="notice bad">{approving.links.dead} source link(s) did not load. You can still approve the topic, but find real sources before using those facts.</div>}
            <div className="row gap"><span className="grow" /><Btn onClick={() => setApproving(null)}>Not yet</Btn>
              <Btn kind="primary" onClick={async () => { await api.post(`/topic-ideas/${approving.id}/approve`); push('ok', 'Topic approved. It is now under Approved topics.'); setApproving(null); data.reload(); setTimeout(() => document.getElementById('approved-topics')?.scrollIntoView({ behavior: 'smooth' }), 300); }}>Approve topic</Btn></div>
          </div>
        </Modal>
      )}
      {starting && <StartVideo idea={starting} onClose={() => setStarting(null)} />}
      {manual && <ManualResearch count={count} focus={focus} notes={notes} category={category} onClose={() => setManual(false)} onDone={() => { setManual(false); data.reload(); }} fail={fail} />}
    </>
  );
}

/** The Research Studio page: the same workspace on its own. */
export function ResearchStudio() {
  return (
    <div className="stack">
      <section className="hero">
        <div className="grow">
          <h1>Research Studio</h1>
          <p>Search a topic and Claude researches it with sources. You read it, approve the one you want, then start a video from it. No project is created until you say so.</p>
        </div>
        <a className="btn" href="#/projects">Video Production</a>
      </section>
      <ResearchWorkspace />
    </div>
  );
}

function StartVideo({ idea, onClose }: { idea: any; onClose: () => void }) {
  const locales = useAsync(() => api.get<{ code: string; name: string }[]>('/locales'), []);
  const [langs, setLangs] = useState<string[]>(['en']);
  const [formats, setFormats] = useState<string[]>(['vertical_9x16']);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <Modal title="Start a video from this topic" onClose={onClose}>
      <div className="stack">
        <div><h3>{idea.title}</h3><p className="muted small" style={{ margin: '4px 0 0' }}>This creates the project and fills in its research notes. The next step is the script.</p></div>
        <Field label="Languages"><div className="row gap wrap">{(locales.data ?? []).map((l) => <label key={l.code} className="row gap"><input type="checkbox" checked={langs.includes(l.code)} onChange={() => toggle(langs, l.code, setLangs)} />{LANG_LABEL[l.code] ?? l.name}</label>)}</div></Field>
        <Field label="Formats"><div className="row gap wrap">{['vertical_9x16', 'horizontal_16x9', 'square_1x1'].map((f) => <label key={f} className="row gap"><input type="checkbox" checked={formats.includes(f)} onChange={() => toggle(formats, f, setFormats)} />{formatName(f)}</label>)}</div></Field>
        <div className="row gap"><span className="grow" /><Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!langs.length || !formats.length} onClick={async () => { const r = await api.post(`/topic-ideas/${idea.id}/new-project`, { languages: langs, formats }); location.hash = `#/p/${r.projectId}/research`; }}>Create video &amp; continue</Btn></div>
      </div>
    </Modal>
  );
}

function ManualResearch({ count, focus, notes, category, onClose, onDone, fail }: { count: number; focus: string; notes: string; category: string; onClose: () => void; onDone: () => void; fail: (e: unknown) => void }) {
  const { push } = useToast();
  const prompt = useAsync(() => api.post<{ prompt: string }>('/studio/research/prompt', { count, focus, notes, category }), []);
  const [text, setText] = useState('');
  return (
    <Modal title="Research with a prompt" wide onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>1) Copy the prompt into any AI that can search the web. 2) Paste its JSON answer below. The answer is checked the same way, including whether each source link loads.</p>
        {!prompt.data ? <Loading /> : <><div className="row gap"><CopyBtn text={prompt.data.prompt} label="Copy prompt" /></div><pre>{prompt.data.prompt}</pre></>}
        <Field label="Paste the answer here" wide><textarea style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"topics":[ ... ]}' /></Field>
        <div className="row gap">
          <Btn kind="primary" disabled={!text.trim()} onClick={async () => { try { const b = await api.post('/studio/research/import', { text, focus, category }); push('ok', b.message); onDone(); } catch (e) { fail(e); } }}>Import topics</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
