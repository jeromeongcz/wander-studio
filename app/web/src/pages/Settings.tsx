import { useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Pill, fmtBytes, useToast } from '../ui';

export function SettingsPage() {
  const { push } = useToast();
  const jobs = useAsync(() => api.get<any[]>('/jobs'), []);
  const pf = useAsync(() => api.get<any>('/preflight'), []);
  const cache = useAsync(() => api.get<any>('/cache'), []);
  const tts = useAsync(() => api.get<any[]>('/tts/providers'), []);
  const whisper = useAsync(() => api.get<any>('/alignment/whisper'), []);
  const locales = useAsync(() => api.get<any[]>('/locales'), []);
  const i2v = useAsync(() => api.get<any[]>('/providers/image-to-video'), []);
  const stock = useAsync(() => api.get<any[]>('/providers'), []);
  const templates = useAsync(() => api.get<any[]>('/templates'), []);
  useInterval(jobs.reload, 2500);
  const [loc, setLoc] = useState({ code: '', name: '', bcp47: '', default_wpm: 140 });

  return (
    <div className="stack">
      <h1>Settings</h1>

      <Card title="Background jobs" actions={<Btn small onClick={jobs.reload}>Refresh</Btn>}>
        {jobs.loading && !jobs.data && <Loading />}
        {jobs.data && jobs.data.length === 0 && <Empty>No jobs yet. Renders and batch work started from the Compose stage show up here.</Empty>}
        {jobs.data && jobs.data.length > 0 && (
          <table>
            <thead><tr><th>Job</th><th>State</th><th>Progress</th><th>Details</th><th /></tr></thead>
            <tbody>
              {jobs.data.slice(0, 25).map((j) => (
                <tr key={j.id}>
                  <td>{j.kind.replace(/_/g, ' ')}<div className="muted small mono">{new Date(j.created_at).toLocaleTimeString()}{j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}</div></td>
                  <td><Pill tone={j.state === 'succeeded' ? 'good' : j.state === 'failed' ? 'bad' : j.state === 'cancelled' ? 'neutral' : 'info'}>{j.state}</Pill></td>
                  <td style={{ minWidth: 120 }}><div className="bar-prog"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div></td>
                  <td className="small">
                    {j.message && <div className="muted">{j.message}</div>}
                    {j.error && <div style={{ color: 'var(--bad)' }}>{j.error.message}{j.error.recovery && <div className="muted">Fix: {j.error.recovery}</div>}</div>}
                  </td>
                  <td className="row gap">
                    {(j.state === 'queued' || j.state === 'running') && <Btn small kind="danger" onClick={async () => { await api.post(`/jobs/${j.id}/cancel`); jobs.reload(); }}>Cancel</Btn>}
                    {(j.state === 'failed' || j.state === 'cancelled') && <Btn small onClick={async () => { await api.post(`/jobs/${j.id}/retry`); jobs.reload(); }}>Retry</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Environment check" actions={<Btn small onClick={pf.reload}>Re-check</Btn>}>
          {pf.loading && !pf.data && <Loading />}
          {pf.error && <ErrorBox error={pf.error} />}
          {pf.data && (
            <>
              <p style={{ marginTop: 0 }}>{pf.data.ok ? <Pill tone="good">Ready to render</Pill> : <Pill tone="bad">Needs attention</Pill>}</p>
              <table><tbody>
                {pf.data.checks.map((c: any) => (
                  <tr key={c.name}><td>{c.ok ? '✓' : c.level === 'required' ? '✗' : '–'} {c.name}</td><td className="small muted">{c.detail}{!c.ok && c.fix && <div style={{ color: 'var(--bad)' }}>Fix: {c.fix}</div>}</td></tr>
                ))}
              </tbody></table>
            </>
          )}
        </Card>

        <Card title="Render cache" actions={<Btn small onClick={cache.reload}>Refresh</Btn>}>
          {cache.data && (
            <>
              <p style={{ marginTop: 0 }}><strong>{fmtBytes(cache.data.total_bytes)}</strong> of rebuildable clips and mixes. Clearing it only costs re-render time; finished videos are never touched.</p>
              <table><tbody>{cache.data.dirs.map((d: any) => <tr key={d.name}><td>{d.name}</td><td>{d.files} files</td><td>{fmtBytes(d.bytes)}</td></tr>)}</tbody></table>
              <div className="row gap" style={{ marginTop: 10 }}>
                <Btn onClick={async () => { const r = await api.post('/cache/prune', { older_than_days: 7 }); push('ok', `Removed ${r.removed_files} files (${fmtBytes(r.freed_bytes)})`); cache.reload(); }}>Remove older than 7 days</Btn>
                <Btn kind="danger" onClick={async () => { if (!confirm('Clear the whole render cache?')) return; const r = await api.post('/cache/prune', { max_bytes: 0 }); push('ok', `Cleared ${fmtBytes(r.freed_bytes)}`); cache.reload(); }}>Clear all</Btn>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title="Voices (text-to-speech)">
        <p className="muted" style={{ marginTop: 0 }}>Providers are always chosen explicitly. Nothing falls back to another provider on its own, and nothing is downloaded without you.</p>
        <table>
          <thead><tr><th>Provider</th><th>Status</th><th>Languages</th><th>Terms</th></tr></thead>
          <tbody>
            {(tts.data ?? []).map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong>{p.terms.online && <> <Pill tone="warn">online</Pill></>}</td>
                <td><Pill tone={p.status.ok ? 'good' : 'neutral'}>{p.status.ok ? 'available' : 'not set up'}</Pill><div className="muted small">{p.status.detail}</div></td>
                <td className="small">{p.languages}</td>
                <td className="small">{p.terms.commercialUse}<div className="muted">Privacy: {p.terms.privacy}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {whisper.data && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>Caption alignment with Whisper:</strong> {whisper.data.ready ? 'ready' : `not set up (binary ${whisper.data.binary ? 'found' : 'missing'}, model ${whisper.data.model ? 'set' : 'not set'})`}. Default alignment uses detected pauses and is approximate. Whisper needs a model file you download yourself:
            <ul>{whisper.data.models.map((m: any) => <li key={m.file}>{m.file}: {m.sizeMB} MB download, about {m.ramMB} MB RAM. {m.note}</li>)}</ul>
            <span className="small">{whisper.data.models[0]?.license}. Caption spelling always stays anchored to your approved script.</span>
          </div>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Languages">
          <table><tbody>{(locales.data ?? []).map((l) => <tr key={l.code}><td><strong>{l.name}</strong> <span className="muted mono">{l.code}</span></td><td>{l.bcp47}</td><td>{l.default_wpm} wpm</td><td>{l.builtin ? <Pill>built in</Pill> : <Pill tone="info">custom</Pill>}</td></tr>)}</tbody></table>
          <h4 style={{ margin: '14px 0 8px' }}>Add a language</h4>
          <div className="form">
            <Field label="Code"><input value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value })} placeholder="ceb" /></Field>
            <Field label="Name"><input value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} placeholder="Cebuano" /></Field>
            <Field label="BCP-47 tag"><input value={loc.bcp47} onChange={(e) => setLoc({ ...loc, bcp47: e.target.value })} placeholder="ceb-PH" /></Field>
            <Field label="Default speaking speed (wpm)"><input type="number" value={loc.default_wpm} onChange={(e) => setLoc({ ...loc, default_wpm: Number(e.target.value) })} /></Field>
          </div>
          <div style={{ marginTop: 10 }}><Btn disabled={!loc.code || !loc.name || !loc.bcp47} onClick={async () => { await api.post('/locales', loc); push('ok', `${loc.name} added`); setLoc({ code: '', name: '', bcp47: '', default_wpm: 140 }); locales.reload(); }}>Add language</Btn></div>
        </Card>

        <Card title="Sources and providers">
          <table><tbody>
            {(stock.data ?? []).map((p) => <tr key={p.id}><td><strong>{p.name}</strong><div className="muted small">{p.terms.freeTier}</div></td><td className="small">{p.terms.commercialUse}<div className="muted">Privacy: {p.terms.privacy}</div></td></tr>)}
            {(i2v.data ?? []).map((p) => <tr key={p.id}><td><strong>{p.name}</strong><div className="muted small">image to video</div></td><td className="small">{p.requirements.gpu ? 'Needs a GPU. ' : 'No GPU needed. '}{p.requirements.downloadsModel ? 'Downloads a model. ' : 'No downloads. '}{p.terms.commercialUse}</td></tr>)}
          </tbody></table>
          <p className="muted small">AI image-to-video models and cloud GPU services are not bundled: they need an endpoint or a large model download that you should approve first.</p>
        </Card>
      </div>

      <Card title="Templates">
        <div className="grid g3">
          {(templates.data ?? []).map((t) => (
            <div key={t.id} className="scene">
              <div className="row gap"><strong>{t.name}</strong><span className="grow" /><Pill>{t.kind === 'caption_style' ? 'caption style' : 'script outline'}</Pill></div>
              <div className="muted small" style={{ marginTop: 6 }}>{t.kind === 'script_outline' ? t.content.sections.map((s: any) => s.kind).join(' → ') : `${t.content.font_family}${t.content.pill?.enabled ? ', pill' : ''}${t.content.active_word?.enabled ? ', active word' : ''}`}</div>
              {!t.builtin && <Btn small kind="danger" onClick={async () => { await api.del(`/templates/${t.id}`); templates.reload(); }}>Delete</Btn>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
