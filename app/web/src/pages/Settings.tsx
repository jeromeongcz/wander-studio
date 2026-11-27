import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Icon, Loading, Modal, Pill, Tabs, fmtBytes, useToast } from '../ui';

/** A small catalogue of popular Ollama models to pick from when downloading. Sizes are approximate. */
const OLLAMA_LIBRARY: { id: string; label: string; params: string; size: string; desc: string }[] = [
  { id: 'llama3.2', label: 'Llama 3.2', params: '3B', size: '~2.0 GB', desc: 'Fast, capable general chat and writing model. Good default for scripts and storyboards.' },
  { id: 'llama3.2:1b', label: 'Llama 3.2 (1B)', params: '1B', size: '~1.3 GB', desc: 'Smallest and fastest. Lower quality; useful on low-memory machines.' },
  { id: 'llama3.1', label: 'Llama 3.1', params: '8B', size: '~4.7 GB', desc: 'Stronger reasoning and longer context than 3.2. Needs more RAM.' },
  { id: 'qwen2.5', label: 'Qwen 2.5', params: '7B', size: '~4.7 GB', desc: 'Excellent multilingual model; strong at Chinese and other languages.' },
  { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', params: '7B', size: '~4.7 GB', desc: 'Specialised for code. Not ideal for narrative scripts.' },
  { id: 'mistral', label: 'Mistral', params: '7B', size: '~4.1 GB', desc: 'Well-rounded open model, good at concise writing.' },
  { id: 'gemma2', label: 'Gemma 2', params: '9B', size: '~5.4 GB', desc: 'Google model with strong writing quality; heavier on memory.' },
  { id: 'phi3', label: 'Phi-3', params: '3.8B', size: '~2.3 GB', desc: 'Compact Microsoft model; decent quality for its size.' },
  { id: 'deepseek-r1', label: 'DeepSeek R1', params: '8B', size: '~4.9 GB', desc: 'Reasoning-focused model that shows its thinking. Slower.' },
  { id: 'llava', label: 'LLaVA', params: '7B', size: '~4.1 GB', desc: 'Vision model: can look at images. Not needed for text-only storyboards.' },
  { id: 'codellama', label: 'Code Llama', params: '7B', size: '~3.8 GB', desc: 'Code-specialised Llama variant.' },
  { id: 'nomic-embed-text', label: 'Nomic Embed', params: '137M', size: '~274 MB', desc: 'Embedding model for search/RAG. Not a chat model.' },
];

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
  const llmProviders = useAsync(() => api.get<any[]>('/llm/providers'), []);
  const activeLLM = useAsync(() => api.get<any>('/llm/active'), []);
  const templates = useAsync(() => api.get<any[]>('/templates'), []);
  useInterval(jobs.reload, 2500);

  // Ollama process status
  const [ollamaStatus, setOllamaStatus] = useState<{ running: boolean; installed: boolean; pid?: number } | null>(null);

  const checkOllamaStatus = async () => {
    try {
      const s = await api.get<{ running: boolean; installed: boolean; pid?: number; health?: any }>('/llm/providers/ollama/status');
      setOllamaStatus({ running: s.running, installed: s.installed, pid: s.pid });
    } catch { setOllamaStatus({ running: false, installed: false }); }
  };

  const startOllama = async () => {
    try {
      const s = await api.post<{ running: boolean; pid?: number; warning?: string }>('/llm/providers/ollama/start');
      setOllamaStatus({ running: s.running, installed: true, pid: s.pid });
      await llmProviders.reload();
      await activeLLM.reload();
      push('ok', 'Ollama started');
    } catch (e) {
      push('error', `Start failed: ${(e as Error).message}`);
    }
  };

  const stopOllama = async () => {
    try {
      await api.post('/llm/providers/ollama/stop');
      setOllamaStatus({ running: false, installed: true });
      await llmProviders.reload();
      push('ok', 'Ollama stopped');
    } catch (e) {
      push('error', `Stop failed: ${(e as Error).message}`);
    }
  };

  const signInClaude = async () => {
    try {
      await api.post('/llm/providers/claude/signin');
      await llmProviders.reload();
      await activeLLM.reload();
      push('ok', 'Claude Code sign-in started');
    } catch (e) {
      push('error', `Sign in failed: ${(e as Error).message}`);
    }
  };

  const installOllama = async () => {
    try {
      const s = await api.post<{ installed: boolean }>('/llm/providers/ollama/install');
      setOllamaStatus({ running: false, installed: s.installed });
      await llmProviders.reload();
      await activeLLM.reload();
      push('ok', 'Ollama installed');
    } catch (e) {
      push('error', `Install failed: ${(e as Error).message}`);
    }
  };

  // Live health polling for the active provider (every 30s)
  useInterval(async () => {
    const active = activeLLM.data?.active;
    if (!active) return;
    try {
      await api.post(`/llm/providers/${active}/health`);
      activeLLM.reload();
      llmProviders.reload();
    } catch { /* silent: health poll failures are shown in the card */ }
    try {
      await checkOllamaStatus();
    } catch { /* silent */ }
  }, 30000);

  // Initial ollama status check
  checkOllamaStatus();

  const [loc, setLoc] = useState({ code: '', name: '', bcp47: '', default_wpm: 140 });
  const [tab, setTab] = useState<'jobs' | 'system' | 'voices' | 'languages' | 'providers' | 'templates' | 'ai-provider'>('ai-provider');
  const [sel, setSel] = useState<string[]>([]);

  // AI Provider state
  const [ollamaModels, setOllamaModels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(activeLLM.data?.selectedModel ?? null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalProvider, setModalProvider] = useState<{ id: string; name: string } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [ollamaHostInput, setOllamaHostInput] = useState(activeLLM.data?.active === 'ollama' ? '' : '');
  const [apiBaseUrlInput, setApiBaseUrlInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiModelInput, setApiModelInput] = useState(activeLLM.data?.selectedModel ?? '');
  const [defaultToFreeFirst, setDefaultToFreeFirst] = useState(activeLLM.data?.defaultToFreeFirst ?? false);
  const [fallbackProviderId, setFallbackProviderId] = useState(activeLLM.data?.fallback ?? null);

  // OpenRouter free models state
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([]);
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [openRouterModelInput, setOpenRouterModelInput] = useState('');
  const [savingOpenRouter, setSavingOpenRouter] = useState(false);
  const [fetchingOpenRouterModels, setFetchingOpenRouterModels] = useState(false);
  const [openRouterKeySaved, setOpenRouterKeySaved] = useState(false);

  // Load saved provider config so fields (API keys, hosts, model) survive a refresh
  useEffect(() => {
    let cancelled = false;
    api.get<any>('/llm/config').then((c) => {
      if (cancelled) return;
      if (c.ollamaHost) setOllamaHostInput(c.ollamaHost);
      if (c.openaiCompatible) {
        setApiBaseUrlInput(c.openaiCompatible.baseUrl || '');
        setApiKeyInput(c.openaiCompatible.apiKey || '');
        setApiModelInput(c.openaiCompatible.model || '');
      }
      if (c.openrouter) {
        setOpenRouterApiKey(c.openrouter.apiKey || '');
        setOpenRouterModelInput(c.openrouter.model || c.selectedModel || '');
        if (c.openrouter.apiKey) setOpenRouterKeySaved(true);
      }
      if (c.selectedModel) setSelectedModel(c.selectedModel);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const loadOpenRouterModels = async () => {
    try {
      const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/openrouter/models');
      setOpenRouterModels(models);
    } catch { /* openrouter not configured yet */ }
  };

  // Auto-load the fetched OpenRouter models once the saved key is available (so they survive a refresh)
  useEffect(() => {
    if (openRouterApiKey.trim() && openRouterModels.length === 0) loadOpenRouterModels();
  }, [openRouterApiKey]);

  // Persist the chosen OpenRouter model so it is still selected after a refresh
  const persistOpenRouterModel = async (modelId: string) => {
    setOpenRouterModelInput(modelId);
    if (!openRouterApiKey.trim()) return;
    try {
      await api.put('/llm/config', { openrouter: { apiKey: openRouterApiKey.trim(), model: modelId } });
      await activeLLM.reload();
      window.dispatchEvent(new Event('wander-llm-changed'));
    } catch { /* ignore */ }
  };

  const fetchOpenRouterModels = async () => {
    setFetchingOpenRouterModels(true);
    try {
      // Persist the typed key first so the server-side provider can use it
      if (openRouterApiKey.trim()) {
        await api.put('/llm/config', { openrouter: { apiKey: openRouterApiKey.trim(), model: openRouterModelInput.trim() } });
        setOpenRouterKeySaved(true);
      }
      const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/openrouter/models');
      setOpenRouterModels(models);
      push('ok', `Fetched ${models.length} free models from OpenRouter`);
    } catch (e) {
      push('error', `Fetch failed: ${(e as Error).message}`);
    } finally {
      setFetchingOpenRouterModels(false);
    }
  };

  const saveOpenRouterConfig = async () => {
    const apiKey = openRouterApiKey.trim();
    if (!apiKey) return;
    const model = openRouterModelInput.trim();
    setSavingOpenRouter(true);
    try {
      await api.put('/llm/config', { openrouter: { apiKey, model } });
      await activeLLM.reload();
      await llmProviders.reload();
      await loadOpenRouterModels();
      setSavingOpenRouter(false);
      setOpenRouterKeySaved(true);
      push('ok', 'OpenRouter configured');
    } catch (e) {
      setSavingOpenRouter(false);
      push('error', `OpenRouter config failed: ${(e as Error).message}`);
    }
  };

  const updateOpenRouterKey = async () => {
    const apiKey = openRouterApiKey.trim();
    if (!apiKey) return;
    const model = openRouterModelInput.trim();
    setSavingOpenRouter(true);
    try {
      await api.put('/llm/config', { openrouter: { apiKey, model } });
      await activeLLM.reload();
      await llmProviders.reload();
      await loadOpenRouterModels();
      setSavingOpenRouter(false);
      push('ok', 'OpenRouter key updated');
    } catch (e) {
      setSavingOpenRouter(false);
      push('error', `OpenRouter key update failed: ${(e as Error).message}`);
    }
  };

  const selectOpenRouterModel = async (modelId: string) => {
    if (!openRouterApiKey.trim()) {
      push('error', 'Please enter your OpenRouter API key first');
      return;
    }
    setSwitching('openrouter');
    try {
      await api.put('/llm/config', { openrouter: { apiKey: openRouterApiKey.trim(), model: modelId } });
      await api.put('/llm/active', { providerId: 'openrouter', selectedModel: modelId });
      await activeLLM.reload();
      await llmProviders.reload();
      await loadOpenRouterModels();
      setOpenRouterModelInput(modelId);
      window.dispatchEvent(new Event('wander-llm-changed'));
      push('ok', `Switched to OpenRouter: ${modelId}`);
    } catch (e) {
      push('error', `Switch failed: ${(e as Error).message}`);
    } finally {
      setSwitching(null);
    }
  };

  const selectable = (jobs.data ?? []).filter((j: any) => j.state !== 'queued' && j.state !== 'running');
  const allSel = selectable.length > 0 && selectable.every((j: any) => sel.includes(j.id));
  const toggleAll = () => setSel(allSel ? [] : selectable.map((j: any) => j.id));
  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const deleteSelected = async () => {
    if (!sel.length) return;
    if (!confirm(`Delete ${sel.length} job${sel.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    for (const id of sel) await api.del(`/jobs/${id}`);
    setSel([]);
    jobs.reload();
  };

  // Helpers
  const activeId = activeLLM.data?.active ?? null;
  const providers = llmProviders.data ?? [];
  const isActive = (id: string) => id === activeId;
  const providerHealth = (id: string) => {
    const p = providers.find((x: any) => x.id === id);
    return p?.health;
  };
  const providerStatusColor = (p: any) => {
    const h = p.health;
    if (!h) return 'neutral';
    return h.ok ? 'good' : 'bad';
  };

  const loadOllamaModels = async () => {
    try {
      const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/ollama/models');
      setOllamaModels(models);
      // If the saved Ollama model no longer exists (e.g. typed by hand), clear it so generation doesn't fail
      const active = activeLLM.data;
      if (active?.active === 'ollama' && selectedModel && models.length > 0 && !models.some((m) => m.id === selectedModel)) {
        setSelectedModel(null);
        api.put('/llm/active', { selectedModel: null }).then(() => {
          activeLLM.reload();
          window.dispatchEvent(new Event('wander-llm-changed'));
        }).catch(() => {});
      }
    } catch { /* ollama not reachable */ }
  };

  // Load the installed Ollama models automatically (so the dropdown isn't empty until Refresh is clicked)
  useEffect(() => {
    loadOllamaModels();
  }, [llmProviders.data]);

  // Pull/download a model from Ollama
  const [pullInput, setPullInput] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<{ status: string; completed?: number; total?: number; percent?: number } | null>(null);
  const [pullLog, setPullLog] = useState<string[]>([]);
  const pullLogRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = pullLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pullLog]);

  const pullOllamaModel = async () => {
    const model = pullInput.trim();
    if (!model) return;
    setPulling(true);
    setPullProgress({ status: 'starting' });
    setPullLog([`$ ollama pull ${model}`]);
    try {
      const res = await fetch('/llm/providers/ollama/pull/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) throw new Error(`Pull failed (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let failed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const line of parts) {
          if (!line.startsWith('data: ')) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'progress') {
            setPullProgress(ev);
            const pct = ev.percent !== undefined ? ` ${ev.percent}%` : '';
            const bytes = ev.completed && ev.total ? ` (${(ev.completed / 1e9).toFixed(1)}/${(ev.total / 1e9).toFixed(1)} GB)` : '';
            setPullLog((l) => [...l, `${ev.status}${pct}${bytes}`].slice(-300));
          } else if (ev.type === 'error') {
            failed = true;
            setPullLog((l) => [...l, `error: ${ev.message}`]);
          } else if (ev.type === 'done') {
            setPullLog((l) => [...l, 'success']);
          }
        }
      }
      if (failed) throw new Error('Pull failed');
      setPullProgress({ status: 'success' });
      setPullInput('');
      await loadOllamaModels();
      await activeLLM.reload();
      await llmProviders.reload();
      push('ok', `Model "${model}" downloaded`);
    } catch (e) {
      setPullProgress({ status: 'error' });
      setPullLog((l) => [...l, `error: ${(e as Error).message}`]);
      push('error', `Pull failed: ${(e as Error).message}`);
    } finally {
      setPulling(false);
    }
  };

  // Delete a model from Ollama (always requires confirmation)
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<string | null>(null);

  const requestDeleteOllamaModel = (model: string) => {
    setDeleteConfirmModel(model);
  };

  const cancelDeleteOllamaModel = () => {
    setDeleteConfirmModel(null);
  };

  const confirmDeleteOllamaModel = async () => {
    const model = deleteConfirmModel;
    if (!model) return;
    setDeleteConfirmModel(null);
    setDeleting(true);
    try {
      await api.del(`/llm/providers/ollama/delete?model=${encodeURIComponent(model)}`);
      setDeleteInput('');
      await loadOllamaModels();
      await activeLLM.reload();
      await llmProviders.reload();
      push('ok', `Model "${model}" deleted`);
    } catch (e) {
      push('error', `Delete failed: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const switchProvider = async (p: { id: string; name: string }) => {
    setModalProvider(p);
    setModalOpen(true);
  };

  // Save the chosen model for a provider without changing the active provider
  const applyModel = async (providerId: string) => {
    setSwitching(providerId);
    try {
      await api.put('/llm/active', { providerId, selectedModel: selectedModel ?? undefined });
      await activeLLM.reload();
      await llmProviders.reload();
      window.dispatchEvent(new Event('wander-llm-changed'));
      push('ok', `Model saved for ${providerId}`);
    } catch (e) {
      push('error', `Save failed: ${(e as Error).message}`);
    } finally {
      setSwitching(null);
    }
  };

  const confirmSwitch = async () => {
    if (!modalProvider) return;
    setSwitching(modalProvider.id);
    setModalOpen(false);
    try {
      // Only keep the selected model if it belongs to the provider being switched to
      let model: string | null = selectedModel ?? null;
      if (model && modalProvider.id === 'ollama' && !ollamaModels.some((m) => m.id === model)) model = null;
      if (model && modalProvider.id === 'openrouter' && !openRouterModels.some((m) => m.id === model)) model = null;
      await api.put('/llm/active', { providerId: modalProvider.id, selectedModel: model });
      await activeLLM.reload();
      await llmProviders.reload();
      setSelectedModel(activeLLM.data?.selectedModel ?? null);
      window.dispatchEvent(new Event('wander-llm-changed'));
      push('ok', `Global AI provider switched to ${modalProvider.name}`);
    } catch (e) {
      push('error', `Switch failed: ${(e as Error).message}`);
    } finally {
      setSwitching(null);
      setModalProvider(null);
    }
  };

  const saveConfig = async () => {
    try {
      const body: any = {};
      if (ollamaHostInput) body.ollamaHost = ollamaHostInput;
      if (apiBaseUrlInput) {
        body.openaiCompatible = { baseUrl: apiBaseUrlInput, apiKey: apiKeyInput || undefined, model: apiModelInput || '' };
      }
      if (apiModelInput) body.selectedModel = apiModelInput;
      if (defaultToFreeFirst !== undefined) body.defaultToFreeFirst = defaultToFreeFirst;
      await api.put('/llm/config', body);
      await activeLLM.reload();
      await llmProviders.reload();
      setConfigOpen(false);
      push('ok', 'AI provider configuration saved');
    } catch (e) {
      push('error', `Save failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="stack">
      <h1>Settings</h1>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'ai-provider', label: 'AI Provider' },
          { id: 'jobs', label: 'Background jobs' },
          { id: 'system', label: 'System' },
          { id: 'voices', label: 'Voices' },
          { id: 'languages', label: 'Languages' },
          { id: 'providers', label: 'Providers' },
          { id: 'templates', label: 'Templates' },
        ]}
      />

      {tab === 'jobs' && <Card title="Background jobs" actions={<div className="row gap"><Btn small onClick={jobs.reload}>Refresh</Btn><Btn small kind="danger" disabled={!sel.length} onClick={deleteSelected}>Delete selected{sel.length ? ` (${sel.length})` : ''}</Btn></div>}>
        {jobs.loading && !jobs.data && <Loading />}
        {jobs.data && jobs.data.length === 0 && <Empty>No jobs yet. Renders and batch work started from the Compose stage show up here.</Empty>}
        {jobs.data && jobs.data.length > 0 && (
          <div className="jobs-scroll">
          <table>
            <thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="Select all jobs" checked={allSel} onChange={toggleAll} /></th><th>Job</th><th>State</th><th>Progress</th><th>Details</th><th /></tr></thead>
            <tbody>
              {jobs.data.slice(0, 25).map((j) => (
                <tr key={j.id}>
                  <td><input type="checkbox" aria-label={`Select job ${j.id}`} disabled={j.state === 'queued' || j.state === 'running'} checked={sel.includes(j.id)} onChange={() => toggle(j.id)} /></td>
                  <td>{j.kind.replace(/_/g, ' ')}<div className="muted small mono">{new Date(j.created_at).toLocaleTimeString()}{j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}</div></td>
                  <td><Pill tone={j.state === 'succeeded' ? 'good' : j.state === 'failed' ? 'bad' : j.state === 'cancelled' ? 'neutral' : 'info'}>{j.state}</Pill></td>
                  <td style={{ minWidth: 120 }}><div className="bar-prog"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div></td>
                  <td className="small">
                    {j.message && <div className="muted">{j.message}</div>}
                    {j.error && <div style={{ color: 'var(--bad)' }}>{j.error.message}{j.error.recovery && <div className="muted">Fix: {j.error.recovery}</div>}</div>}
                  </td>
                  <td>
                    <div className="row gap">
                      {(j.state === 'queued' || j.state === 'running') && <Btn small kind="danger" onClick={async () => { await api.post(`/jobs/${j.id}/cancel`); jobs.reload(); }}>Cancel</Btn>}
                      {(j.state === 'failed' || j.state === 'cancelled') && <Btn small onClick={async () => { await api.post(`/jobs/${j.id}/retry`); jobs.reload(); }}>Retry</Btn>}
                      {j.state !== 'queued' && j.state !== 'running' && <Btn small kind="danger" onClick={async () => { if (!confirm('Delete this job from the list? This cannot be undone.')) return; await api.del(`/jobs/${j.id}`); jobs.reload(); }}>Delete</Btn>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>}

      {tab === 'system' && <div className="grid g2">
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
      </div>}

      {tab === 'voices' && <Card title="Voices (text-to-speech)">
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
      </Card>}

      {tab === 'languages' && <div className="grid g2">
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
      </div>}

      {tab === 'providers' && <div className="grid g2">
        <Card title="Sources and providers">
          <table><tbody>
            {(stock.data ?? []).map((p) => <tr key={p.id}><td><strong>{p.name}</strong><div className="muted small">{p.terms.freeTier}</div></td><td className="small">{p.terms.commercialUse}<div className="muted">Privacy: {p.terms.privacy}</div></td></tr>)}
            {(i2v.data ?? []).map((p) => <tr key={p.id}><td><strong>{p.name}</strong><div className="muted small">image to video</div></td><td className="small">{p.requirements.gpu ? 'Needs a GPU. ' : 'No GPU needed. '}{p.requirements.downloadsModel ? 'Downloads a model. ' : 'No downloads. '}{p.terms.commercialUse}</td></tr>)}
          </tbody></table>
          <p className="muted small">AI image-to-video models and cloud GPU services are not bundled: they need an endpoint or a large model download that you should approve first.</p>
        </Card>
      </div>}

      {tab === 'templates' && <Card title="Templates">
        <div className="grid g3">
          {(templates.data ?? []).map((t) => (
            <div key={t.id} className="scene">
              <div className="row gap"><strong>{t.name}</strong><span className="grow" /><Pill>{t.kind === 'caption_style' ? 'caption style' : 'script outline'}</Pill></div>
              <div className="muted small" style={{ marginTop: 6 }}>{t.kind === 'script_outline' ? t.content.sections.map((s: any) => s.kind).join(' → ') : `${t.content.font_family}${t.content.pill?.enabled ? ', pill' : ''}${t.content.active_word?.enabled ? ', active word' : ''}`}</div>
              {!t.builtin && <Btn small kind="danger" onClick={async () => { await api.del(`/templates/${t.id}`); templates.reload(); }}>Delete</Btn>}
            </div>
          ))}
        </div>
      </Card>}

      {tab === 'ai-provider' && (
        <>
          {/* Warning banner when no provider is selected */}
          {!activeId && (
            <div className="notice bad" style={{ marginBottom: 12 }}>
              <strong>No AI provider selected.</strong> Script writing, research, and storyboard drawing are disabled until you choose a provider below.{' '}
              <Btn small onClick={() => setConfigOpen(true)}>Configure</Btn>
            </div>
          )}

          <Card title="Global AI Provider">
            <p className="muted" style={{ marginTop: 0 }}>
              One AI selection powers the whole app — Research Studio, script writing, and storyboard drawing. Switching providers never touches your existing projects or data. Nothing is automatic: you choose the provider, and nothing falls back to a paid service on its own.
            </p>

            <div className="row gap" style={{ marginTop: 12, marginBottom: 12 }}>
              <label style={{ fontWeight: 600, fontSize: 14 }}>Free-first default</label>
              <Btn small kind={defaultToFreeFirst ? 'primary' : 'default'} onClick={() => setDefaultToFreeFirst(!defaultToFreeFirst)}>
                {defaultToFreeFirst ? 'On' : 'Off'}
              </Btn>
              <span className="muted small" style={{ marginLeft: 8 }}>
                When on, Ollama (local, free) is preferred if no provider is explicitly chosen.
              </span>
            </div>

            <h4 style={{ margin: '14px 0 8px' }}>Providers</h4>
            {llmProviders.loading && !llmProviders.data && <Loading />}
            {llmProviders.error && <ErrorBox error={llmProviders.error} />}
            {providers.length === 0 && <Empty>No providers registered.</Empty>}
            {providers.length > 0 && (
              <div className="grid g2" style={{ marginTop: 8 }}>
                {providers.map((p: any) => {
                  const active = isActive(p.id);
                  const h = p.health;
                  const ok = h?.ok ?? false;
                  const latency = h?.latencyMs !== undefined ? ` · ${h.latencyMs}ms` : '';
                  const isOllama = p.kind === 'ollama';
                  const isOpenAI = p.kind === 'openai-compatible';
                  if (p.id === 'openrouter') return null; // rendered by the dedicated OpenRouter card below

                  return (
                    <div key={p.id} className="scene" style={{ border: active ? '2px solid var(--good)' : '1px solid var(--muted)', borderRadius: 8, padding: 12, background: active ? 'rgba(34,197,94,0.05)' : 'transparent' }}>
                      <div className="row gap" style={{ marginBottom: 6 }}>
                        <div>
                          <div className="row gap" style={{ alignItems: 'baseline' }}>
                            <strong style={{ fontSize: 15 }}>{p.name}</strong>
                            {active && <span style={{ color: 'var(--good)', fontWeight: 600, fontSize: 12 }}>● ACTIVE</span>}
                            {p.fallback && <span style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 12 }}>● FALLBACK</span>}
                          </div>
                          <div className="muted small">{p.kind}{latency}</div>
                          {h?.lastError && <div className="notice bad" style={{ marginTop: 6, fontSize: 12 }}>{h.lastError}</div>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <Pill tone={providerStatusColor(p)}>{ok ? 'Available' : 'Not available'}</Pill>
                          <div className="muted small" style={{ marginTop: 2 }}>{h?.detail ?? 'Not checked'}</div>
                          {isOllama && (
                            <div className="row gap" style={{ marginTop: 6 }}>
                              {ollamaStatus?.installed ? (
                                ollamaStatus?.running ? (
                                  <>
                                    <Btn small kind="danger" onClick={stopOllama} disabled={switching !== null}>
                                      Stop Ollama
                                    </Btn>
                                    <span className="muted small" style={{ fontSize: 11 }}>PID {ollamaStatus.pid}</span>
                                  </>
                                ) : (
                                  <Btn small onClick={startOllama} disabled={switching !== null}>
                                    Start Ollama
                                  </Btn>
                                )
                              ) : (
                                <Btn small onClick={installOllama} disabled={switching !== null}>
                                  Install Ollama
                                </Btn>
                              )}
                            </div>
                          )}
                          {p.id === 'claude' && !ok && (
                            <div className="row gap" style={{ marginTop: 6 }}>
                              <Btn small onClick={signInClaude} disabled={switching !== null}>
                                Sign in to Claude
                              </Btn>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="muted small" style={{ marginBottom: 8 }}>{p.terms.freeTier}</div>
                      <div className="row gap" style={{ marginBottom: 8 }}>
                        <span className="muted small">Key: {p.terms.requiresKey ? 'Required' : 'None'}</span>
                        <span className="muted small">· {p.terms.commercialUse}</span>
                      </div>

                      {/* Model selector (Ollama and OpenAI-compatible) */}
                      {(isOllama || isOpenAI) && (
                        <div className="form" style={{ marginTop: 8 }}>
                          <Field label="Model">
                            <select
                              value={selectedModel ?? (isOllama ? '' : '')}
                              onChange={(e) => setSelectedModel(e.target.value)}
                              disabled={switching !== null || !ok}
                            >
                              <option value="">Default</option>
                              {isOllama && ollamaModels.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                              ))}
                            </select>
                          </Field>
                          {isOllama && ok && (
                            <div className="row gap" style={{ marginTop: 6 }}>
                              <Btn small onClick={loadOllamaModels}>
                                <Icon name="refresh" small /> Refresh models
                              </Btn>
                              <Btn small disabled={switching !== null || !selectedModel} onClick={() => applyModel('ollama')}>
                                {switching === 'ollama' ? 'Saving…' : 'Apply model'}
                              </Btn>
                            </div>
                          )}
                          {isOllama && ok && (
                            <div className="form" style={{ marginTop: 10 }}>
                              <Field label="Download model">
                                <select value={pullInput} onChange={(e) => setPullInput(e.target.value)} disabled={pulling}>
                                  <option value="">— choose a model —</option>
                                  {OLLAMA_LIBRARY.map((m) => (
                                    <option key={m.id} value={m.id}>{m.label} · {m.params} · {m.size}</option>
                                  ))}
                                </select>
                              </Field>
                              {pullInput && (() => {
                                const d = OLLAMA_LIBRARY.find((m) => m.id === pullInput);
                                return d ? (
                                  <div className="notice small" style={{ marginTop: 6 }}>
                                    <strong>{d.label}</strong> <span className="muted">({d.id})</span>
                                    <div className="muted">{d.desc}</div>
                                    <div className="muted small" style={{ marginTop: 4 }}>Parameters: {d.params} · Download size: {d.size}</div>
                                  </div>
                                ) : null;
                              })()}
                              {pullLog.length > 0 && (
                                <pre
                                  ref={pullLogRef}
                                  style={{ maxHeight: 160, overflow: 'auto', margin: '6px 0 0', padding: 8, background: '#0d1117', color: '#c9d1d9', borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  {pullLog.join('\n')}
                                </pre>
                              )}
                              <div className="row gap" style={{ marginTop: 6 }}>
                                <Btn small disabled={pulling || !pullInput.trim()} onClick={pullOllamaModel}>
                                  {pulling ? 'Pulling…' : 'Pull model'}
                                </Btn>
                                {pullProgress && (
                                  <span className="muted small">{pullProgress.status}{pullProgress.percent !== undefined ? ` (${pullProgress.percent}%)` : ''}</span>
                                )}
                              </div>
                              <span className="muted small">Downloads the model from Ollama's library. Large models can take several minutes.</span>
                            </div>
                          )}
                          {isOllama && ok && (
                            <div className="form" style={{ marginTop: 10 }}>
                              <Field label="Delete model">
                                <select value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} disabled={deleting}>
                                  <option value="">— choose an installed model —</option>
                                  {ollamaModels.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                  ))}
                                </select>
                              </Field>
                              <div className="row gap" style={{ marginTop: 6 }}>
                                <Btn small kind="danger" disabled={deleting || !deleteInput.trim()} onClick={() => requestDeleteOllamaModel(deleteInput.trim())}>
                                  {deleting ? 'Deleting…' : 'Delete model'}
                                </Btn>
                                <span className="muted small">Permanently removes the model from Ollama's local library.</span>
                              </div>
                            </div>
                          )}
                          {isOpenAI && (
                            <div style={{ marginTop: 6 }}><Field label="Model (override)">
                              <input value={apiModelInput} onChange={(e) => setApiModelInput(e.target.value)} placeholder="qwen-2.5-coder-32b" />
                            </Field></div>
                          )}
                        </div>
                      )}

                      <div className="row gap" style={{ marginTop: 10 }}>
                        <Btn small
                          disabled={switching !== null || active}
                          onClick={() => switchProvider({ id: p.id, name: p.name })}
                        >
                          {switching === p.id ? 'Switching…' : active ? 'Active' : 'Use this Provider'}
                        </Btn>
                        {isOllama && ok && (
                          <div style={{ fontSize: 12 }}><Btn small onClick={loadOllamaModels}>
                            <Icon name="refresh" small />
                          </Btn></div>
                        )}
                        {p.id === 'openai-compatible' && (
                          <div style={{ fontSize: 12 }}><Btn small kind="ghost" onClick={() => setConfigOpen(true)}>
                            Configure
                          </Btn></div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {(() => {
                  const activeOR = isActive('openrouter');
                  const hasKey = !!openRouterApiKey.trim();
                  const currentModel = activeLLM.data?.active === 'openrouter' ? activeLLM.data?.selectedModel : null;
                  return (
                    <div className="scene" style={{ border: activeOR ? '2px solid var(--good)' : '1px solid var(--muted)', borderRadius: 8, padding: 12, background: activeOR ? 'rgba(34,197,94,0.05)' : 'transparent' }}>
                      <div className="row gap" style={{ marginBottom: 6 }}>
                        <div>
                          <div className="row gap" style={{ alignItems: 'baseline' }}>
                            <strong style={{ fontSize: 15 }}>OpenRouter</strong>
                            {activeOR && <span style={{ color: 'var(--good)', fontWeight: 600, fontSize: 12 }}>● ACTIVE</span>}
                          </div>
                          <div className="muted small">openrouter · free models</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <Pill tone={hasKey ? 'good' : 'neutral'}>{hasKey ? 'Configured' : 'Needs key'}</Pill>
                          <div className="muted small" style={{ marginTop: 2 }}>{openRouterModels.length} free model{openRouterModels.length === 1 ? '' : 's'}</div>
                        </div>
                      </div>

                      {/* Step 1: API Key */}
                      <Field label="API key">
                        <input type="password" value={openRouterApiKey} onChange={(e) => setOpenRouterApiKey(e.target.value)} placeholder="sk-or-…" disabled={savingOpenRouter} />
                      </Field>

                      {/* Step 2: Fetch Models */}
                      {hasKey && (
                        <div className="row gap" style={{ marginTop: 8, alignItems: 'center' }}>
                          <Btn small onClick={fetchOpenRouterModels} disabled={savingOpenRouter || fetchingOpenRouterModels}>
                            {fetchingOpenRouterModels ? 'Fetching…' : openRouterModels.length === 0 ? 'Fetch free models' : 'Refresh models'}
                          </Btn>
                          {openRouterModels.length > 0 && <span className="muted small">{openRouterModels.length} models available</span>}
                        </div>
                      )}

                      {/* Step 3: Model Selection & Status */}
                      {openRouterModels.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          {/* Current Selection Status */}
                          <div className="form" style={{ marginBottom: 12, padding: 10, background: 'rgba(0,0,0,0.02)', borderRadius: 6, border: '1px solid var(--muted)' }}>
                            <div className="row gap" style={{ alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>Selected Model</strong>
                              {currentModel && activeOR && <Pill tone="good">ACTIVE</Pill>}
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 500, fontFamily: 'monospace', color: currentModel ? 'var(--fg)' : 'var(--muted)' }}>
                              {currentModel ? currentModel : activeOR ? '(none selected)' : '— not active —'}
                            </div>
                            {!currentModel && activeOR && <div className="muted small" style={{ marginTop: 4 }}>No model selected for active provider. Choose one below.</div>}
                          </div>

                          {/* Model Picker */}
                          <Field label="Choose a model">
                            <select value={openRouterModelInput} onChange={(e) => setOpenRouterModelInput(e.target.value)} disabled={switching !== null}>
                              <option value="">— choose a model —</option>
                              {openRouterModels.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                              ))}
                            </select>
                          </Field>

                          {/* Actions */}
                          <div className="row gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                            {!activeOR && hasKey && openRouterModelInput && (
                              <Btn small kind="primary" disabled={switching !== null} onClick={() => selectOpenRouterModel(openRouterModelInput)}>
                                {switching === 'openrouter' ? 'Switching…' : 'Use this Provider'}
                              </Btn>
                            )}
                            {activeOR && hasKey && openRouterModelInput && openRouterModelInput !== currentModel && (
                              <Btn small kind="primary" disabled={switching !== null} onClick={() => selectOpenRouterModel(openRouterModelInput)}>
                                {switching === 'openrouter' ? 'Switching…' : 'Use this Provider'}
                              </Btn>
                            )}
                            {activeOR && hasKey && currentModel && (
                              <Btn small kind="ghost" disabled={switching !== null} onClick={() => setOpenRouterModelInput('')}>
                                Clear selection
                              </Btn>
                            )}
                            {!openRouterKeySaved && hasKey && (
                              <Btn small onClick={saveOpenRouterConfig} disabled={savingOpenRouter || !hasKey}>
                                {savingOpenRouter ? 'Saving…' : 'Save key'}
                              </Btn>
                            )}
                            {openRouterKeySaved && hasKey && (
                              <Btn small kind="ghost" onClick={updateOpenRouterKey} disabled={savingOpenRouter || !hasKey}>
                                {savingOpenRouter ? 'Updating…' : 'Update key'}
                              </Btn>
                            )}
                          </div>
                        </div>
                      )}

                      {!hasKey && <span className="muted small" style={{ marginTop: 8, display: 'block' }}>Enter your API key above, then fetch models to choose one.</span>}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Fallback provider selection */}
            {providers.length > 1 && (
              <div className="form" style={{ marginTop: 16 }}>
                <Field label="Fallback provider (manual retry only)">
                  <select value={fallbackProviderId ?? ''} onChange={(e) => setFallbackProviderId(e.target.value || null)}>
                    <option value="">None</option>
                    {providers.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <span className="muted small">If the active provider fails, you can manually retry with the fallback. No automatic fallback is ever used.</span>
                </Field>
              </div>
            )}
          </Card>

          {/* Configuration panel */}
          <Card title="Provider Configuration">
            <Btn small onClick={() => setConfigOpen(!configOpen)}>
              {configOpen ? 'Hide' : 'Show'} configuration
            </Btn>
            {configOpen && (
              <div className="form" style={{ marginTop: 12 }}>
                <Field label="Ollama host">
                  <input value={ollamaHostInput || 'http://localhost:11434'} onChange={(e) => setOllamaHostInput(e.target.value)} placeholder="http://localhost:11434" />
                  <span className="muted small">Ollama runs fully on your machine; no key or network needed.</span>
                </Field>
                <Field label="OpenAI-compatible base URL">
                  <input value={apiBaseUrlInput} onChange={(e) => setApiBaseUrlInput(e.target.value)} placeholder="https://api.example.com/v1" />
                  <span className="muted small">For Qwen, DeepSeek, Gemini, or any OpenAI-compatible endpoint you control.</span>
                </Field>
                <div className="row gap" style={{ marginTop: 10 }}>
                  <Btn kind="ghost" onClick={() => setConfigOpen(false)}>Cancel</Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Warning banner when switching away from Claude */}
          {activeId && activeId !== 'claude' && providers.some((p: any) => p.id === 'claude') && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              <strong>You are not using Claude.</strong> Script writing, research, and storyboard drawing use <strong>{providers.find((p: any) => p.id === activeId)?.name}</strong>. Your Claude plan is not touched. Switch back to Claude anytime in this panel.
            </div>
          )}
        </>
      )}

      {tab === 'ai-provider' && modalOpen && (
        <Modal title={`Switch AI provider to ${modalProvider?.name}`} onClose={() => { setModalOpen(false); setModalProvider(null); }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            Switching the global AI provider to <strong>{modalProvider?.name}</strong> affects script writing, research, and storyboard drawing across every project.
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            Existing projects and data are preserved. In-progress generations keep using the current provider; new generations use the new one.
          </p>
          {selectedModel !== null && (
            <p className="muted small" style={{ marginTop: 8 }}>Selected model: <strong>{selectedModel}</strong></p>
          )}
          <div className="row gap" style={{ marginTop: 16 }}>
            <Btn onClick={confirmSwitch} disabled={switching !== null}>Use this Provider</Btn>
            <Btn kind="ghost" onClick={() => { setModalOpen(false); setModalProvider(null); }}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {tab === 'ai-provider' && deleteConfirmModel && (
        <Modal title={`Delete model "${deleteConfirmModel}"`} onClose={cancelDeleteOllamaModel}>
          <p className="muted small" style={{ marginTop: 0 }}>
            Permanently delete <strong>{deleteConfirmModel}</strong> from Ollama's local library. This cannot be undone.
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            If this model is the currently selected model, generations will fall back to the default until you pick another.
          </p>
          <div className="row gap" style={{ marginTop: 16 }}>
            <Btn kind="danger" onClick={confirmDeleteOllamaModel} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete model'}
            </Btn>
            <Btn kind="ghost" onClick={cancelDeleteOllamaModel}>Cancel</Btn>
          </div>
        </Modal>
      )}

    </div>
  );
}
