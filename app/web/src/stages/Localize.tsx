import { useEffect, useState } from 'react';
import { api } from '../api';
import { ArtifactBar, saveArtifact } from '../actions';
import { useProject } from '../pages/Project';
import { useAsync } from '../hooks';
import { Btn, Card, CopyBtn, Empty, Field, Loading, Modal, Pill, Tabs, useToast } from '../ui';
import { EstimateBar, SectionsEditor } from './shared';
import type { Section } from './shared';
import { langName } from '../types';

export function LocalizeStage() {
  const { project, reload } = useProject();
  const [lang, setLang] = useState(project.languages[0]);
  const { push } = useToast();
  const locales = useAsync(() => api.get<any[]>('/locales'), []);
  const addable = (locales.data ?? []).filter((l) => !project.languages.includes(l.code));
  const [adding, setAdding] = useState('');
  return (
    <>
      <Tabs value={lang} onChange={setLang} items={project.languages.map((l) => ({ id: l, label: langName(l) }))} />
      <LangEditor key={lang} lang={lang} />
      <Card title="Languages in this project">
        <p className="muted small" style={{ marginTop: 0 }}>Each language has its own script, voice, captions, approvals and renders. Adding one never disturbs the others. A language can only be removed while none of its work is approved.</p>
        <div className="row gap wrap">
          <select style={{ width: 200 }} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Language to add"><option value="">Add a language…</option>{addable.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
          <Btn disabled={!adding} onClick={async () => { await api.post(`/projects/${project.id}/languages`, { lang: adding }); push('ok', 'Language added'); setAdding(''); reload(); }}>Add</Btn>
          <Btn kind="danger" onClick={async () => {
            if (!confirm(`Remove ${langName(lang)} and everything made for it?`)) return;
            await api.del(`/projects/${project.id}/languages/${lang}`);
            push('ok', 'Language removed');
            setLang(project.languages.find((l) => l !== lang) ?? project.languages[0]);
            reload();
          }} disabled={project.languages.length < 2}>Remove {langName(lang)}</Btn>
        </div>
      </Card>
    </>
  );
}

function LangEditor({ lang }: { lang: string }) {
  const { project, find, reload } = useProject();
  const art = find('script_lang', lang)!;
  const base = find('script_base')!;
  const { push } = useToast();
  const loaded = useAsync(() => api.get<any>(`/artifacts/${art.id}`), [art.id, art.current_version_id]);
  const lexicon = useAsync(() => api.get<any[]>(`/projects/${project.id}/lexicon/${lang}`), [lang]);
  const [c, setC] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<'edit' | 'compare'>('edit');
  const [cmp, setCmp] = useState<any>(null);
  const [mix, setMix] = useState<any>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [resp, setResp] = useState('');
  useEffect(() => { if (loaded.data) { setC(loaded.data.content); setDirty(false); } }, [loaded.data]);
  useEffect(() => {
    setCmp(null); setMix(null);
    if (!art.current_version_id) return;
    api.get(`/artifacts/${art.id}/language-mix`).then(setMix).catch(() => {});
    if (base.current_version_id) api.get(`/artifacts/${art.id}/compare`).then(setCmp).catch(() => {});
  }, [art.id, art.current_version_id, base.current_version_id]);
  const done = () => { reload(); loaded.reload(); };
  if (loaded.loading && !loaded.data) return <Loading />;

  if (!c) {
    return (
      <>
        <ArtifactBar artifact={art} onChanged={done} />
        <Card title={`${langName(lang)} script`}>
          <p style={{ marginTop: 0 }}>This version is adapted from the base script. It should sound natural when spoken, not read like a translation: idioms, rhythm and calls to action are adapted, while facts, numbers and names stay the same.</p>
          {base.state !== 'approved' && <div className="notice warn" style={{ marginBottom: 10 }}>Approve the base script first, so every language starts from the same approved facts.</div>}
          <div className="row gap wrap">
            <Btn kind="primary" disabled={base.state !== 'approved'} onClick={async () => { await api.post(`/artifacts/${art.id}/seed-from-base`); push('ok', 'Draft created from the base script'); done(); }}>Create draft from base script</Btn>
            <Btn disabled={!base.current_version_id} onClick={async () => setPrompt((await api.get(`/artifacts/${art.id}/adaptation-prompt`)).prompt)}>Get adaptation prompt for my own AI</Btn>
          </div>
          <p className="muted small">The prompt is plain text you can paste into any assistant you already use. Paste its answer back into the draft by hand: nothing is sent anywhere from here.</p>
        </Card>
        {prompt && <Modal title="Adaptation prompt" wide onClose={() => setPrompt(null)}><div className="row gap" style={{ marginBottom: 8 }}><CopyBtn text={prompt} /></div><pre>{prompt}</pre></Modal>}
      </>
    );
  }

  const edit = (patch: any) => { setC({ ...c, ...patch }); setDirty(true); };
  const save = async () => {
    const r = await saveArtifact(art.id, c);
    push('ok', r.changed ? 'Saved' : 'No changes to save');
    done();
  };
  return (
    <>
      <ArtifactBar artifact={art} onChanged={done}>{dirty && <Pill tone="warn">unsaved</Pill>}</ArtifactBar>
      {cmp?.stale && <div className="notice warn">The base script changed after this was adapted. Use Compare to check what moved.</div>}
      {mix?.warnings?.map((w: string) => <div key={w} className="notice warn">{w}</div>)}
      <div className="row gap wrap">
        <Tabs value={view} onChange={setView} items={[{ id: 'edit', label: 'Edit' }, { id: 'compare', label: 'Compare with base' }]} />
        <span className="grow" />
        <Btn small onClick={async () => setPrompt((await api.get(`/artifacts/${art.id}/adaptation-prompt`)).prompt)}>Adaptation prompt</Btn>
      </div>
      {view === 'edit' ? (
        <>
          <EstimateBar sections={c.sections} lang={lang} preset={c.preset} target={c.target_seconds} />
          <SectionsEditor sections={c.sections as Section[]} onChange={(sections) => edit({ sections })} withTts lockKinds />
          <div className="row gap"><Btn kind="primary" onClick={save} disabled={!dirty}>Save {langName(lang)} script</Btn></div>
        </>
      ) : (
        <Card title="Base vs this language">
          {!cmp ? <Loading /> : (
            <table>
              <thead><tr><th>Section</th><th>Base ({langName(cmp.baseLang)})</th><th>{langName(lang)}</th><th>Words</th></tr></thead>
              <tbody>
                {cmp.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td><Pill tone={r.status === 'ok' ? 'neutral' : 'bad'}>{r.kind}{r.status !== 'ok' ? ` · ${r.status}` : ''}</Pill></td>
                    <td className="small">{r.base_text}</td>
                    <td className="small">{r.lang_text}</td>
                    <td className="small muted">{r.base_words} → {r.lang_words}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      <Card title="Pronunciation">
        <p className="muted small" style={{ marginTop: 0 }}>Respellings change only how the voice reads a word. Captions keep your approved spelling. Changing one marks this language's narration as needing revision.</p>
        {(lexicon.data ?? []).length === 0 ? <Empty>No pronunciation overrides.</Empty> : (
          <table><tbody>{lexicon.data!.map((e) => <tr key={e.id}><td><strong>{e.term}</strong></td><td>→ {e.respelling}</td><td><Btn small kind="ghost" onClick={async () => { const r = await api.del(`/lexicon/${e.id}`); if (r.invalidated?.length) push('warn', 'Narration for this language needs revision'); lexicon.reload(); reload(); }}>Remove</Btn></td></tr>)}</tbody></table>
        )}
        <div className="row gap wrap" style={{ marginTop: 10 }}>
          <input style={{ width: 180 }} aria-label="Word" placeholder="Word" value={term} onChange={(e) => setTerm(e.target.value)} />
          <input style={{ width: 220 }} aria-label="Respelling" placeholder="How it should sound" value={resp} onChange={(e) => setResp(e.target.value)} />
          <Btn disabled={!term.trim() || !resp.trim()} onClick={async () => { const r = await api.put(`/projects/${project.id}/lexicon/${lang}`, { term, respelling: resp }); if (r.invalidated?.length) push('warn', 'Narration for this language needs revision'); setTerm(''); setResp(''); lexicon.reload(); reload(); }}>Add</Btn>
        </div>
      </Card>
      {prompt && <Modal title="Adaptation prompt" wide onClose={() => setPrompt(null)}><div className="row gap" style={{ marginBottom: 8 }}><CopyBtn text={prompt} /></div><pre>{prompt}</pre></Modal>}
    </>
  );
}
