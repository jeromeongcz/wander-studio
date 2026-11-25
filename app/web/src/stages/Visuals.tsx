import { useState } from 'react';
import { api, url } from '../api';
import { ArtifactBar } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Empty, ErrorBox, Field, FilePick, Loading, Modal, Pill, Tabs, fmtBytes, useToast } from '../ui';
import { ASSET_TYPES } from '../types';

const LICENSES = [['own', 'My own work'], ['cc0', 'CC0 / public domain dedication'], ['public-domain', 'Public domain'], ['cc-by', 'CC BY'], ['cc-by-sa', 'CC BY-SA'], ['cc-by-nc', 'CC BY-NC'], ['cc-by-nd', 'CC BY-ND'], ['stock-licensed', 'Licensed stock'], ['ai-generated', 'AI generated'], ['other', 'Other'], ['unknown', 'Unknown (cannot be approved)']];
const tone = (s: string) => (s === 'approved' ? 'good' : s === 'rejected' ? 'bad' : 'warn');

export function VisualsStage() {
  const { project, all, reload } = useProject();
  const [tab, setTab] = useState<'scenes' | 'library' | 'stock' | 'shared'>('scenes');
  const assets = useAsync(() => api.get<any[]>(`/projects/${project.id}/assets`), [project.id]);
  const refresh = () => { assets.reload(); reload(); };
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'scenes', label: 'Scene visuals' }, { id: 'library', label: `Project assets${assets.data ? ` (${assets.data.length})` : ''}` }, { id: 'stock', label: 'Find stock' }, { id: 'shared', label: 'Shared library' }]} />
      {tab === 'scenes' && <SceneVisuals assets={assets.data ?? []} onChanged={refresh} sceneArts={all('scene_asset')} />}
      {tab === 'library' && <Library assets={assets.data} error={assets.error} onChanged={refresh} />}
      {tab === 'stock' && <Stock onImported={() => { refresh(); setTab('library'); }} />}
      {tab === 'shared' && <Shared onImported={() => { refresh(); setTab('library'); }} />}
    </>
  );
}

function SceneVisuals({ assets, onChanged, sceneArts }: { assets: any[]; onChanged: () => void; sceneArts: any[] }) {
  const { project, find } = useProject();
  const sb = find('storyboard')!;
  const doc = useAsync(() => api.get<any>(`/artifacts/${sb.id}`), [sb.id, sb.current_version_id]);
  const { push } = useToast();
  const [prompt, setPrompt] = useState<any>(null);
  const scenes: any[] = doc.data?.content?.scenes ?? [];
  if (doc.loading && !doc.data) return <Loading />;
  if (!scenes.length) return <Empty>Create and save the storyboard first. Each scene gets one visual slot here.</Empty>;
  return (
    <div className="stack">
      {sb.state !== 'approved' && <div className="notice warn">The storyboard is not approved yet, so scene visuals cannot be approved.</div>}
      {scenes.map((s, i) => {
        const art = sceneArts.find((a) => a.scene_id === s.scene_id);
        return <SceneRow key={s.scene_id} index={i} scene={s} art={art} assets={assets} onChanged={onChanged} onPrompt={async () => setPrompt(await api.get(`/scenes/${s.scene_id}/image-prompt`))} pid={project.id} push={push} />;
      })}
      {prompt && (
        <Modal title="Image prompt for any generator" wide onClose={() => setPrompt(null)}>
          <p className="muted small" style={{ marginTop: 0 }}>{prompt.instructions}</p>
          <div className="row gap" style={{ marginBottom: 8 }}><CopyBtn text={prompt.prompt} /><Pill>{prompt.aspect}</Pill></div>
          <pre>{prompt.prompt}</pre>
        </Modal>
      )}
    </div>
  );
}

function SceneRow({ index, scene, art, assets, onChanged, onPrompt, push }: any) {
  const doc = useAsync(() => (art ? api.get<any>(`/artifacts/${art.id}`) : Promise.resolve(null)), [art?.id, art?.current_version_id]);
  const primary = doc.data?.content?.primary_asset_id as string | undefined;
  const asset = assets.find((a: any) => a.id === primary);
  const usable = assets.filter((a: any) => a.approval_status !== 'rejected' && a.scope === 'project');
  const link = async (assetId: string) => {
    const call = (reopen: boolean) => api.put(`/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: assetId }], primary_asset_id: assetId, reopen });
    try { await call(false); } catch (e: any) {
      if (e.code === 'PROTECTED' && confirm('This scene visual is approved. Change it anyway?\n\nCompositions and renders using it will need revision.')) await call(true); else throw e;
    }
    push('ok', 'Visual linked');
    onChanged(); doc.reload();
  };
  return (
    <section className="card">
      <header className="card-h">
        <span className="scene-n">{index + 1}</span><h3>{scene.title}</h3><Pill>{scene.asset_type.replace(/_/g, ' ')}</Pill>
      </header>
      {art && <ArtifactBar artifact={art} onChanged={() => { onChanged(); doc.reload(); }} />}
      <div className="grid g2" style={{ marginTop: 10, gridTemplateColumns: 'minmax(180px, 260px) 1fr' }}>
        {asset ? <AssetMedia a={asset} /> : <div className="thumb" style={{ display: 'grid', placeItems: 'center' }}><span className="muted small">No visual yet</span></div>}
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>{scene.visual_description}</p>
          <Field label="Visual for this scene">
            <select value={primary ?? ''} onChange={(e) => e.target.value && link(e.target.value).catch((x) => push('error', x.message))}>
              <option value="">Choose an asset…</option>
              {usable.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.type.replace(/_/g, ' ')}, {a.approval_status})</option>)}
            </select>
          </Field>
          {asset && asset.approval_status !== 'approved' && <div className="notice warn small">This asset is {asset.approval_status}. Approve it in Project assets before the scene can be submitted.</div>}
          <div className="row gap"><Btn small onClick={onPrompt}>Image prompt for my own generator</Btn></div>
        </div>
      </div>
    </section>
  );
}

export function AssetMedia({ a }: { a: any }) {
  return a.media_kind === 'video' ? <video className="thumb" src={url(`/assets/${a.id}/file`)} muted loop playsInline controls /> : <img className="thumb" alt={a.name} src={url(`/assets/${a.id}/file`)} />;
}

function Library({ assets, error, onChanged }: { assets: any[] | null; error: Error | null; onChanged: () => void }) {
  const { project } = useProject();
  const { push } = useToast();
  const [type, setType] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<{ path: string; name: string } | null>(null);
  if (error) return <ErrorBox error={error} retry={onChanged} />;
  if (!assets) return <Loading />;
  const list = assets.filter((a) => !type || a.type === type);
  return (
    <div className="stack">
      <div className="row gap wrap">
        <FilePick accept="image/*,video/mp4,video/quicktime,video/webm" label="Import image or video…" onFile={async (f) => { const u = await api.upload(f); setPending({ path: u.path, name: f.name }); }} />
        <select style={{ width: 180 }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type"><option value="">All types</option>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
        <span className="muted small">Files are copied into the project and checked with ffprobe; your originals are never changed.</span>
      </div>
      {list.length === 0 ? <Empty>No assets yet. Import your own images or footage, find openly licensed stock, or use the image prompt in a scene to make one elsewhere.</Empty> : (
        <div className="grid g3">
          {list.map((a) => (
            <div key={a.id} className="asset" onClick={() => setOpen(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(a.id)}>
              <AssetMedia a={a} />
              <div className="meta">
                <div className="row gap"><strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</strong><span className="grow" /><Pill tone={tone(a.approval_status)}>{a.approval_status}</Pill></div>
                <div className="muted small">{a.type.replace(/_/g, ' ')} · {a.width}×{a.height} · {a.license.type}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {pending && <ImportForm file={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); push('ok', 'Imported'); onChanged(); }} pid={project.id} />}
      {open && <AssetDetail id={open} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </div>
  );
}

function LicenseFields({ v, set }: { v: any; set: (x: any) => void }) {
  const needsAttr = String(v.type).startsWith('cc-by');
  return (
    <div className="form">
      <Field label="License"><select value={v.type} onChange={(e) => set({ ...v, type: e.target.value })}>{LICENSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Commercial use"><select value={v.commercial_use} onChange={(e) => set({ ...v, commercial_use: e.target.value })}><option value="yes">Allowed</option><option value="no">Not allowed</option><option value="unknown">Not sure</option></select></Field>
      <Field label={`Attribution text${needsAttr ? ' (required)' : ''}`} wide><input value={v.attribution_text ?? ''} onChange={(e) => set({ ...v, attribution_text: e.target.value })} placeholder='"Title" by Author, CC BY 4.0' /></Field>
      <Field label="Source link or license notes" wide><input value={v.source_url ?? v.notes ?? ''} onChange={(e) => set({ ...v, source_url: e.target.value })} placeholder="Where it came from" /></Field>
    </div>
  );
}

function ImportForm({ file, onClose, onDone, pid }: { file: { path: string; name: string }; onClose: () => void; onDone: () => void; pid: string }) {
  const [type, setType] = useState('stock_photo');
  const [license, setLicense] = useState<any>({ type: 'own', commercial_use: 'yes' });
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, ''));
  return (
    <Modal title={`Import ${file.name}`} onClose={onClose}>
      <div className="stack">
        <div className="form">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="What it is"><select value={type} onChange={(e) => setType(e.target.value)}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
        </div>
        <LicenseFields v={license} set={setLicense} />
        <div className="row gap"><Btn kind="primary" onClick={async () => { await api.post(`/projects/${pid}/assets/import`, { path: file.path, type, name, license }); onDone(); }}>Import</Btn><Btn kind="ghost" onClick={onClose}>Cancel</Btn></div>
      </div>
    </Modal>
  );
}

function AssetDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { push } = useToast();
  const d = useAsync(() => api.get<any>(`/assets/${id}`), [id]);
  const [license, setLicense] = useState<any>(null);
  const a = d.data;
  if (!a) return <Modal title="Asset" onClose={onClose}><Loading /></Modal>;
  const lic = license ?? a.license;
  const act = (fn: () => Promise<any>, ok: string) => async () => {
    try { const r = await fn(); if (r?.warnings?.length) push('warn', ok, r.warnings); else push('ok', ok); d.reload(); onChanged(); } catch (e: any) { if (e.code === 'PROTECTED') { push('warn', e.message); } else throw e; }
  };
  const patch = (body: any, reopenMsg = true) => async () => {
    try { return await api.patch(`/assets/${id}`, body); } catch (e: any) {
      if (e.code === 'PROTECTED' && reopenMsg && confirm(`${e.message}\n\nContinue? Scenes using this asset will need revision.`)) return api.patch(`/assets/${id}`, { ...body, reopen: true });
      throw e;
    }
  };
  return (
    <Modal title={a.name} wide onClose={onClose}>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Click the picture to set the focal point. When the same visual is cropped to 9:16, 16:9 or 1:1, the focal point stays in frame.</p>
          <div className="focal" onClick={async (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const focal = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
            await act(patch({ focal }), 'Focal point set')();
          }}>
            {a.media_kind === 'video' ? <video src={url(`/assets/${a.id}/file`)} muted controls /> : <img alt={a.name} src={url(`/assets/${a.id}/file`)} />}
            <div className="pt" style={{ left: `${a.focal.x * 100}%`, top: `${a.focal.y * 100}%` }} />
          </div>
          <div className="muted small">{a.width}×{a.height} · {fmtBytes(a.bytes)}{a.duration_seconds ? ` · ${a.duration_seconds.toFixed(1)}s` : ''} · via {a.provider}{a.source_asset_id ? ' · reused from the shared library' : ''}</div>
          {a.used_by.length > 0 && <div className="small">Used by: {a.used_by.map((u: any) => u.label).join(', ')}</div>}
        </div>
        <div className="stack">
          <div className="row gap"><Pill tone={tone(a.approval_status)}>{a.approval_status}</Pill><span className="grow" />
            <Btn small kind="primary" disabled={a.approval_status === 'approved'} onClick={act(() => api.post(`/assets/${id}/approve`), 'Asset approved')}>Approve</Btn>
            <Btn small kind="danger" disabled={a.approval_status === 'rejected'} onClick={act(() => api.post(`/assets/${id}/reject`), 'Asset rejected')}>Reject</Btn></div>
          <Field label="Type"><select value={a.type} onChange={(e) => act(patch({ type: e.target.value }), 'Type changed')()}>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field>
          <LicenseFields v={lic} set={setLicense} />
          {license && <Btn onClick={act(patch({ license }), 'License saved')}>Save license</Btn>}
          <div className="row gap wrap">
            <Btn small disabled={a.approval_status !== 'approved' || a.scope !== 'project'} title="Make a copy available to your other projects" onClick={act(() => api.post(`/assets/${id}/promote`), 'Added to the shared library')}>Add to shared library</Btn>
            <Btn small kind="danger" disabled={a.used_by.length > 0} title={a.used_by.length ? 'Unlink it from scenes first' : ''} onClick={async () => { if (!confirm('Delete this asset and its file?')) return; await api.del(`/assets/${id}`); push('ok', 'Deleted'); onClose(); onChanged(); }}>Delete</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Stock({ onImported }: { onImported: () => void }) {
  const { project } = useProject();
  const { push } = useToast();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState('stock_photo');
  const providers = useAsync(() => api.get<any[]>('/providers'), []);
  const ov = providers.data?.find((p) => p.id === 'openverse');
  return (
    <div className="stack">
      {ov && <div className="notice"><strong>{ov.name}</strong>: {ov.terms.freeTier}. {ov.terms.privacy} Searches default to licenses that allow commercial use and modification; always check attribution.</div>}
      <form className="row gap wrap" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { setRes(await api.get(`/providers/openverse/search?q=${encodeURIComponent(q)}`)); } catch (x: any) { push('error', x.message); } finally { setBusy(false); } }}>
        <input style={{ maxWidth: 360 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search openly licensed images" aria-label="Search" />
        <select style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Import as">{['stock_photo', 'illustration', 'background', 'map', 'infographic'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
        <Btn type="submit" kind="primary" busy={busy} disabled={!q.trim()}>Search</Btn>
      </form>
      {res && res.length === 0 && <Empty>No results.</Empty>}
      <div className="grid g3">
        {(res ?? []).map((r) => (
          <div key={r.id} className="asset" style={{ cursor: 'default' }}>
            {r.thumbnail_url && <img className="thumb" alt={r.title} src={r.thumbnail_url} referrerPolicy="no-referrer" />}
            <div className="meta stack">
              <div><strong className="small">{r.title || 'Untitled'}</strong><div className="muted small">{r.creator ? `by ${r.creator}` : ''}</div></div>
              <div className="row gap wrap"><Pill tone={r.license.commercial_use === 'yes' ? 'good' : 'warn'}>{r.license.type}</Pill>{r.license.derivatives_allowed === false && <Pill tone="warn">no derivatives</Pill>}</div>
              <Btn small onClick={async () => { await api.post(`/projects/${project.id}/assets/import-remote`, { provider: 'openverse', result_id: r.id, type }); push('ok', 'Downloaded and checked. Review its license, then approve it.'); onImported(); }}>Import</Btn>
            </div>
          </div>
        ))}
      </div>
      <p className="muted small">Search results' thumbnails load straight from the image hosts. The full image is only downloaded when you click Import.</p>
    </div>
  );
}

function Shared({ onImported }: { onImported: () => void }) {
  const { project } = useProject();
  const { push } = useToast();
  const lib = useAsync(() => api.get<any[]>('/library'), []);
  if (!lib.data) return <Loading />;
  if (!lib.data.length) return <Empty>The shared library is empty. Approve an asset, open it, and choose “Add to shared library” to reuse it in other projects without regenerating it.</Empty>;
  return (
    <div className="grid g3">
      {lib.data.map((a) => (
        <div key={a.id} className="asset" style={{ cursor: 'default' }}>
          <AssetMedia a={a} />
          <div className="meta stack"><strong className="small">{a.name}</strong><div className="muted small">{a.type.replace(/_/g, ' ')} · {a.license.type}</div>
            <Btn small onClick={async () => { await api.post(`/projects/${project.id}/assets/reuse`, { asset_id: a.id }); push('ok', 'Copied into this project'); onImported(); }}>Use in this project</Btn></div>
        </div>
      ))}
    </div>
  );
}
