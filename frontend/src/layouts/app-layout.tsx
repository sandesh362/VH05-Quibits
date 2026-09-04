/**
 * Application shell.
 *
 * Sidebar navigation (collapses to a slide-in drawer below 1024px), top bar
 * with mobile menu trigger + current-user menu, breadcrumb-aware content
 * outlet, and the persistent safety footer. Navigation entries are filtered
 * by the authenticated user's capabilities (mirroring the backend policy);
 * the API still enforces every action.
 */
import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { Capability } from '@itp/shared';
import { useAuth } from '../lib/auth';
import { roleLabel } from '../lib/permissions';
import { DropdownMenu } from '../components/ui';
import './app-layout.css';

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  capability?: Capability;
  end?: boolean;
}

interface NavSection {
  title: string;
  entries: NavEntry[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Operations',
    entries: [
      { to: '/dashboard', label: 'Dashboard', icon: '▦', end: true },
      { to: '/machines', label: 'Machines', icon: '⚙', capability: 'machine.read' },
      { to: '/machine-models', label: 'Machine Models', icon: '▤', capability: 'machine_model.read' },
      { to: '/manuals', label: 'Manuals', icon: '📄', capability: 'manual.read' },
      { to: '/jobs', label: 'Document Processing', icon: '◷', capability: 'manual_processing_job.read' },
      { to: '/conversations', label: 'Troubleshooting Assistant', icon: '💬', capability: 'conversation.read_own' },
      { to: '/incidents', label: 'Incidents', icon: '⚠', capability: 'incident.read' },
      { to: '/maintenance', label: 'Maintenance', icon: '🔧', capability: 'maintenance.read' },
    ],
  },
  {
    title: 'Administration',
    entries: [
      { to: '/users', label: 'Users', icon: '👤', capability: 'user.read_all' },
      { to: '/settings', label: 'Settings', icon: '✦' },
    ],
  },
  {
    title: 'System',
    entries: [{ to: '/status', label: 'Service Status', icon: '❤' }],
  },
];

function navClass({ isActive }: { isActive: boolean }): string {
  return `app-nav__link ${isActive ? 'app-nav__link--active' : ''}`;
}

export function AppLayout(): JSX.Element {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname);
    if (mobileNavOpen) setMobileNavOpen(false);
  }

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => !entry.capability || can(entry.capability)),
  })).filter((section) => section.entries.length > 0);

  const navContent = (
    <nav className="app-nav" aria-label="Main navigation">
      {sections.map((section) => (
        <div className="app-nav__section" key={section.title}>
          <p className="app-nav__section-title">{section.title}</p>
          {section.entries.map((entry) => (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.end}
              className={navClass}
              onClick={() => setMobileNavOpen(false)}
            >
              <span className="app-nav__icon" aria-hidden="true">
                {entry.icon}
              </span>
              <span>{entry.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className={`app-shell ${mobileNavOpen ? 'app-shell--nav-open' : ''}`}>
      <aside className="app-sidebar" aria-label="Sidebar navigation">
        <Link to="/dashboard" className="app-brand">
          <span className="app-brand__logo" aria-hidden="true">
            ⚙
          </span>
          <span className="app-brand__text">
            <span className="app-brand__name">Industrial Troubleshooting</span>
            <span className="app-brand__sub">Maintenance intelligence · local-first</span>
          </span>
        </Link>
        {navContent}
        <div className="app-sidebar__footer">
          <p className="app-sidebar__safety">
            Decision support only — verify against the OEM manual before acting.
          </p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div
          className="app-sidebar-backdrop"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside className="app-sidebar app-sidebar--mobile" aria-label="Mobile navigation" aria-hidden={!mobileNavOpen}>
        <Link to="/dashboard" className="app-brand">
          <span className="app-brand__logo" aria-hidden="true">
            ⚙
          </span>
          <span className="app-brand__text">
            <span className="app-brand__name">Industrial Troubleshooting</span>
          </span>
        </Link>
        {navContent}
      </aside>

      <div className="app-body">
        <header className="app-topbar">
          <button
            type="button"
            className="app-topbar__menu"
            aria-label="Open navigation menu"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            ☰
          </button>

          <div className="app-topbar__context">
            {user ? (
              <Link to="/dashboard" className="app-topbar__homelink">
                Operations workspace
              </Link>
            ) : (
              <span className="app-topbar__homelink">Industrial Troubleshooting Platform</span>
            )}
          </div>

          <div className="app-topbar__user">
            {user ? (
              <DropdownMenu
                align="right"
                label={
                  <span className="user-menu__trigger">
                    <span className="user-menu__avatar" aria-hidden="true">
                      {user.fullName.charAt(0).toUpperCase() || user.username.charAt(0).toUpperCase()}
                    </span>
                    <span className="user-menu__name">
                      {user.fullName || user.username}
                      <span className="user-menu__role">{roleLabel(user.role)}</span>
                    </span>
                  </span>
                }
                items={[
                  {
                    node: 'Account settings',
                    onSelect: () => navigate('/settings'),
                  },
                  {
                    node: 'Sign out',
                    onSelect: () => void logout().then(() => navigate('/login')),
                  },
                ]}
              />
            ) : (
              <Link to="/login" className="btn btn--primary btn--sm">
                Sign in
              </Link>
            )}
          </div>
        </header>

        <main className="app-main" id="main-content">
          <Outlet />
        </main>

        <footer className="app-footer" role="contentinfo">
          <p className="safety-disclaimer" data-testid="safety-disclaimer">
            <strong>Safety notice:</strong> answers are generated from your indexed manuals and
            are fallible. Always verify against the machine documentation before acting — manual
            evidence is authoritative; historical and maintenance context is supplementary and
            never proves a diagnosis.
          </p>
          <p className="app-footer__meta">
            Runs fully locally · No cloud AI services · Decision support only
          </p>
        </footer>
      </div>
    </div>
  );
}
