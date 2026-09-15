import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { DashboardLayout } from '../layouts/DashboardLayout';
import { LoginPage } from '../pages/LoginPage';
import { OverviewPage } from '../pages/OverviewPage';
import { MembersPage } from '../pages/MembersPage';
import { AdminsPage } from '../pages/AdminsPage';
import { AuditPage } from '../pages/AuditPage';
import { PlaceholderPage, SettingsPage } from '../pages/PlaceholderPage';
import { PaymentsPage } from '../pages/PaymentsPage';
import { LobbiesPage } from '../pages/LobbiesPage';
import { LobbyDetailPage } from '../pages/LobbyDetailPage';
import { canAccessRoute } from './navigation';

function ProtectedRoute() {
  const { status, staff } = useAuth();
  const location = useLocation();
  if (status === 'loading')
    return (
      <main className="auth-screen" role="status">
        Verifying staff access…
      </main>
    );
  if (!staff || status !== 'authenticated')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function RouteAuthorization() {
  const { staff } = useAuth();
  const { pathname } = useLocation();
  if (!staff || !canAccessRoute(staff.role, pathname))
    return (
      <section className="empty-state">
        <span className="badge danger">Access denied</span>
        <h2>This page is restricted</h2>
        <p>Your account does not have access to this page.</p>
      </section>
    );
  return <Outlet />;
}

export function DashboardRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route element={<RouteAuthorization />}>
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/admins" element={<AdminsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/lobbies" element={<LobbiesPage />} />
            <Route path="/lobbies/:lobbyId" element={<LobbyDetailPage />} />
            <Route
              path="/rampage"
              element={<PlaceholderPage module="rampage" />}
            />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route
              path="/cashouts"
              element={<PlaceholderPage module="cashouts" />}
            />
            <Route
              path="/autopost"
              element={<PlaceholderPage module="autopost" />}
            />
          </Route>
          <Route
            path="*"
            element={
              <section className="empty-state">
                <h2>Page not found</h2>
                <p>Choose a page from the sidebar.</p>
              </section>
            }
          />
        </Route>
      </Route>
    </Routes>
  );
}
