/**
 * Route table.
 *
 * PHASE 1: home and service status only. Feature routes are added as their
 * phases land (see docs/DEVELOPMENT_ROADMAP.md).
 */
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/app-layout';
import { HomePage } from './pages/home-page';
import { StatusPage } from './pages/status-page';
import { NotFoundPage } from './pages/not-found-page';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
