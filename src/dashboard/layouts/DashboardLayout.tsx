import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { navigation } from '../routes/navigation';
import { Icon } from '../components/Icon';

export function DashboardLayout() {
  const { staff, logout } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = navigation.find((item) => item.path === pathname);
  if (!staff) return null;
  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#page-content">
        Skip to content
      </a>
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <strong>RAMPAGE</strong>
            <small>COMMUNITY CONSOLE</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navigation
            .filter((item) => !item.ownerOnly || staff.role === 'OWNER')
            .map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setMenuOpen(false)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.ownerOnly && (
                  <span className="owner-dot" title="Owner access" />
                )}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          Private Dota 2 community
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="page-heading">
            <button
              className="menu-toggle"
              aria-label="Toggle navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              ☰
            </button>
            <span className="breadcrumb">
              Workspace <span>/</span>{' '}
              <strong>{current?.label ?? 'Dashboard'}</strong>
            </span>
          </div>
          <div className="account">
            <span className="account-email">{staff.email}</span>
            <span className={`badge ${staff.role === 'OWNER' ? 'owner' : ''}`}>
              {staff.role}
            </span>
            <button className="quiet" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </header>
        <main
          id="page-content"
          className="page-content"
          key={`${staff.auth_user_id}:${staff.role}`}
        >
          <div className="page-title">
            <div>
              <p className="eyebrow">
                {staff.role === 'OWNER' ? 'OWNER WORKSPACE' : 'ADMIN WORKSPACE'}
              </p>
              <h1>{current?.label ?? 'Dashboard'}</h1>
            </div>
            <span className="workspace-status">
              <span className="status-dot" />
              Staff access verified
            </span>
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
