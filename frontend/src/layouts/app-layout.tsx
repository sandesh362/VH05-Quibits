/**
 * Application shell: header, navigation, content outlet, footer.
 * Responsive down to a phone; comfortable on a shop-floor tablet.
 */
import { NavLink, Outlet } from 'react-router-dom';
import './app-layout.css';

const NAV_ITEMS = [
  { to: '/', label: 'Home', end: true },
  { to: '/status', label: 'Service status', end: false },
] as const;

export function AppLayout(): JSX.Element {
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
              <span className="layout__phase">Phase 1 · Infrastructure foundation</span>
            </div>
          </div>

          <nav className="layout__nav" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive ? 'layout__nav-link layout__nav-link--active' : 'layout__nav-link'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="layout__main">
        <Outlet />
      </main>

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
