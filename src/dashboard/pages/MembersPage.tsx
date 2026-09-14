import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '../hooks/useQuery';
import { loadMembers, PAGE_SIZE } from '../lib/data';
import { formatDate } from '../lib/dates';
import { dashboardConfig } from '../lib/config';
import { formatPhp } from '../../shared/money';
import { QueryState, Pagination } from '../components/QueryState';
import { Icon } from '../components/Icon';

export function MembersPage() {
  const { client } = useAuth();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const query = useQuery(
    useCallback(
      (signal: AbortSignal) => loadMembers(client, search, page, signal),
      [client, search, page],
    ),
  );
  function apply(event: FormEvent) {
    event.preventDefault();
    setPage(0);
    setSearch(draft);
  }
  return (
    <>
      <div className="section-intro">
        <p>Member identities and wallet balances. Read-only.</p>
        <span className="badge owner">OWNER ACCESS</span>
      </div>
      <section className="panel">
        <form className="toolbar" onSubmit={apply}>
          <label className="search-field">
            Search members
            <input
              aria-label="Search members"
              placeholder="Discord ID, username, or display name"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={100}
            />
          </label>
          <button className="primary" type="submit">
            Search
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft('');
              setSearch('');
              setPage(0);
              query.reload();
            }}
          >
            Reset
          </button>
        </form>
        <QueryState
          loading={query.loading}
          error={query.error}
          retry={query.reload}
        />
        {query.data && (
          <>
            {query.data.rows.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="members" />
                </div>
                <h2>No members found.</h2>
                <p>
                  {search
                    ? 'Try another Discord ID or name.'
                    : 'Members will appear here when they first use the Discord bot.'}
                </p>
              </div>
            ) : (
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Members and wallet balances. Dates in{' '}
                    {dashboardConfig.timezone}.
                  </caption>
                  <thead>
                    <tr>
                      <th>Discord ID</th>
                      <th>Username</th>
                      <th>Display name</th>
                      <th>Status</th>
                      <th className="amount">Available balance</th>
                      <th className="amount">Reserved balance</th>
                      <th>Created at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((member) => (
                      <tr key={member.id}>
                        <td className="mono">{member.discord_user_id}</td>
                        <td>{member.discord_username ?? '—'}</td>
                        <td>{member.display_name ?? '—'}</td>
                        <td>
                          <span
                            className={`badge ${member.status === 'ACTIVE' ? 'active' : 'danger'}`}
                          >
                            {member.status}
                          </span>
                        </td>
                        <td className="amount">
                          {member.wallets
                            ? formatPhp(member.wallets.available_centavos)
                            : 'Unavailable'}
                        </td>
                        <td className="amount">
                          {member.wallets
                            ? formatPhp(member.wallets.reserved_centavos)
                            : 'Unavailable'}
                        </td>
                        <td className="date">
                          {formatDate(member.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={page}
              count={query.data.count}
              pageSize={PAGE_SIZE}
              onPage={setPage}
            />
          </>
        )}
      </section>
      <p className="page-footnote">
        Balances are shown in PHP. Dates use {dashboardConfig.timezone}.
      </p>
    </>
  );
}
