import { useEffect, useState } from 'react';
import { useHash } from './hooks';
import { Dashboard, VideoProduction } from './pages/Dashboard';
import { ResearchStudio } from './pages/ResearchStudio';
import { AssetLibrary } from './pages/AssetLibrary';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';
import { Notifications } from './Notifications';
import { Icon, Btn, Modal } from './ui';
import { api } from './api';

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return localStorage.getItem('wander-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('wander-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  return [theme, () => setTheme(theme === 'light' ? 'dark' : 'light')] as const;
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard', href: '#/', icon: 'home' },
  { id: 'research', label: 'Research Studio', href: '#/research', icon: 'search' },
  { id: 'production', label: 'Video Production', href: '#/projects', icon: 'video' },
  { id: 'assets', label: 'Asset Library', href: '#/assets', icon: 'image' },
  { id: 'settings', label: 'Settings', href: '#/settings', icon: 'gear' },
];

export function App() {
  const hash = useHash();
  const [theme, toggle] = useTheme();
  const [menu, setMenu] = useState(false);
  const [, , projectId, stageId] = hash.split('/'); // "/p/<id>/<stage>"
  const route = hash.startsWith('/p/') || hash.startsWith('/projects') ? 'production' : hash.startsWith('/research') ? 'research' : hash.startsWith('/assets') ? 'assets' : hash.startsWith('/settings') ? 'settings' : 'dashboard';
  const [activeAI, setActiveAI] = useState<{ id: string | null; name?: string; model?: string | null } | null>(null);

  // Models for the provider model picker modal
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([]);
  const [ollamaModels, setOllamaModels] = useState<Array<{ id: string; name: string }>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalProvider, setModalProvider] = useState<'ollama' | 'openrouter' | null>(null);
  const [modalSelectedModel, setModalSelectedModel] = useState<string>('');

  // Test connection state
  const [testOutput, setTestOutput] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setMenu(false);
  }, [hash]);

  useEffect(() => {
    const h = () => {
      api.get<{ active: string | null; selectedModel: string | null }>('/llm/active')
        .then((d) => setActiveAI({ id: d.active, model: d.selectedModel }))
        .catch(() => {});
    };
    window.addEventListener('wander-llm-changed', h);
    return () => window.removeEventListener('wander-llm-changed', h);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ active: string | null; fallback: string | null; defaultToFreeFirst: boolean; selectedModel: string | null }>('/llm/active');
        if (!cancelled) setActiveAI({ id: data.active, model: data.selectedModel });
      } catch { /* server may not be running; label stays blank */ }
    })();
    return () => { cancelled = true; };
  }, [hash]);

  const fetchModels = async (providerId: 'ollama' | 'openrouter') => {
    setFetchingModels(true);
    try {
      const models = await api.get<Array<{ id: string; name: string }>>(`/llm/providers/${providerId}/models`);
      if (providerId === 'ollama') setOllamaModels(models);
      else setOpenRouterModels(models);
    } catch { /* models unavailable */ }
    finally {
      setFetchingModels(false);
    }
  };

  const openModelPicker = (providerId: 'ollama' | 'openrouter') => {
    setModalProvider(providerId);
    setModalSelectedModel(activeAI?.model ?? '');
    setModalOpen(true);
    fetchModels(providerId);
  };

  const closeModelPicker = () => {
    setModalOpen(false);
    setModalProvider(null);
    setModalSelectedModel('');
    setTestOutput([]);
    setTesting(false);
  };

  const switchModel = async (modelId: string) => {
    if (!modalProvider) return;
    try {
      await api.put('/llm/active', { providerId: modalProvider, selectedModel: modelId });
      const data = await api.get<{ active: string | null; fallback: string | null; defaultToFreeFirst: boolean; selectedModel: string | null }>('/llm/active');
      setActiveAI({ id: data.active, model: data.selectedModel });
      closeModelPicker();
    } catch { /* switch failed */ }
  };

  const testConnection = async () => {
    if (!modalProvider) return;
    setTesting(true);
    setTestOutput([`Testing ${modalProvider} connection...`]);
    try {
      const res = await api.post<{ ok: boolean; detail: string; latencyMs?: number; lastError?: string }>(`/llm/providers/${modalProvider}/health`);
      const lines: string[] = [];
      lines.push(`POST /llm/providers/${modalProvider}/health`);
      lines.push(`Status: ${res.ok ? 'OK' : 'ERROR'}`);
      lines.push(`Detail: ${res.detail}`);
      if (res.latencyMs !== undefined) lines.push(`Latency: ${res.latencyMs}ms`);
      if (res.lastError) lines.push(`Last error: ${res.lastError}`);
      lines.push('');
      lines.push(res.ok ? '✓ Connection successful' : '✗ Connection failed');
      setTestOutput(lines);
    } catch (e: any) {
      setTestOutput([
        `POST /llm/providers/${modalProvider}/health`,
        `Status: ERROR`,
        `Message: ${e?.message ?? String(e)}`,
        '',
        '✗ Connection failed',
      ]);
    }
    finally {
      setTesting(false);
    }
  };

  return (
    <div className="app">
      <aside className={`sidebar${menu ? ' open' : ''}`} aria-label="Main">
        <a className="logo" href="#/">
          <i><svg viewBox="0 0 32 32"><path d="M9 22 16 8l7 14h-4l-3-6-3 6z" /></svg></i>
          <span>Wander AI Director</span>
        </a>
        <nav>
          {NAV.map((n) => (
            <a key={n.id} href={n.href} className={route === n.id ? 'on' : ''} aria-current={route === n.id ? 'page' : undefined}><Icon name={n.icon} />{n.label}</a>
          ))}
        </nav>
        <p className="side-note">Local-first. Nothing is uploaded or published automatically.</p>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="main">
        <div className="strip">
          <button className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}><Icon name="menu" /></button>
          <span className="grow" />
          {activeAI?.id && (activeAI.id === 'ollama' || activeAI.id === 'openrouter' ? (
            <button
              className="ai-label"
              onClick={() => openModelPicker(activeAI.id as 'ollama' | 'openrouter')}
              title={`Change model (active: ${activeAI.id}${activeAI.model ? ` · ${activeAI.model}` : ''})`}
              style={{ border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            >
              {activeAI.id}{activeAI.model ? ` · ${activeAI.model}` : ''}
            </button>
          ) : (
            <span className="ai-label" title={`Active AI: ${activeAI.id}`}>{activeAI.id}</span>
          ))}
          <Notifications />
          <button className="icon-btn" onClick={toggle} aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} title="Switch theme"><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
        </div>
        <main className="content">
          {route === 'dashboard' && <Dashboard />}
          {route === 'research' && <ResearchStudio />}
          {route === 'production' && (hash.startsWith('/p/') ? <ProjectPage id={projectId} stage={stageId || 'overview'} /> : <VideoProduction stepId={projectId} />)}
          {route === 'assets' && <AssetLibrary />}
          {route === 'settings' && <SettingsPage />}
        </main>
      </div>

      {modalOpen && modalProvider && (
        <Modal title={`${modalProvider} models`} onClose={closeModelPicker} wide>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <strong style={{ fontSize: 14 }}>{modalProvider} models</strong>
              <span className="muted small" style={{ marginLeft: 8 }}>{fetchingModels ? 'Loading…' : `${(modalProvider === 'ollama' ? ollamaModels : openRouterModels).length} available`}</span>
            </div>

            {/* Model list */}
            <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: 8, background: 'color-mix(in srgb, var(--panel) 40%, transparent)' }}>
              {fetchingModels ? (
                <div className="muted small">Loading models…</div>
              ) : (modalProvider === 'ollama' ? ollamaModels : openRouterModels).length === 0 ? (
                <div className="muted small">No models available.</div>
              ) : (
                (modalProvider === 'ollama' ? ollamaModels : openRouterModels).map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: 6,
                      borderRadius: 4,
                      cursor: 'pointer',
                      border: modalSelectedModel === m.id ? '1px solid var(--brand)' : '1px solid transparent',
                      background: modalSelectedModel === m.id ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'transparent',
                    }}
                    onClick={() => setModalSelectedModel(m.id)}
                  >
                    <span style={{ fontSize: 13 }}>{m.name}</span>
                    <span className="muted small mono" style={{ marginLeft: 'auto', fontSize: 11 }}>{m.id}</span>
                    {modalSelectedModel === m.id && <span style={{ color: 'var(--good)', fontSize: 11 }}>● selected</span>}
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn small onClick={() => switchModel(modalSelectedModel)} disabled={!modalSelectedModel || testing}>
                {testing ? 'Switching…' : 'Select model'}
              </Btn>
              <Btn small kind="ghost" onClick={testConnection} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Btn>
            </div>

            {/* Terminal output */}
            <div style={{ marginTop: 8, border: '1px solid var(--line)', borderRadius: 6, background: '#0b0b0f', color: '#e8e8ea', fontFamily: 'monospace', fontSize: 11, padding: 8, maxHeight: 200, overflowY: 'auto' }}>
              {testOutput.map((line, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: 2 }}>{line}</div>
              ))}
              {testing && <div style={{ color: 'var(--brand)' }}>⏳ testing…</div>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
