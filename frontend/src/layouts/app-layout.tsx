/**
 * Application shell: header, navigation, content outlet, footer.
 * Responsive down to a phone; comfortable on a shop-floor tablet.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import './app-layout.css';

export function AppLayout(): JSX.Element {
  const { user, logout } = useAuth();

  return (
    <div className="layout">
      <header className="layout__header">
        <div className="layout__header-inner">
          <div className="layout__brand">
            <span className="layout__logo" aria-hidden="true">
              ⚙
            </span>
            <div>
              <span className="layout__title">Industrial Troubleshooting Platform</span>
              <span className="layout__phase">Phase 7 · Maintenance history lane &amp; machine timeline</span>
            </div>
          </div>

          <nav className="layout__nav" aria-label="Main navigation">
            <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
              Home
            </NavLink>
            <NavLink to="/status" className={({ isActive }) => navClass(isActive)}>
              Service status
            </NavLink>
            {user && (
              <NavLink to="/conversations" className={({ isActive }) => navClass(isActive)}>
                Troubleshoot
              </NavLink>
            )}
            {user && (
              <NavLink to="/incidents" className={({ isActive }) => navClass(isActive)}>
                Incidents
              </NavLink>
            )}
            {user && (
              <NavLink to="/maintenance" className={({ isActive }) => navClass(isActive)}>
                Maintenance
              </NavLink>
            )}
            {user && (
              <NavLink to="/machines" className={({ isActive }) => navClass(isActive)}>
                Machines
              </NavLink>
            )}
            {user && (user.role === 'admin' || user.role === 'manager') && (
              <NavLink to="/jobs" className={({ isActive }) => navClass(isActive)}>
                Jobs
              </NavLink>
            )}
            <a href="/lab.html" className="layout__nav-link">
              RAG lab
            </a>
            {user ? (
              <button type="button" className="layout__nav-link layout__nav-button" onClick={() => void logout()}>
                Sign out
              </button>
            ) : (
              <NavLink to="/login" className={({ isActive }) => navClass(isActive)}>
                Sign in
              </NavLink>
            )}
          </nav>
        </div>
      </header>

      <main className="layout__main">
        <Outlet />
      </main>

      <footer className="layout__footer" role="contentinfo">
        <p className="safety-disclaimer" data-testid="safety-disclaimer">
          <strong>Safety notice:</strong> answers are generated from your indexed manuals and
          are fallible. Always verify against the machine documentation before acting — manual
          evidence is authoritative; historical and maintenance context is supplementary and
          never proves a diagnosis.
        </p>
      </footer>

      <footer className="layout__footer">
        <span>Runs fully locally · No cloud AI services</span>
        <span className="layout__footer-sep" aria-hidden="true">
          ·
        </span>
        <span>Decision support only — verify against the OEM manual before acting</span>
      </footer>
    </div>
  );
}

function navClass(isActive: boolean): string {
  return isActive ? 'layout__nav-link layout__nav-link--active' : 'layout__nav-link';
}
