/**
 * Route table.
 *
 * Phase 5: login + conversational troubleshooting on top of the existing
 * health/status shell. The browser never talks to FastAPI, Qdrant or Ollama.
 */
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/app-layout';
import { HomePage } from './pages/home-page';
import { StatusPage } from './pages/status-page';
import { LoginPage } from './pages/login-page';
import { ConversationsPage } from './pages/conversations-page';
import { ConversationNewPage } from './pages/conversation-new-page';
import { ConversationDetailPage } from './pages/conversation-detail-page';
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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
