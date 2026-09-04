/**
 * Route table.
 *
 * Phase 9: complete operations workspace — auth, dashboard, machines and
 * models, manuals and processing, troubleshooting conversations, incidents
 * with confirmations and historical evidence, maintenance, users and
 * settings. Every feature page is lazy-loaded for route-level code splitting.
 *
 * The browser only talks to Express (relative /api/v1 paths); it never
 * addresses FastAPI, Qdrant, Mongo or Ollama.
 */
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/app-layout';
import { RequireAuth, RequireCapability } from './lib/auth';
import { AuthLoadingScreen } from './lib/auth';
import { LoginPage } from './pages/login-page';

// Eager: first paint after login.
const DashboardPage = lazy(() => import('./pages/dashboard-page').then((m) => ({ default: m.DashboardPage })));

// Lazy feature pages.
const HomePage = lazy(() => import('./pages/home-page').then((m) => ({ default: m.HomePage })));
const StatusPage = lazy(() => import('./pages/status-page').then((m) => ({ default: m.StatusPage })));
const ForbiddenPage = lazy(() => import('./pages/forbidden-page').then((m) => ({ default: m.ForbiddenPage })));
const ConversationsPage = lazy(() => import('./pages/conversations-page').then((m) => ({ default: m.ConversationsPage })));
const ConversationNewPage = lazy(() => import('./pages/conversation-new-page').then((m) => ({ default: m.ConversationNewPage })));
const ConversationDetailPage = lazy(() => import('./pages/conversation-detail-page').then((m) => ({ default: m.ConversationDetailPage })));
const IncidentsPage = lazy(() => import('./pages/incidents-page').then((m) => ({ default: m.IncidentsPage })));
const IncidentNewPage = lazy(() => import('./pages/incident-new-page').then((m) => ({ default: m.IncidentNewPage })));
const IncidentDetailPage = lazy(() => import('./pages/incident-detail-page').then((m) => ({ default: m.IncidentDetailPage })));
const MaintenancePage = lazy(() => import('./pages/maintenance-page').then((m) => ({ default: m.MaintenancePage })));
const MaintenanceNewPage = lazy(() => import('./pages/maintenance-new-page').then((m) => ({ default: m.MaintenanceNewPage })));
const MaintenanceDetailPage = lazy(() => import('./pages/maintenance-detail-page').then((m) => ({ default: m.MaintenanceDetailPage })));
const MachinesPage = lazy(() => import('./pages/machines-page').then((m) => ({ default: m.MachinesPage })));
const MachineNewPage = lazy(() => import('./pages/machine-new-page').then((m) => ({ default: m.MachineNewPage })));
const MachineDetailPage = lazy(() => import('./pages/machine-detail-page').then((m) => ({ default: m.MachineDetailPage })));
const MachineEditPage = lazy(() => import('./pages/machine-edit-page').then((m) => ({ default: m.MachineEditPage })));
const MachineModelsPage = lazy(() => import('./pages/machine-models-page').then((m) => ({ default: m.MachineModelsPage })));
const ManualsPage = lazy(() => import('./pages/manuals-page').then((m) => ({ default: m.ManualsPage })));
const ManualUploadPage = lazy(() => import('./pages/manual-upload-page').then((m) => ({ default: m.ManualUploadPage })));
const ManualDetailPage = lazy(() => import('./pages/manual-detail-page').then((m) => ({ default: m.ManualDetailPage })));
const JobsPage = lazy(() => import('./pages/jobs-page').then((m) => ({ default: m.JobsPage })));
const UsersPage = lazy(() => import('./pages/users-page').then((m) => ({ default: m.UsersPage })));
const SettingsPage = lazy(() => import('./pages/settings-page').then((m) => ({ default: m.SettingsPage })));
const NotFoundPage = lazy(() => import('./pages/not-found-page').then((m) => ({ default: m.NotFoundPage })));

function Lazy({ children }: { children: React.ReactNode }): JSX.Element {
  return <Suspense fallback={<AuthLoadingScreen />}>{children}</Suspense>;
}

/** Wrap a protected, lazy page. */
function Protected({ children, capability }: { children: React.ReactNode; capability?: Parameters<typeof RequireCapability>[0]['capability'] }): JSX.Element {
  const inner = capability ? (
    <RequireCapability capability={capability}>{children}</RequireCapability>
  ) : (
    <RequireAuth>{children}</RequireAuth>
  );
  return <Lazy>{inner}</Lazy>;
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {/* Public */}
        <Route path="/login" element={<Lazy><LoginPage /></Lazy>} />
        <Route path="/" element={<Lazy><HomePage /></Lazy>} />
        <Route path="/status" element={<Lazy><StatusPage /></Lazy>} />
        <Route path="/forbidden" element={<Lazy><ForbiddenPage /></Lazy>} />

        {/* Authenticated workspace */}
        <Route path="/dashboard" element={<Protected><DashboardPage /></Protected>} />

        <Route path="/conversations" element={<Protected capability="conversation.read_own"><ConversationsPage /></Protected>} />
        <Route path="/conversations/new" element={<Protected capability="conversation.create"><ConversationNewPage /></Protected>} />
        <Route path="/conversations/:id" element={<Protected capability="conversation.read_own"><ConversationDetailPage /></Protected>} />

        <Route path="/incidents" element={<Protected capability="incident.read"><IncidentsPage /></Protected>} />
        <Route path="/incidents/new" element={<Protected capability="incident.create"><IncidentNewPage /></Protected>} />
        <Route path="/incidents/:id" element={<Protected capability="incident.read"><IncidentDetailPage /></Protected>} />

        <Route path="/maintenance" element={<Protected capability="maintenance.read"><MaintenancePage /></Protected>} />
        <Route path="/maintenance/new" element={<Protected capability="maintenance.create"><MaintenanceNewPage /></Protected>} />
        <Route path="/maintenance/:id" element={<Protected capability="maintenance.read"><MaintenanceDetailPage /></Protected>} />

        <Route path="/machines" element={<Protected capability="machine.read"><MachinesPage /></Protected>} />
        <Route path="/machines/new" element={<Protected capability="machine.create"><MachineNewPage /></Protected>} />
        <Route path="/machines/:id" element={<Protected capability="machine.read"><MachineDetailPage /></Protected>} />
        <Route path="/machines/:id/edit" element={<Protected capability="machine.update"><MachineEditPage /></Protected>} />

        <Route path="/machine-models" element={<Protected capability="machine_model.read"><MachineModelsPage /></Protected>} />

        <Route path="/manuals" element={<Protected capability="manual.read"><ManualsPage /></Protected>} />
        <Route path="/manuals/upload" element={<Protected capability="manual.create"><ManualUploadPage /></Protected>} />
        <Route path="/manuals/:id" element={<Protected capability="manual.read"><ManualDetailPage /></Protected>} />

        <Route path="/jobs" element={<Protected capability="manual_processing_job.read"><JobsPage /></Protected>} />

        <Route path="/users" element={<Protected capability="user.read_all"><UsersPage /></Protected>} />
        <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />

        <Route path="*" element={<Lazy><NotFoundPage /></Lazy>} />
      </Route>
    </Routes>
  );
}
