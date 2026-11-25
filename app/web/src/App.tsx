import { useEffect, useState } from 'react';
import { useHash } from './hooks';
import { Icon } from './ui';
import { Dashboard } from './pages/Dashboard';
import { ResearchStudio } from './pages/ResearchStudio';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return localStorage.getItem('wander-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('wander-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  return [theme, () => setTheme(theme === 'light' ? 'dark' : 'light')] as const;
}

export function App() {
  const [theme, toggle] = useTheme();
  const hash = useHash();
  const [, , projectId, stageId] = hash.split('/'); // "/p/<id>/<stage>" or "/settings"
  const route = hash.startsWith('/p/') ? 'project' : hash.startsWith('/settings') ? 'settings' : hash.startsWith('/projects') ? 'projects' : 'studio';
  return (
    <>
      <header className="topbar">
        <a className="logo" href="#/">
          <i>
            <svg viewBox="0 0 32 32"><path d="M9 22 16 8l7 14h-4l-3-6-3 6z" /></svg>
          </i>
          Wander AI Director
        </a>
        <nav className="nav row gap">
          <a href="#/" className={route === 'studio' ? 'on' : ''}>Research Studio</a>
          <a href="#/projects" className={route === 'projects' || route === 'project' ? 'on' : ''}>My videos</a>
          <a href="#/settings" className={route === 'settings' ? 'on' : ''}>Jobs &amp; settings</a>
        </nav>
        <span className="grow" />
        <span className="muted small tag">Local-first · nothing is uploaded or published automatically</span>
        <button className="icon-btn" onClick={toggle} aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} title="Switch theme"><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
      </header>
      <main className="page">
        {route === 'studio' && <ResearchStudio />}
        {route === 'projects' && <Dashboard />}
        {route === 'settings' && <SettingsPage />}
        {route === 'project' && <ProjectPage id={projectId} stage={stageId || 'overview'} />}
      </main>
    </>
  );
}
