/**
 * Route table.
 *
 * Phase 5: login + conversational troubleshooting on top of the existing
 * health/status shell. The browser never talks to FastAPI, Qdrant or Ollama.
 * Phase 6: incident management (list, detail, creation) with historical
 * memory and org-scoped data.
 */
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/app-layout';
import { HomePage } from './pages/home-page';
import { StatusPage } from './pages/status-page';
import { LoginPage } from './pages/login-page';
import { ConversationsPage } from './pages/conversations-page';
import { ConversationNewPage } from './pages/conversation-new-page';
import { ConversationDetailPage } from './pages/conversation-detail-page';
import { IncidentsPage } from './pages/incidents-page';
import { IncidentNewPage } from './pages/incident-new-page';
import { IncidentDetailPage } from './pages/incident-detail-page';
import { MaintenancePage } from './pages/maintenance-page';
import { MaintenanceNewPage } from './pages/maintenance-new-page';
import { MachinesPage } from './pages/machines-page';
import { MachineTimelinePage } from './pages/machine-timeline-page';
import { JobsPage } from './pages/jobs-page';
import { NotFoundPage } from './pages/not-found-page';
import { RequireAuth } from './lib/auth';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route
          path="conversations"
          element={
            <RequireAuth>
              <ConversationsPage />
            </RequireAuth>
          }
        />
        <Route
          path="conversations/new"
          element={
            <RequireAuth>
              <ConversationNewPage />
            </RequireAuth>
          }
        />
        <Route
          path="conversations/:id"
          element={
            <RequireAuth>
              <ConversationDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="incidents"
          element={
            <RequireAuth>
              <IncidentsPage />
            </RequireAuth>
          }
        />
        <Route
          path="incidents/new"
          element={
            <RequireAuth>
              <IncidentNewPage />
            </RequireAuth>
          }
        />
        <Route
          path="incidents/:id"
          element={
            <RequireAuth>
              <IncidentDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="maintenance"
          element={
            <RequireAuth>
              <MaintenancePage />
            </RequireAuth>
          }
        />
        <Route
          path="maintenance/new"
          element={
            <RequireAuth>
              <MaintenanceNewPage />
            </RequireAuth>
          }
        />
        <Route
          path="machines"
          element={
            <RequireAuth>
              <MachinesPage />
            </RequireAuth>
          }
        />
        <Route
          path="machines/:id"
          element={
            <RequireAuth>
              <MachineTimelinePage />
            </RequireAuth>
          }
        />
        <Route
          path="jobs"
          element={
            <RequireAuth>
              <JobsPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
