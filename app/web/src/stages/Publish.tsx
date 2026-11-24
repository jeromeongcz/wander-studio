import { useEffect, useState } from 'react';
import { api, url } from '../api';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Loading, Pill, Tabs, fmtBytes, useToast } from '../ui';
import { langName } from '../types';

export function PublishStage() {
  const { project } = useProject();
  const [lang, setLang] = useState(project.languages[0]);
  return (
    <>
      <Tabs value={lang} onChange={setLang} items={project.languages.map((l) => ({ id: l, label: langName(l) }))} />
      <Thumbnails key={`t${lang}`} lang={lang} />
      <Kit key={`k${lang}`} lang={lang} />
      <Licenses />
      <ExportPanel />
    </>
  );
}

function Thumbnails({ lang }: { lang: string }) {
  const { project, find } = useProject();
  const { push } = useToast();
  const list = useAsync(() => api.get<any[]>(`/projects/${project.id}/thumbnails?lang=${lang}`), [lang]);
  const sb = find('storyboard')!;
  const sbDoc = useAsync(() => api.get<any>(`/artifacts/${sb.id}`), [sb.id, sb.current_version_id]);
  const scenes: any[] = sbDoc.data?.content?.scenes ?? [];
  const [scene, setScene] = useState('');
  const [text, setText] = useState('');
  const [size, setSize] = useState('1280x720');
  useEffect(() => { if (!scene && scenes[0]) setScene(scenes[0].scene_id); }, [scenes, scene]);
  return (
    <Card title="Thumbnail">
      {scenes.length === 0 ? <Empty>Create the storyboard and link visuals first; the thumbnail is cut from a scene's visual.</Empty> : (
        <div className="stack">
          <div className="form">
            <Field label="Picture from scene"><select value={scene} onChange={(e) => setScene(e.target.value)}>{scenes.map((s, i) => <option key={s.scene_id} value={s.scene_id}>{i + 1}. {s.title}</option>)}</select></Field>
            <Field label="Text on the thumbnail" hint="Short and bold works best (up to 60 characters)"><input value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="THREE HEARTS?!" /></Field>
            <Field label="Size"><select value={size} onChange={(e) => setSize(e.target.value)}><option value="1280x720">1280×720 (standard)</option><option value="1920x1080">1920×1080</option><option value="1080x1920">1080×1920 (vertical)</option></select></Field>
          </div>
          <div><Btn kind="primary" disabled={!scene} onClick={async () => { await api.post(`/projects/${project.id}/thumbnails`, { lang, scene_id: scene, text, size }); push('ok', 'Thumbnail created'); list.reload(); }}>Create thumbnail</Btn></div>
          {(list.data ?? []).length > 0 && (
            <div className="grid g3">
              {list.data!.map((t) => (
                <div key={t.id} className="asset" style={{ cursor: 'default' }}>
                  <img className="thumb" alt="Thumbnail" src={url(`/thumbnails/${t.id}/file`)} style={{ aspectRatio: `${t.width} / ${t.height}`, objectFit: 'contain' }} />
                  <div className="meta muted small">{t.width}×{t.height} · {fmtBytes(t.bytes)}{t.text ? ` · “${t.text}”` : ''}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Kit({ lang }: { lang: string }) {
  const { project } = useProject();
  const { push } = useToast();
  const kit = useAsync(() => api.get<any>(`/projects/${project.id}/kit/${lang}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))), [lang]);
  const [k, setK] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => { setK(kit.data?.content ?? null); setDirty(false); }, [kit.data]);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const edit = (p: any) => { setK({ ...k, ...p, generated_by: 'manual' }); setDirty(true); };
  return (
    <Card title="Publishing kit" actions={<>
      <Btn small onClick={async () => setPrompt((await api.get(`/projects/${project.id}/kit/${lang}/prompt`)).prompt)}>Prompt for my own AI</Btn>
      <Btn small kind="primary" onClick={async () => { if (k && !confirm('Replace the current kit with a fresh draft?')) return; await api.post(`/projects/${project.id}/kit/${lang}/generate`); push('ok', 'Draft generated from your script'); kit.reload(); }}>{k ? 'Regenerate draft' : 'Generate draft'}</Btn>
    </>}>
      {kit.loading && !kit.data && !k && <Loading />}
      {!k && !kit.loading && <Empty>Generate a draft of titles, description, tags, hashtags and comment ideas from your {langName(lang)} script. It uses only what the script says. Edit everything before you publish.</Empty>}
      {k && (
        <div className="stack">
          {k.notes?.map((n: string) => <div key={n} className="notice small">{n}</div>)}
          <Field label="Title options (one per line)" hint={`${k.title_options.length} options; YouTube allows up to 100 characters`}><textarea value={k.title_options.join('\n')} onChange={(e) => edit({ title_options: lines(e.target.value) })} /></Field>
          <Field label="Description" hint={`${k.description.length}/5000`}><textarea style={{ minHeight: 160 }} value={k.description} onChange={(e) => edit({ description: e.target.value })} /></Field>
          <div className="form">
            <Field label="Tags (comma separated)" hint={`${k.tags.join(',').length}/500 characters`}><input value={k.tags.join(', ')} onChange={(e) => edit({ tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
            <Field label="Hashtags (space separated)"><input value={k.hashtags.join(' ')} onChange={(e) => edit({ hashtags: e.target.value.split(/\s+/).filter(Boolean) })} /></Field>
            <Field label="Thumbnail text ideas (one per line)"><textarea value={k.thumbnail_hooks.join('\n')} onChange={(e) => edit({ thumbnail_hooks: lines(e.target.value) })} /></Field>
            <Field label="Pinned comment ideas (one per line)"><textarea value={k.pinned_comment_ideas.join('\n')} onChange={(e) => edit({ pinned_comment_ideas: lines(e.target.value) })} /></Field>
          </div>
          {k.chapters.length > 0 && <Field label="Chapters"><pre>{k.chapters.map((c: any) => `${Math.floor(c.t / 60)}:${String(c.t % 60).padStart(2, '0')} ${c.label}`).join('\n')}</pre></Field>}
          <div className="row gap"><Btn kind="primary" disabled={!dirty} onClick={async () => { await api.put(`/projects/${project.id}/kit/${lang}`, { content: k }); push('ok', 'Kit saved'); kit.reload(); }}>Save kit</Btn><CopyBtn text={`${k.title_options[0] ?? ''}\n\n${k.description}`} label="Copy title + description" /></div>
        </div>
      )}
      {prompt && <div className="stack" style={{ marginTop: 12 }}><div className="row gap"><h4>Prompt</h4><CopyBtn text={prompt} /><Btn small kind="ghost" onClick={() => setPrompt(null)}>Hide</Btn></div><pre>{prompt}</pre></div>}
    </Card>
  );
}

function Licenses() {
  const { project } = useProject();
  const man = useAsync(() => api.get<any>(`/projects/${project.id}/license-manifest`), [project.id]);
  if (!man.data) return <Loading />;
  const m = man.data;
  return (
    <Card title="Licenses and credits" actions={<><Btn small onClick={man.reload}>Refresh</Btn><CopyBtn text={m.credits_text} label="Copy credits" /></>}>
      {m.warnings.length > 0 && <div className="notice warn" style={{ marginBottom: 10 }}><strong>Resolve before publishing:</strong><ul>{m.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}
      {m.items.length === 0 ? <Empty>Nothing licensed is used yet. Visuals, narration, music and fonts appear here as you add them.</Empty> : (
        <table>
          <thead><tr><th>Item</th><th>Source</th><th>License</th><th>Used in</th></tr></thead>
          <tbody>{m.items.map((i: any) => <tr key={`${i.kind}${i.id}`}><td><Pill>{i.kind}</Pill> {i.name}</td><td className="small">{i.provider}</td><td className="small">{i.license ? `${i.license.type}${i.license.commercial_use === 'no' ? ' (non-commercial)' : ''}` : '—'}</td><td className="small muted">{i.used_in.join(', ')}</td></tr>)}</tbody>
        </table>
      )}
      {m.attribution_lines.length > 0 && <><h4 style={{ margin: '14px 0 6px' }}>Attribution to include in your description</h4><pre>{m.attribution_lines.join('\n')}</pre></>}
    </Card>
  );
}

function ExportPanel() {
  const { project } = useProject();
  const { push } = useToast();
  const [langs, setLangs] = useState<string[]>(project.languages);
  const [variants, setVariants] = useState<string[]>(['captioned', 'clean']);
  const [archive, setArchive] = useState(true);
  const [res, setRes] = useState<any>(null);
  const [arch, setArch] = useState<any>(null);
  const [restorePath, setRestorePath] = useState('');
  const toggle = (a: string[], v: string, set: (x: string[]) => void) => set(a.includes(v) ? a.filter((x) => x !== v) : [...a, v]);
  return (
    <>
      <Card title="Export package">
        <p className="muted small" style={{ marginTop: 0 }}>Collects approved masters (each re-checked against its recorded fingerprint), subtitles, thumbnail, publishing kit and the license manifest into one folder. This app never uploads anything: you review the files locally and publish yourself.</p>
        <div className="row gap wrap">
          {project.languages.map((l) => <label key={l} className="row gap"><input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(langs, l, setLangs)} />{langName(l)}</label>)}
          <span className="muted">|</span>
          {['captioned', 'clean'].map((v) => <label key={v} className="row gap"><input type="checkbox" checked={variants.includes(v)} onChange={() => toggle(variants, v, setVariants)} />{v === 'captioned' ? 'With captions' : 'Clean'}</label>)}
          <span className="muted">|</span>
          <label className="row gap"><input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} />Include project archive (.zip)</label>
        </div>
        <div style={{ marginTop: 12 }}><Btn kind="primary" disabled={!langs.length || !variants.length} onClick={async () => { setRes(await api.post(`/projects/${project.id}/export`, { langs, variants, archive })); push('ok', 'Export package created'); }}>Create export package</Btn></div>
        {res && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="notice"><strong>Created:</strong> <span className="mono">{res.dir}</span></div>
            <table><tbody>{res.files.map((f: any) => <tr key={f.path}><td className="mono">{f.path}</td><td className="small muted">{fmtBytes(f.bytes)}</td></tr>)}</tbody></table>
            {res.skipped.length > 0 && <div className="notice warn"><strong>Not included:</strong><ul>{res.skipped.map((s: any) => <li key={s.item}>{s.item}: {s.reason}</li>)}</ul></div>}
            {res.warnings.length > 0 && <div className="notice warn"><strong>Licensing warnings:</strong><ul>{res.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}
          </div>
        )}
      </Card>
      <Card title="Backup and restore">
        <div className="stack">
          <div className="row gap wrap"><Btn onClick={async () => { setArch(await api.post(`/projects/${project.id}/archive`)); }}>Create project archive</Btn>{arch && <span className="small">Saved <span className="mono">{arch.path}</span> ({fmtBytes(arch.bytes)}, {arch.files} files) <CopyBtn text={arch.path} label="Copy path" /></span>}</div>
          <div className="row gap wrap">
            <input style={{ maxWidth: 460 }} placeholder="Path to a .wander.zip archive" value={restorePath} onChange={(e) => setRestorePath(e.target.value)} aria-label="Archive path" />
            <Btn disabled={!restorePath.trim()} onClick={async () => { const r = await api.post('/archive/restore', { path: restorePath.trim(), as_copy: true }); push('ok', 'Restored as a new project'); location.hash = `#/p/${r.projectId}/overview`; }}>Restore as a new copy</Btn>
          </div>
          <p className="muted small" style={{ margin: 0 }}>Archives carry every file with a checksum; a damaged or altered archive is refused and nothing is changed. Restoring always makes a separate copy so your current project is never overwritten.</p>
        </div>
      </Card>
    </>
  );
}
