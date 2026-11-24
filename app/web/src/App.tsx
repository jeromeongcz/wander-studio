import { useHash } from './hooks';
import { Dashboard } from './pages/Dashboard';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';

export function App() {
  const hash = useHash();
  const [, , projectId, stageId] = hash.split('/'); // "/p/<id>/<stage>" or "/settings"
  const route = hash.startsWith('/p/') ? 'project' : hash.startsWith('/settings') ? 'settings' : 'home';
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
          <a href="#/" className={route !== 'settings' ? 'on' : ''}>Projects</a>
          <a href="#/settings" className={route === 'settings' ? 'on' : ''}>Jobs &amp; settings</a>
        </nav>
        <span className="grow" />
        <span className="muted small">Local-first · nothing is uploaded or published automatically</span>
      </header>
      <main className="page">
        {route === 'home' && <Dashboard />}
        {route === 'settings' && <SettingsPage />}
        {route === 'project' && <ProjectPage id={projectId} stage={stageId || 'overview'} />}
      </main>
    </>
  );
}
