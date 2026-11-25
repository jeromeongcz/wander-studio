import { useState } from 'react';
import { api, url } from '../api';
import { useAsync } from '../hooks';
import { Empty, ErrorBox, Loading, Modal, Pill, Tabs, fmtBytes } from '../ui';
import { ASSET_TYPES } from '../types';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad'> = { approved: 'good', pending: 'warn', rejected: 'bad' };
const label = (s: string) => s.replace(/_/g, ' ');
type Scope = 'all' | 'shared' | 'project';

/** Every image and clip across all videos and the shared library. Managing an asset (approve, license, focal point) still happens in its video's Visuals step. */
export function AssetLibrary() {
  const list = useAsync(() => api.get<any[]>('/assets'), []);
  const [scope, setScope] = useState<Scope>('all');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<any>(null);
  const all = list.data ?? [];
  const shown = all.filter((a) => (scope === 'all' || a.scope === scope) && (!type || a.type === type) && (!status || a.approval_status === status) && (!q.trim() || `${a.name} ${a.tags.join(' ')} ${a.project_name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const count = (s: Scope) => (s === 'all' ? all.length : all.filter((a) => a.scope === s).length);
  return (
    <div className="stack">
      <section className="hero">
        <div className="grow"><h1>Asset Library</h1><p>Every image and clip in your videos and the shared library, with its licence. To approve or edit one, open it in its video's Visuals step.</p></div>
      </section>
      <Tabs value={scope} onChange={setScope} items={[{ id: 'all', label: `All (${count('all')})` }, { id: 'shared', label: `Shared library (${count('shared')})` }, { id: 'project', label: `In videos (${count('project')})` }]} />
      <div className="bar">
        <input style={{ maxWidth: 280 }} placeholder="Search name, tag or video" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ maxWidth: 200 }} aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{ASSET_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
        <select style={{ maxWidth: 200 }} aria-label="Approval" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any approval</option><option value="approved">Approved</option><option value="pending">Pending</option><option value="rejected">Rejected</option></select>
        <span className="grow" /><span className="muted small">{shown.length} shown</span>
      </div>
      {list.loading && !list.data && <Loading what="Loading assets" />}
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      {list.data && all.length === 0 && <Empty>No assets yet. Add images in a video's Visuals step; approved ones can be shared across videos.</Empty>}
      {list.data && all.length > 0 && shown.length === 0 && <Empty>Nothing matches those filters.</Empty>}
      <div className="grid g3">
        {shown.map((a) => (
          <button key={a.id} className="asset lib" onClick={() => setOpen(a)} aria-label={`Open ${a.name}`}>
            {a.media_kind === 'video' ? <video className="thumb" src={url(`/assets/${a.id}/file`)} muted preload="metadata" /> : <img className="thumb" alt="" loading="lazy" src={url(`/assets/${a.id}/file`)} />}
            <div className="meta">
              <b className="clip">{a.name}</b>
              <div className="row gap wrap" style={{ marginTop: 6 }}><Pill tone={STATUS_TONE[a.approval_status]}>{a.approval_status}</Pill><Pill>{label(a.type)}</Pill>{a.scope === 'shared' && <Pill tone="info">shared</Pill>}</div>
              <div className="muted small clip" style={{ marginTop: 6 }}>{a.project_name ?? 'Shared library'}</div>
            </div>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={open.name} wide onClose={() => setOpen(null)}>
          <div className="grid g2">
            <div>{open.media_kind === 'video' ? <video className="frame" src={url(`/assets/${open.id}/file`)} controls muted /> : <img className="frame" alt={open.name} src={url(`/assets/${open.id}/file`)} />}</div>
            <dl className="kv">
              <dt>Status</dt><dd><Pill tone={STATUS_TONE[open.approval_status]}>{open.approval_status}</Pill></dd>
              <dt>Type</dt><dd>{label(open.type)}</dd>
              <dt>Size</dt><dd>{open.width}×{open.height} · {fmtBytes(open.bytes)}{open.duration_seconds ? ` · ${open.duration_seconds.toFixed(1)}s` : ''}</dd>
              <dt>Where</dt><dd>{open.project_id ? <a href={`#/p/${open.project_id}/visuals`}>{open.project_name ?? 'Video'}</a> : 'Shared library'}</dd>
              <dt>Source</dt><dd>{open.provider}{open.source_asset_id ? ' (reused from the shared library)' : ''}</dd>
              <dt>Licence</dt><dd>{label(open.license.type)}{open.license.commercial_use === 'no' ? ' · not for commercial use' : open.license.commercial_use === 'unknown' ? ' · commercial use unknown' : ''}</dd>
              {open.license.author && <><dt>Author</dt><dd>{open.license.author}</dd></>}
              {open.license.source_url && <><dt>Link</dt><dd><a href={open.license.source_url} target="_blank" rel="noopener noreferrer">{open.license.source_url.replace(/^https?:\/\//, '').slice(0, 50)}</a></dd></>}
              {open.license.attribution_text && <><dt>Credit</dt><dd>{open.license.attribution_text}</dd></>}
              {open.tags.length > 0 && <><dt>Tags</dt><dd>{open.tags.join(', ')}</dd></>}
              {open.prompt && <><dt>Prompt</dt><dd>{open.prompt}</dd></>}
            </dl>
          </div>
        </Modal>
      )}
    </div>
  );
}
