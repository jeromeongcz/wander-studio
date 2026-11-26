import { useEffect, useState } from 'react';
import { useHash } from './hooks';
import { Dashboard, VideoProduction } from './pages/Dashboard';
import { ResearchStudio } from './pages/ResearchStudio';
import { AssetLibrary } from './pages/AssetLibrary';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';
import { Notifications } from './Notifications';
import { Icon } from './ui';
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
  const [activeAI, setActiveAI] = useState<{ id: string | null; name?: string } | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([]);
  const [fetchingORModels, setFetchingORModels] = useState(false);

  useEffect(() => {
    setMenu(false);
  }, [hash]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ active: string | null; fallback: string | null; defaultToFreeFirst: boolean; selectedModel: string | null }>('/llm/active');
        if (!cancelled) setActiveAI({ id: data.active });
      } catch { /* server may not be running; label stays blank */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (activeAI?.id !== 'openrouter') return;
      try {
        setFetchingORModels(true);
        const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/openrouter/models');
        if (!cancelled) setOpenRouterModels(models);
      } catch { /* openrouter models unavailable */ }
      finally {
        if (!cancelled) setFetchingORModels(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeAI?.id]);

  const switchOpenRouterModel = async (modelId: string) => {
    try {
      await api.put('/llm/active', { providerId: 'openrouter', selectedModel: modelId });
      setOpenRouterModels([]);
      const data = await api.get<{ active: string | null; fallback: string | null; defaultToFreeFirst: boolean; selectedModel: string | null }>('/llm/active');
      setActiveAI({ id: data.active });
      setFetchingORModels(true);
      const models = await api.get<Array<{ id: string; name: string }>>('/llm/providers/openrouter/models');
      setOpenRouterModels(models);
      setFetchingORModels(false);
    } catch { /* switch failed */ }
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
          <Notifications />
          {activeAI?.id === 'openrouter' && (
            <div className="ai-label" title={`Active AI: ${activeAI.id}`}>
              <select
                className="ai-select"
                disabled={fetchingORModels || openRouterModels.length === 0}
                onChange={(e) => switchOpenRouterModel(e.target.value)}
              >
                {openRouterModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
          {activeAI?.id && activeAI.id !== 'openrouter' && (
            <span className="ai-label" title={`Active AI: ${activeAI.id}`}>{activeAI.id}</span>
          )}
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
    </div>
  );
}
