import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { loadOverview } from '../lib/data';
import { useQuery } from '../hooks/useQuery';
import { QueryState } from '../components/QueryState';
import { Icon } from '../components/Icon';
import { formatPhp } from '../../shared/money';

export function OverviewPage() {
  const { client, staff } = useAuth();
  const role = staff?.role ?? 'ADMIN';
  const query = useQuery(
    useCallback(
      (signal: AbortSignal) => loadOverview(client, role, signal),
      [client, role],
    ),
  );
  const future =
    role === 'OWNER'
      ? ([
          ['Total Cash Out', 9],
          ['Total Bets', 5],
          ['Active Lobbies', 4],
          ['Settled Lobbies', 7],
          ["Today's Cash Out", 9],
        ] as const)
      : ([
          ['Active Lobbies', 4],
          ['Pending Cashouts', 9],
          ['Active Rampage', 8],
        ] as const);
  return (
    <>
      <div className="section-intro">
        <p>A clear view of your community and wallet balances.</p>
        <button onClick={query.reload} disabled={query.loading}>
          Refresh
        </button>
      </div>
      <QueryState
        loading={query.loading}
        error={query.error}
        retry={query.reload}
      />
      {query.data && (
        <div className="metrics-grid">
          <article className="metric-card liability">
            <div className="metric-label">
              <span>Current Wallet Liability</span>
              <Icon name="payments" />
            </div>
            <strong>{formatPhp(query.data.liability)}</strong>
            <p>Available + reserved across all member wallets</p>
            <span className="metric-tag">CURRENT BALANCES</span>
          </article>
          <article className="metric-card">
            <div className="metric-label">
              <span>Total Members</span>
              <Icon name="members" />
            </div>
            <strong>{query.data.totalMembers.toLocaleString('en-PH')}</strong>
            <p>Discord members in your community</p>
            {role === 'OWNER' && (
              <Link to="/members">
                View members <span aria-hidden="true">↗</span>
              </Link>
            )}
          </article>
          {role === 'OWNER' && (
            <article className="metric-card">
              <div className="metric-label">
                <span>Active Admins</span>
                <Icon name="admins" />
              </div>
              <strong>{query.data.activeAdmins}</strong>
              <p>Enabled administrator accounts</p>
              <Link to="/admins">
                Manage admins <span aria-hidden="true">↗</span>
              </Link>
            </article>
          )}
          <article className="metric-card">
            <div className="metric-label">
              <span>Total Cash In</span>
              <Icon name="payments" />
            </div>
            <strong>{formatPhp(query.data.totalCashIn)}</strong>
            <p>Top-ups credited to member wallets</p>
            <Link to="/payments">
              View payments <span aria-hidden="true">↗</span>
            </Link>
          </article>
          <article className="metric-card">
            <div className="metric-label">
              <span>Today's Cash In</span>
              <Icon name="payments" />
            </div>
            <strong>{formatPhp(query.data.todayCashIn)}</strong>
            <p>Credited today in Asia/Manila</p>
            <span className="metric-tag">CREDITED TOPUPS</span>
          </article>
        </div>
      )}
      <section className="future-section">
        <div className="section-heading">
          <div>
            <h2>More of your community, in one place</h2>
            <p>These metrics will appear as each module becomes available.</p>
          </div>
          <span className="badge">UPCOMING</span>
        </div>
        <div className="future-grid">
          {future.map(([label, phase]) => (
            <article className="future-card" key={label}>
              <span>{label}</span>
              <strong>—</strong>
              <small>Coming in Phase {phase}</small>
            </article>
          ))}
        </div>
      </section>
      <div className="info-strip">
        <Icon name="admins" />
        <p>
          {role === 'OWNER'
            ? 'Staff changes are recorded automatically. Review your audit trail at any time.'
            : 'Your workspace includes the community tools assigned to your administrator role.'}
        </p>
        {role === 'OWNER' && <Link to="/audit">View audit logs →</Link>}
      </div>
    </>
  );
}
