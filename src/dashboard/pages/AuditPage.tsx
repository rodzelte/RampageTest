import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '../hooks/useQuery';
import {
  emptyAuditFilters,
  loadAudit,
  loadStaff,
  PAGE_SIZE,
} from '../lib/data';
import { formatDate } from '../lib/dates';
import { dashboardConfig } from '../lib/config';
import { Pagination, QueryState } from '../components/QueryState';
import { Icon } from '../components/Icon';

export function AuditPage() {
  const { client } = useAuth();
  const [draft, setDraft] = useState(emptyAuditFilters);
  const [filters, setFilters] = useState(emptyAuditFilters);
  const [page, setPage] = useState(0);
  const actors = useQuery(
    useCallback((signal: AbortSignal) => loadStaff(client, signal), [client]),
  );
  const query = useQuery(
    useCallback(
      (signal: AbortSignal) => loadAudit(client, filters, page, signal),
      [client, filters, page],
    ),
  );
  function apply(event: FormEvent) {
    event.preventDefault();
    setPage(0);
    setFilters({ ...draft });
  }
  return (
    <>
      <div className="section-intro">
        <p>A permanent record of staff and system activity.</p>
        <span className="badge owner">READ-ONLY · OWNER ACCESS</span>
      </div>
      <section className="panel">
        <form className="audit-filters toolbar" onSubmit={apply}>
          <label>
            Date
            <input
              type="date"
              value={draft.date}
              onChange={(event) =>
                setDraft({ ...draft, date: event.target.value })
              }
            />
          </label>
          <label>
            Source
            <select
              value={draft.source}
              onChange={(event) =>
                setDraft({ ...draft, source: event.target.value })
              }
            >
              <option value="">All sources</option>
              {['SYSTEM', 'DASHBOARD', 'DISCORD', 'PAYMENT_WEBHOOK'].map(
                (source) => (
                  <option key={source}>{source}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Action
            <input
              value={draft.action}
              onChange={(event) =>
                setDraft({ ...draft, action: event.target.value })
              }
              placeholder="e.g. ADMIN_CREATED"
              maxLength={100}
            />
          </label>
          <label>
            Actor / admin
            <select
              value={draft.actor}
              onChange={(event) =>
                setDraft({ ...draft, actor: event.target.value })
              }
            >
              <option value="">All actors</option>
              <option value="SYSTEM">System events</option>
              {actors.data?.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.email}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" type="submit">
            Apply filters
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(emptyAuditFilters);
              setFilters(emptyAuditFilters);
              setPage(0);
              query.reload();
            }}
          >
            Reset
          </button>
        </form>
        {actors.error && (
          <QueryState
            loading={false}
            error={actors.error}
            retry={actors.reload}
          />
        )}
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
                  <Icon name="audit" />
                </div>
                <h2>No matching audit events.</h2>
                <p>
                  Try a different date or filter. Recorded events will appear
                  here.
                </p>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="audit-table">
                  <caption className="sr-only">
                    Audit events. Dates in {dashboardConfig.timezone}.
                  </caption>
                  <thead>
                    <tr>
                      <th>Date / time</th>
                      <th>Actor</th>
                      <th>Actor Discord ID</th>
                      <th>Source</th>
                      <th>Action</th>
                      <th>Entity type</th>
                      <th>Entity ID</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((event) => {
                      const actor = actors.data?.find(
                        (staff) => staff.id === event.actor_staff_id,
                      );
                      return (
                        <tr key={event.id}>
                          <td className="date">
                            {formatDate(event.created_at)}
                          </td>
                          <td>
                            {actor?.email ??
                              event.actor_auth_user_id ??
                              event.actor_type}
                            <small className="cell-detail">
                              {event.actor_type}
                            </small>
                          </td>
                          <td className="mono">
                            {event.actor_discord_id ?? '—'}
                          </td>
                          <td>
                            <span className="badge">
                              {event.source.replaceAll('_', ' ')}
                            </span>
                          </td>
                          <td className="action-name">
                            {event.action.replaceAll('_', ' ')}
                          </td>
                          <td>{event.entity_type}</td>
                          <td className="mono entity-id">
                            {event.entity_id ?? '—'}
                          </td>
                          <td className="reason-cell">{event.reason ?? '—'}</td>
                        </tr>
                      );
                    })}
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
        All displayed dates and date filters use {dashboardConfig.timezone}.
        Audit history cannot be edited or deleted.
      </p>
    </>
  );
}
