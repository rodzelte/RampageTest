import { useCallback, useState, type FormEvent } from 'react';
import type { StaffProfile } from '../../shared/models';
import { useAuth } from '../auth/AuthProvider';
import { useQuery } from '../hooks/useQuery';
import { loadStaff, setAdmin, setStaffDiscord } from '../lib/data';
import { formatDate } from '../lib/dates';
import { QueryState } from '../components/QueryState';
import { ConfirmDialog } from '../components/ConfirmDialog';

type Change =
  | { kind: 'link'; email: string; discordId: string }
  | { kind: 'status'; staff: StaffProfile }
  | { kind: 'mapping'; staff: StaffProfile };
export function AdminsPage() {
  const { client, refresh } = useAuth();
  const query = useQuery(
    useCallback((signal: AbortSignal) => loadStaff(client, signal), [client]),
  );
  const [email, setEmail] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const [mapping, setMapping] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function open(next: Change) {
    setChange(next);
    setMapping(
      next.kind === 'link'
        ? next.discordId
        : (next.staff.discord_user_id ?? ''),
    );
    setReason('');
    setError('');
    setNotice('');
  }
  function link(event: FormEvent) {
    event.preventDefault();
    open({ kind: 'link', email: email.trim(), discordId: discordId.trim() });
  }
  async function confirm() {
    if (!change || busy) return;
    setBusy(true);
    setError('');
    try {
      if (change.kind === 'mapping')
        await setStaffDiscord(client, {
          staffId: change.staff.id,
          discordId: mapping,
          reason,
        });
      else if (change.kind === 'status')
        await setAdmin(client, {
          email: change.staff.email,
          discordId: '',
          active: !change.staff.active,
          reason,
        });
      else
        await setAdmin(client, {
          email: change.email,
          discordId: change.discordId,
          active: true,
          reason,
        });
      setNotice(
        'Staff account updated. The change was recorded in the audit log.',
      );
      setChange(null);
      setEmail('');
      setDiscordId('');
      query.reload();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Unable to save this change.',
      );
      void refresh();
    } finally {
      setBusy(false);
    }
  }
  const title =
    change?.kind === 'mapping'
      ? 'Update Discord mapping'
      : change?.kind === 'status'
        ? `${change.staff.active ? 'Disable' : 'Activate'} admin`
        : 'Link existing Auth account';
  return (
    <>
      <div className="section-intro">
        <p>Manage staff access and Discord identity mappings.</p>
        <span className="badge owner">OWNER ACCESS</span>
      </div>
      {notice && (
        <p className="success-message" role="status">
          {notice}
        </p>
      )}
      <section className="panel form-panel">
        <h2>Link an admin</h2>
        <p className="muted">
          Create or invite the user in Supabase Auth first. Their email must be
          confirmed.
        </p>
        <form className="admin-link-form" onSubmit={link}>
          <label>
            Admin email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label>
            Discord user ID <small>(optional)</small>
            <input
              value={discordId}
              onChange={(event) => setDiscordId(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]{17,20}"
              maxLength={20}
            />
          </label>
          <button className="primary" type="submit">
            Review admin link
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Staff accounts</h2>
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
          <>
            <div className="table-scroll">
              <table>
                <caption className="sr-only">
                  Staff accounts and access controls
                </caption>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Discord ID</th>
                    <th>Active</th>
                    <th>Created at</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((staff) => (
                    <tr key={staff.id}>
                      <td>{staff.email}</td>
                      <td>
                        <span
                          className={`badge ${staff.role === 'OWNER' ? 'owner' : ''}`}
                        >
                          {staff.role}
                        </span>
                      </td>
                      <td className="mono">
                        {staff.discord_user_id ?? 'Not linked'}
                      </td>
                      <td>
                        <span
                          className={`badge ${staff.active ? 'active' : 'inactive'}`}
                        >
                          {staff.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="date">{formatDate(staff.created_at)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            aria-label={`Edit Discord ID for ${staff.email}`}
                            onClick={() => open({ kind: 'mapping', staff })}
                          >
                            Edit Discord ID
                          </button>
                          {staff.role === 'ADMIN' ? (
                            <button
                              aria-label={`${staff.active ? 'Disable' : 'Activate'} ${staff.email}`}
                              onClick={() => open({ kind: 'status', staff })}
                            >
                              {staff.active ? 'Disable' : 'Activate'}
                            </button>
                          ) : (
                            <span className="muted protected-label">
                              Protected owner
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!query.data.some((staff) => staff.role === 'ADMIN') && (
              <p className="small-empty">No additional admins found.</p>
            )}
          </>
        )}
      </section>
      {change && (
        <ConfirmDialog
          title={title}
          confirmLabel={
            change.kind === 'mapping'
              ? 'Save mapping'
              : change.kind === 'link'
                ? 'Link admin'
                : change.staff.active
                  ? 'Disable admin'
                  : 'Activate admin'
          }
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => setChange(null)}
        >
          <p>{change.kind === 'link' ? change.email : change.staff.email}</p>
          {change.kind === 'link' && (
            <p className="muted">
              This account will have active ADMIN access
              {change.discordId ? ` with Discord ID ${change.discordId}` : ''}.
              Existing ADMIN access is reactivated when linked again.
            </p>
          )}
          {change.kind === 'mapping' && (
            <label>
              Discord user ID
              <input
                aria-label="Discord user ID"
                value={mapping}
                onChange={(event) => setMapping(event.target.value)}
                pattern="[0-9]{17,20}"
                inputMode="numeric"
                maxLength={20}
              />
              <small>Leave blank to remove the mapping.</small>
            </label>
          )}
          {change.kind === 'status' && (
            <p className="muted">
              {change.staff.active
                ? 'Dashboard and privileged Discord access will be disabled.'
                : 'Dashboard access will be restored. A linked Discord ID also restores privileged commands.'}
            </p>
          )}
          <label>
            Reason
            {change.kind === 'mapping' ||
            (change.kind === 'status' && change.staff.active)
              ? ' (required)'
              : ' (optional)'}
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required={
                change.kind === 'mapping' ||
                (change.kind === 'status' && change.staff.active)
              }
              maxLength={500}
              rows={3}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
