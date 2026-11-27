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
  const [openRouterImageModels, setOpenRouterImageModels] = useState<Array<{ id: string; name: string }>>([]);
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [openRouterModelInput, setOpenRouterModelInput] = useState('');
  const [openRouterImageModelInput, setOpenRouterImageModelInput] = useState('');
  const [savingOpenRouter, setSavingOpenRouter] = useState(false);
  const [fetchingOpenRouterModels, setFetchingOpenRouterModels] = useState(false);
  const [openRouterKeySaved, setOpenRouterKeySaved] = useState(false);

  // Video production models (Research, Script, Storyboard) - for Claude/OpenRouter
  const [videoModels, setVideoModels] = useState({ research: '', script: '', storyboard: '' });
  const [videoModelsInput, setVideoModelsInput] = useState({ research: '', script: '', storyboard: '' });

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
        setOpenRouterImageModelInput(c.openrouter.imageModel || '');
        if (c.openrouter.apiKey) setOpenRouterKeySaved(true);
      }
      if (c.videoModels) {
        setVideoModels(c.videoModels);
        setVideoModelsInput(c.videoModels);
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

  const loadOpenRouterImageModels = async () => {
    try {
      const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/openrouter/image-models');
      setOpenRouterImageModels(models);
    } catch { /* openrouter not configured yet */ }
  };

  // Auto-load the fetched OpenRouter image models once the saved key is available
  useEffect(() => {
    if (openRouterApiKey.trim() && openRouterImageModels.length === 0) loadOpenRouterImageModels();
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

  const persistOpenRouterImageModel = async (modelId: string) => {
    setOpenRouterImageModelInput(modelId);
    if (!openRouterApiKey.trim()) return;
    try {
      await api.put('/llm/config', { openrouter: { apiKey: openRouterApiKey.trim(), imageModel: modelId } });
      await activeLLM.reload();
      window.dispatchEvent(new Event('wander-llm-changed'));
    } catch { /* ignore */ }
  };

  const persistVideoModels = async () => {
    if (!videoModelsInput.research && !videoModelsInput.script && !videoModelsInput.storyboard) return;
    try {
      await api.put('/llm/config', { videoModels: videoModelsInput });
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
      push('ok', 'Provider configuration saved');
      setConfigOpen(false);
    } catch (e) {
      push('error', `Save failed: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        <Tabs
          items={[
            { id: 'ai-provider', label: 'AI Provider' },
            { id: 'templates', label: 'Templates' },
            { id: 'jobs', label: 'Jobs' },
            { id: 'system', label: 'System' },
            { id: 'providers', label: 'Providers' },
            { id: 'languages', label: 'Languages' },
            { id: 'voices', label: 'Voices' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'ai-provider' && (
          <>
            <h2 style={{ marginBottom: 16 }}>AI Provider</h2>
            <p className="muted small" style={{ marginBottom: 24 }}>
              Choose which LLM provider powers research, script writing, and storyboards. Only the active provider is used — no automatic fallback.
            </p>

            {/* Provider cards */}
            <Card title="Available Providers">
              {providers.map((p: any) => {
                const active = isActive(p.id);
                const ok = providerHealth(p.id)?.ok ?? false;
                const isOllama = p.id === 'ollama';
                const isClaude = p.id === 'claude';
                const isOpenAI = p.id === 'openai-compatible';
                return (
                  <div key={p.id} className="scene" style={{ border: active ? '2px solid var(--good)' : '1px solid var(--muted)', borderRadius: 8, padding: 12, background: active ? 'rgba(34,197,94,0.05)' : 'transparent', marginBottom: 12 }}>
                    <div className="row gap" style={{ marginBottom: 6 }}>
                      <div>
                        <div className="row gap" style={{ alignItems: 'baseline' }}>
                          <strong style={{ fontSize: 15 }}>{p.name}</strong>
                          {active && <span style={{ color: 'var(--good)', fontWeight: 600, fontSize: 12 }}>● ACTIVE</span>}
                        </div>
                        <div className="muted small">{p.kind} · {p.terms}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <Pill tone={providerStatusColor(p)}>{ok ? 'Available' : 'Unavailable'}</Pill>
                        {!ok && isOllama && ollamaStatus && (
                          <div className="muted small" style={{ marginTop: 4 }}>
                            {ollamaStatus.running ? 'Running' : 'Stopped'} · {ollamaStatus.installed ? 'Installed' : 'Not installed'}
                          </div>
                        )}
                      </div>
                    </div>

                    {isClaude && !ok && (
                      <div style={{ marginTop: 8 }}>
                        <Btn small kind="primary" onClick={signInClaude} disabled={switching !== null}>
                          <Icon name="key" small /> Sign in to Claude
                        </Btn>
                      </div>
                    )}

                    {isOllama && !ollamaStatus?.installed && (
                      <div style={{ marginTop: 8 }}>
                        <Btn small kind="primary" onClick={installOllama} disabled={switching !== null}>
                          <Icon name="download" small /> Install Ollama
                        </Btn>
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

              {/* OpenRouter detailed card */}
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

                        {/* Actions for text model */}
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

                        {/* Step 4: Image Model Selection */}
                        {openRouterImageModels.length > 0 && (
                          <div style={{ marginTop: 12 }}>
                            {/* Current Image Model Status */}
                            <div className="form" style={{ marginBottom: 12, padding: 10, background: 'rgba(0,0,0,0.02)', borderRadius: 6, border: '1px solid var(--muted)' }}>
                              <div className="row gap" style={{ alignItems: 'center', marginBottom: 6 }}>
                                <strong style={{ fontSize: 13 }}>Selected Image Model</strong>
                                {openRouterImageModelInput && <Pill tone="good">SET</Pill>}
                              </div>
                              <div style={{ fontSize: 14, fontWeight: 500, fontFamily: 'monospace', color: openRouterImageModelInput ? 'var(--fg)' : 'var(--muted)' }}>
                                {openRouterImageModelInput || '(none selected)'}
                              </div>
                            </div>

                            {/* Image Model Picker */}
                            <Field label="Choose an image model">
                              <select value={openRouterImageModelInput} onChange={(e) => setOpenRouterImageModelInput(e.target.value)} disabled={switching !== null}>
                                <option value="">— choose an image model —</option>
                                {openRouterImageModels.map((m) => (
                                  <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                              </select>
                            </Field>

                            {/* Actions */}
                            <div className="row gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                              {hasKey && openRouterImageModelInput && (
                                <Btn small kind="primary" disabled={switching !== null} onClick={() => persistOpenRouterImageModel(openRouterImageModelInput)}>
                                  {switching === 'openrouter' ? 'Saving…' : 'Save image model'}
                                </Btn>
                              )}
                              {openRouterImageModelInput && (
                                <Btn small kind="ghost" disabled={switching !== null} onClick={() => setOpenRouterImageModelInput('')}>
                                  Clear selection
                                </Btn>
                              )}
                            </div>
                          </div>
                        )}

                        {!hasKey && <span className="muted small" style={{ marginTop: 8, display: 'block' }}>Enter your API key above, then fetch models to choose one.</span>}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Video Production Models card — shown only when active provider is Claude or OpenRouter */}
              {(activeLLM.data?.active === 'claude' || activeLLM.data?.active === 'openrouter') && (
                <div className="scene" style={{ marginTop: 16, border: '1px solid var(--muted)', borderRadius: 8, padding: 12 }}>
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <strong style={{ fontSize: 15 }}>Video Production Models</strong>
                    <span className="muted small">Per-stage model overrides for Research, Script, and Storyboard generation</span>
                  </div>
                  <div className="form" style={{ marginTop: 8 }}>
                    <Field label="Research model">
                      <select value={videoModelsInput.research} onChange={(e) => setVideoModelsInput({ ...videoModelsInput, research: e.target.value })} disabled={switching !== null}>
                        <option value="">Default (provider's active model)</option>
                        <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                        <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                      </select>
                      <span className="muted small">Used for topic research, fact-gathering, and content analysis</span>
                    </Field>
                    <Field label="Script model" hint="Used for script writing, dialogue, and narrative structure">
                      <select value={videoModelsInput.script} onChange={(e) => setVideoModelsInput({ ...videoModelsInput, script: e.target.value })} disabled={switching !== null}>
                        <option value="">Default (provider's active model)</option>
                        <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                        <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                      </select>
                    </Field>
                    <Field label="Storyboard model" hint="Used for scene descriptions, shot lists, and visual planning">
                      <select value={videoModelsInput.storyboard} onChange={(e) => setVideoModelsInput({ ...videoModelsInput, storyboard: e.target.value })} disabled={switching !== null}>
                        <option value="">Default (provider's active model)</option>
                        <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                        <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                      </select>
                    </Field>
                    <div className="row gap" style={{ marginTop: 8 }}>
                      <Btn small kind="primary" disabled={switching !== null} onClick={persistVideoModels}>
                        {switching !== null ? 'Saving…' : 'Save video models'}
                      </Btn>
                      {(videoModelsInput.research || videoModelsInput.script || videoModelsInput.storyboard) && (
                        <Btn small kind="ghost" disabled={switching !== null} onClick={() => setVideoModelsInput({ research: '', script: '', storyboard: '' })}>
                          Clear all
                        </Btn>
                      )}
                    </div>
                  </div>
                </div>
              )}

            </Card>

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
                  <Field label="OpenAI-compatible API key">
                    <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="sk-…" />
                  </Field>
                  <Field label="OpenAI-compatible model override">
                    <input value={apiModelInput} onChange={(e) => setApiModelInput(e.target.value)} placeholder="qwen-2.5-coder-32b" />
                  </Field>
                  <div className="row gap" style={{ marginTop: 10 }}>
                    <Btn kind="ghost" onClick={() => setConfigOpen(false)}>Cancel</Btn>
                    <Btn onClick={saveConfig} disabled={savingOpenRouter}>Save</Btn>
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

        {tab === 'templates' && (
          <>
            <div className="row gap" style={{ marginBottom: 16, alignItems: 'center', justifyContent: 'space-between' }}>
              <h2>Templates</h2>
              <Btn onClick={() => api.post('/templates/seed').then(() => { templates.reload(); push('ok', 'Default templates seeded'); })}>Seed defaults</Btn>
            </div>
            {templates.loading && <Loading />}
            {templates.error && <ErrorBox error={templates.error} />}
            {templates.data && templates.data.length === 0 && !templates.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No templates<div className="row gap" style={{ justifyContent: 'center', marginTop: 8 }}><Btn onClick={() => api.post('/templates/seed').then(() => templates.reload())}>Seed defaults</Btn></div></div>
              </Empty>
            )}
            {templates.data && templates.data.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {templates.data.map((t: any) => (
                  <Card key={t.id} title={t.name} actions={<Btn small kind="ghost" onClick={() => api.del(`/templates/${t.id}`).then(() => { templates.reload(); push('ok', 'Template deleted'); })}>Delete</Btn>} className="card-full-height">
                    <div className="muted small" style={{ marginBottom: 8 }}>{t.id}</div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'jobs' && (
          <>
            <div className="row gap" style={{ marginBottom: 16, alignItems: 'center', justifyContent: 'space-between' }}>
              <h2>Jobs</h2>
              <div className="row gap">
                {allSel ? (
                  <Btn small kind="ghost" onClick={toggleAll}>Deselect all</Btn>
                ) : (
                  <Btn small kind="ghost" onClick={toggleAll} disabled={selectable.length === 0}>Select all</Btn>
                )}
                <Btn small kind="danger" onClick={deleteSelected} disabled={!sel.length}>Delete selected</Btn>
              </div>
            </div>
            {jobs.loading && <Loading />}
            {jobs.error && <ErrorBox error={jobs.error} />}
            {jobs.data && jobs.data.length === 0 && !jobs.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No jobs</div>
              </Empty>
            )}
            {jobs.data && jobs.data.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {jobs.data.map((j: any) => (
                  <Card key={j.id} title="" className="card-padded">
                    <div className="row gap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <div className="row gap" style={{ gap: 12, alignItems: 'center' }}>
                        <input type="checkbox" checked={sel.includes(j.id)} onChange={() => toggle(j.id)} />
                        <strong>{j.type}</strong>
                        <span className="muted small">{j.id.slice(0, 12)}…</span>
                        <Pill tone={j.state === 'done' ? 'good' : j.state === 'error' ? 'bad' : j.state === 'running' ? 'warn' : 'neutral'}>{j.state}</Pill>
                        <span className="muted small">{new Date(j.createdAt).toLocaleString()}</span>
                      </div>
                      {j.state === 'error' && <span className="muted small">{j.error?.slice(0, 80)}…</span>}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'system' && (
          <>
            <h2 style={{ marginBottom: 16 }}>System</h2>
            <Card title="Preflight">
              {pf.loading && <Loading />}
              {pf.error && <ErrorBox error={pf.error} />}
              {pf.data && (
                <div className="form">
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <strong>FFmpeg</strong>
                    <Pill tone={pf.data.ffmpeg ? 'good' : 'bad'}>{pf.data.ffmpeg ? 'Found' : 'Missing'}</Pill>
                    {pf.data.ffmpeg && <span className="muted small">{pf.data.ffmpegVersion}</span>}
                  </div>
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <strong>libass</strong>
                    <Pill tone={pf.data.libass ? 'good' : 'bad'}>{pf.data.libass ? 'Found' : 'Missing'}</Pill>
                  </div>
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <strong>Fonts dir</strong>
                    <Pill tone={pf.data.fontsDir ? 'good' : 'bad'}>{pf.data.fontsDir ? 'Found' : 'Missing'}</Pill>
                    {pf.data.fontsDir && <span className="muted small">{pf.data.fontsCount} fonts</span>}
                  </div>
                  <div className="row gap" style={{ alignItems: 'center' }}>
                    <strong>Writable root</strong>
                    <Pill tone={pf.data.writableRoot ? 'good' : 'bad'}>{pf.data.writableRoot ? 'Yes' : 'No'}</Pill>
                  </div>
                </div>
              )}
            </Card>

            <Card title="Cache" className="card-margin-top">
              {cache.loading && <Loading />}
              {cache.error && <ErrorBox error={cache.error} />}
              {cache.data && (
                <div className="form">
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong>Total size</strong>
                    <span>{fmtBytes(cache.data.totalBytes)}</span>
                  </div>
                  <div className="row gap" style={{ marginBottom: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong>Asset count</strong>
                    <span>{cache.data.assetCount}</span>
                  </div>
                  <Btn small kind="danger" onClick={() => api.post('/cache/clear').then(() => { cache.reload(); push('ok', 'Cache cleared'); })}>Clear cache</Btn>
                </div>
              )}
            </Card>

            <Card title="Disk" className="card-margin-top">
              {pf.data && (
                <div className="form">
                  <div className="row gap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong>Free space</strong>
                    <span>{pf.data.diskFreeGb?.toFixed(1) ?? '?'} GB</span>
                  </div>
                  <div className="row gap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong>Total space</strong>
                    <span>{pf.data.diskTotalGb?.toFixed(1) ?? '?'} GB</span>
                  </div>
                </div>
              )}
            </Card>
          </>
        )}

        {tab === 'providers' && (
          <>
            <h2 style={{ marginBottom: 16 }}>Media Providers</h2>
            <Card title="Image-to-Video Providers">
              {i2v.loading && <Loading />}
              {i2v.error && <ErrorBox error={i2v.error} />}
              {i2v.data && i2v.data.length === 0 && !i2v.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No providers</div>
              </Empty>
            )}
              {i2v.data && i2v.data.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {i2v.data.map((p: any) => (
                    <Card key={p.id} title={p.name} className="card-padded">
                      <div className="muted small" style={{ marginBottom: 8 }}>{p.kind} · {p.id}</div>
                    </Card>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Stock Media Providers" className="card-margin-top">
              {stock.loading && <Loading />}
              {stock.error && <ErrorBox error={stock.error} />}
              {stock.data && stock.data.length === 0 && !stock.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No providers</div>
              </Empty>
            )}
              {stock.data && stock.data.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {stock.data.map((p: any) => (
                    <Card key={p.id} title={p.name} className="card-padded">
                      <div className="muted small" style={{ marginBottom: 8 }}>{p.kind} · {p.id}</div>
                    </Card>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}

        {tab === 'languages' && (
          <>
            <div className="row gap" style={{ marginBottom: 16, alignItems: 'center', justifyContent: 'space-between' }}>
              <h2>Languages</h2>
              <Btn onClick={() => api.post('/locales/seed').then(() => { locales.reload(); push('ok', 'Default locales seeded'); })}>Seed defaults</Btn>
            </div>
            {locales.loading && <Loading />}
            {locales.error && <ErrorBox error={locales.error} />}
            {locales.data && locales.data.length === 0 && !locales.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No locales<div className="row gap" style={{ justifyContent: 'center', marginTop: 8 }}><Btn onClick={() => api.post('/locales/seed').then(() => locales.reload())}>Seed defaults</Btn></div></div>
              </Empty>
            )}
            {locales.data && locales.data.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {locales.data.map((l: any) => (
                  <Card key={l.id} title={l.name} className="card-padded">
                    <div className="row gap" style={{ alignItems: 'center', marginBottom: 8 }}>
                      <span className="muted small">{l.bcp47}</span>
                      <Pill tone="neutral">{l.defaultWpm} wpm</Pill>
                    </div>
                    <div className="row gap" style={{ justifyContent: 'flex-end' }}>
                      <Btn small kind="ghost" onClick={() => api.put(`/locales/${l.id}`, { default_wpm: l.default_wpm }).then(() => { locales.reload(); push('ok', 'Locale updated'); })}>Update</Btn>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'voices' && (
          <>
            <h2 style={{ marginBottom: 16 }}>TTS Voices</h2>
            {tts.loading && <Loading />}
            {tts.error && <ErrorBox error={tts.error} />}
            {tts.data && tts.data.length === 0 && !tts.loading && (
              <Empty>
                <div style={{ textAlign: 'center' }}>No providers</div>
              </Empty>
            )}
            {tts.data && tts.data.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {tts.data.map((p: any) => (
                  <Card key={p.id} title={p.name} className="card-padded">
                    {p.voices && p.voices.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {p.voices.map((v: any) => (
                          <div key={v.id} className="scene" style={{ padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div className="row gap" style={{ gap: 12, alignItems: 'center' }}>
                              <strong>{v.name}</strong>
                              <span className="muted small">{v.gender ?? ''} {v.locale ?? ''}</span>
                            </div>
                            <div className="row gap">
                              <Btn small kind="ghost" onClick={() => api.post(`/tts/test`, { provider: p.id, voice: v.id, text: 'Hello, this is a test.' }).then(() => push('ok', 'Test sent'))}>Test</Btn>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {tab === 'ai-provider' && modalOpen && (
        <Modal title={`Switch AI provider to ${modalProvider?.name}`} onClose={() => { setModalOpen(false); setModalProvider(null); }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            This will change the global provider used for Research, Script, and Storyboard.
          </p>
          <div className="row gap" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <Btn kind="ghost" onClick={() => { setModalOpen(false); setModalProvider(null); }}>Cancel</Btn>
            <Btn kind="primary" onClick={confirmSwitch} disabled={switching !== null}>
              {switching ? 'Switching…' : 'Use this Provider'}
            </Btn>
          </div>
        </Modal>
      )}
    </>
  );
}