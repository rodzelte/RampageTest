import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryState } from '../components/QueryState';
import { useLobbyRealtime } from '../hooks/useLobbyRealtime';
import { useQuery } from '../hooks/useQuery';
import {
  addLobbyPlayer,
  archiveLobby,
  cancelLobby,
  loadDiscordChannels,
  loadLobby,
  loadLobbyEligibleMembers,
  postponeLobby,
  removeLobbyPlayer,
  resumeLobby,
  updateLobby,
  type LobbyWithRelations,
  type MemberWithWallet,
} from '../lib/data';
import {
  formatBasisPoints,
  formatPhp,
  formatPhpBigint,
} from '../../shared/money';
import type { LobbyPlayer } from '../../shared/models';
import { dashboardMatchupLabel } from '../../shared/lobby-matchup';

function centavosInput(value: number | null) {
  if (value === null) return '';
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

function feeInput(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

function EditLobbyDialog({
  lobby,
  onClose,
  onSaved,
}: {
  lobby: LobbyWithRelations;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const channels = useQuery(
    useCallback(
      (signal: AbortSignal) => loadDiscordChannels(client, signal),
      [client],
    ),
  );
  const committed =
    lobby.financial_commitment_at !== null || lobby.lobby_players.length > 0;
  const [displayName, setDisplayName] = useState(lobby.display_name);
  const [channelId, setChannelId] = useState(lobby.discord_channel_id);
  const [entry, setEntry] = useState(
    centavosInput(lobby.roster_entry_centavos),
  );
  const [sideBetting, setSideBetting] = useState(lobby.side_betting_enabled);
  const [sideMinimum, setSideMinimum] = useState(
    centavosInput(lobby.side_bet_min_centavos),
  );
  const [sideMaximum, setSideMaximum] = useState(
    centavosInput(lobby.side_bet_max_centavos),
  );
  const [platformFee, setPlatformFee] = useState(
    feeInput(lobby.platform_fee_bps),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const channel =
      channels.data?.find((candidate) => candidate.channel_id === channelId) ??
      (committed
        ? {
            channel_id: lobby.discord_channel_id,
            guild_id: lobby.discord_guild_id,
            channel_name: lobby.discord_channels?.channel_name ?? 'current',
            channel_type: 'GUILD_TEXT' as const,
            can_post: true,
            active: true,
            last_synced_at: lobby.updated_at,
          }
        : undefined);
    if (!channel) {
      setError('The configured Discord channel is not currently available.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await updateLobby(client, lobby.id, {
        displayName,
        channel,
        rosterEntry: entry,
        sideBettingEnabled: sideBetting,
        sideBetMinimum: sideMinimum,
        sideBetMaximum: sideMaximum,
        platformFee,
      });
      onSaved();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to edit lobby.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Edit Lobby"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form className="lobby-edit-form" onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <h2>Edit Lobby</h2>
            <p>
              {committed
                ? 'Financial terms and Discord channel are locked because participation has occurred.'
                : 'Financial terms remain editable until the first financial commitment.'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>
        <label>
          Lobby Name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
            required
          />
        </label>
        <label>
          Discord Channel
          <select
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            disabled={committed}
            required
          >
            {channels.data?.map((channel) => (
              <option key={channel.channel_id} value={channel.channel_id}>
                #{channel.channel_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Roster Entry
          <input
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            disabled={committed}
            required
          />
        </label>
        <label>
          Platform Fee
          <input
            value={platformFee}
            onChange={(event) => setPlatformFee(event.target.value)}
            disabled={committed}
            required
          />
          <small>Percent of winning profit</small>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={sideBetting}
            onChange={(event) => setSideBetting(event.target.checked)}
            disabled={committed}
          />
          Side Betting Enabled (Phase 5 configuration only)
        </label>
        <label>
          Side Bet Minimum
          <input
            value={sideMinimum}
            onChange={(event) => setSideMinimum(event.target.value)}
            disabled={committed || !sideBetting}
            required={sideBetting}
          />
        </label>
        <label>
          Side Bet Maximum
          <input
            value={sideMaximum}
            onChange={(event) => setSideMaximum(event.target.value)}
            disabled={committed || !sideBetting}
            required={sideBetting}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function AddPlayerDialog({
  lobby,
  team,
  onClose,
  onAdded,
}: {
  lobby: LobbyWithRelations;
  team: 'RADIANT' | 'DIRE';
  onClose: () => void;
  onAdded: () => void;
}) {
  const { client } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const members = useQuery(
    useCallback(
      (signal: AbortSignal) => loadLobbyEligibleMembers(client, search, signal),
      [client, search],
    ),
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const activeIds = new Set(
    lobby.lobby_players
      .filter((player) => player.status === 'ACTIVE')
      .map((player) => player.user_id),
  );
  async function add(member: MemberWithWallet) {
    setSavingId(member.id);
    setError('');
    try {
      await addLobbyPlayer(client, {
        lobbyId: lobby.id,
        memberId: member.id,
        team,
      });
      onAdded();
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to add player.',
      );
    } finally {
      setSavingId('');
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setSearch(draft);
  }
  return (
    <dialog
      ref={dialog}
      className="player-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2>Add Player to {team === 'RADIANT' ? 'Radiant' : 'Dire'}</h2>
          <p>Entry Required: {formatPhp(lobby.roster_entry_centavos)}</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>
      <form className="toolbar compact-toolbar" onSubmit={submit}>
        <label className="search-field">
          Search active members
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Display name, username, or Discord ID"
          />
        </label>
        <button type="submit">Search</button>
      </form>
      <QueryState
        loading={members.loading}
        error={members.error}
        retry={members.reload}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="eligible-list">
        {members.data
          ?.filter((member) => !activeIds.has(member.id))
          .map((member) => {
            const available = member.wallets?.available_centavos ?? 0;
            const insufficient = available < lobby.roster_entry_centavos;
            return (
              <article key={member.id} className="eligible-member">
                <div>
                  <strong>
                    {member.display_name ?? member.discord_username ?? 'Member'}
                  </strong>
                  <span className="mono">
                    Discord ID: {member.discord_user_id}
                  </span>
                  <span>Available: {formatPhp(available)}</span>
                  {insufficient && (
                    <span className="error">
                      Insufficient available balance.
                    </span>
                  )}
                </div>
                <button
                  className="primary"
                  disabled={insufficient || Boolean(savingId)}
                  onClick={() => void add(member)}
                >
                  {savingId === member.id
                    ? 'Adding…'
                    : `Add to ${team === 'RADIANT' ? 'Radiant' : 'Dire'}`}
                </button>
              </article>
            );
          })}
        {members.data?.filter((member) => !activeIds.has(member.id)).length ===
          0 && <p className="muted">No eligible members found.</p>}
      </div>
    </dialog>
  );
}

function TeamRoster({
  name,
  players,
  lobby,
  onAdd,
  onRemove,
}: {
  name: 'RADIANT' | 'DIRE';
  players: LobbyPlayer[];
  lobby: LobbyWithRelations;
  onAdd: () => void;
  onRemove: (player: LobbyPlayer) => void;
}) {
  return (
    <section className={`team-card ${name.toLowerCase()}`}>
      <div className="team-heading">
        <h2>{name === 'RADIANT' ? '🟢 RADIANT' : '🔴 DIRE'}</h2>
        <span>{players.length}/5</span>
      </div>
      {players.length === 0 ? (
        <p className="muted">Waiting for players…</p>
      ) : (
        <ul className="roster-list">
          {players.map((player) => (
            <li key={player.id}>
              <div>
                <strong>{player.display_name}</strong>
                <span>{formatPhp(player.stake_centavos)} reserved</span>
              </div>
              {lobby.status === 'OPEN' && (
                <button onClick={() => onRemove(player)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {lobby.status === 'OPEN' && players.length < 5 && (
        <button className="primary" onClick={onAdd}>
          Add Player
        </button>
      )}
    </section>
  );
}

export function LobbyDetailPage() {
  const { lobbyId = '' } = useParams();
  const { client, staff } = useAuth();
  const query = useQuery(
    useCallback(
      (signal: AbortSignal) => loadLobby(client, lobbyId, signal),
      [client, lobbyId],
    ),
  );
  useLobbyRealtime(client, query.reload, lobbyId);
  const [adding, setAdding] = useState<'RADIANT' | 'DIRE' | null>(null);
  const [removing, setRemoving] = useState<LobbyPlayer | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    'CANCEL' | 'ARCHIVE' | null
  >(null);

  if (!query.data)
    return (
      <QueryState
        loading={query.loading}
        error={query.error}
        retry={query.reload}
      />
    );
  const lobby = query.data;
  const active = lobby.lobby_players.filter(
    (player) => player.status === 'ACTIVE',
  );
  const radiant = active.filter((player) => player.team === 'RADIANT');
  const dire = active.filter((player) => player.team === 'DIRE');
  const radiantPool = radiant.reduce(
    (sum, player) => sum + BigInt(player.stake_centavos),
    0n,
  );
  const direPool = dire.reduce(
    (sum, player) => sum + BigInt(player.stake_centavos),
    0n,
  );
  const activeBets = lobby.side_bets.filter((bet) => bet.status === 'ACTIVE');
  const radiantSideBetPool = activeBets
    .filter((bet) => bet.side === 'RADIANT')
    .reduce((sum, bet) => sum + BigInt(bet.accepted_amount_centavos), 0n);
  const direSideBetPool = activeBets
    .filter((bet) => bet.side === 'DIRE')
    .reduce((sum, bet) => sum + BigInt(bet.accepted_amount_centavos), 0n);
  const radiantTotal = radiantPool + radiantSideBetPool;
  const direTotal = direPool + direSideBetPool;
  const totalPool = radiantTotal + direTotal;
  const poolDifference =
    radiantTotal >= direTotal
      ? radiantTotal - direTotal
      : direTotal - radiantTotal;
  const leadingSide =
    radiantTotal === direTotal
      ? 'BALANCED'
      : radiantTotal > direTotal
        ? 'RADIANT'
        : 'DIRE';
  const ready = radiant.length === 5 && dire.length === 5;
  const committed =
    lobby.financial_commitment_at !== null || lobby.lobby_players.length > 0;

  async function changeLifecycle(action: 'POSTPONE' | 'RESUME') {
    setSaving(true);
    setError('');
    try {
      if (action === 'POSTPONE') await postponeLobby(client, lobby.id);
      else await resumeLobby(client, lobby.id);
      query.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to update lobby.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function confirmLifecycle() {
    if (!confirmAction) return;
    setSaving(true);
    setError('');
    try {
      if (confirmAction === 'CANCEL') await cancelLobby(client, lobby.id);
      else await archiveLobby(client, lobby.id);
      setConfirmAction(null);
      query.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to update lobby.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setSaving(true);
    setError('');
    try {
      await removeLobbyPlayer(client, removing.id);
      setRemoving(null);
      query.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to remove player.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="section-intro">
        <p>
          <Link to="/lobbies">← Lobby List</Link>
        </p>
        <span className="badge active">STATUS: {lobby.status}</span>
      </div>
      <section className="panel lobby-summary">
        <div className="lobby-summary-heading">
          <div>
            <p className="eyebrow">SCRIM LOBBY</p>
            <h2>{lobby.display_name}</h2>
            <p className="lobby-matchup">
              ⚔️ 🟢{' '}
              {dashboardMatchupLabel(lobby.lobby_players).replace(
                ' vs ',
                ' vs 🔴 ',
              )}
            </p>
          </div>
          {ready && (
            <div className="ready-banner">
              <strong>✅ ROSTERS FULL</strong>
              <span>READY TO LOCK</span>
              <small>Lobby remains OPEN · Locking starts in Phase 6</small>
            </div>
          )}
        </div>
        <dl className="lobby-facts">
          <div>
            <dt>Discord Channel</dt>
            <dd>#{lobby.discord_channels?.channel_name ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Roster Entry</dt>
            <dd>{formatPhp(lobby.roster_entry_centavos)}</dd>
          </div>
          <div>
            <dt>Platform Fee</dt>
            <dd>
              {formatBasisPoints(lobby.platform_fee_bps)} of winning profit
            </dd>
          </div>
          <div>
            <dt>Side Betting</dt>
            <dd>{lobby.side_betting_enabled ? 'Enabled' : 'Disabled'}</dd>
          </div>
          <div>
            <dt>Side Bet Range</dt>
            <dd>
              {lobby.side_betting_enabled
                ? `${formatPhp(lobby.side_bet_min_centavos!)} – ${formatPhp(lobby.side_bet_max_centavos!)}`
                : 'Not configured'}
            </dd>
          </div>
          <div>
            <dt>Discord Sync</dt>
            <dd>
              {lobby.discord_synced_revision >= lobby.discord_revision
                ? 'Current'
                : 'Pending retry'}
            </dd>
          </div>
        </dl>
        {lobby.status !== 'ARCHIVED' && (
          <div className="lobby-actions" aria-label="Lobby management actions">
            {(lobby.status === 'OPEN' || lobby.status === 'POSTPONED') && (
              <button id="edit" onClick={() => setEditing(true)}>
                {committed ? 'Edit Safe Fields' : 'Edit Lobby'}
              </button>
            )}
            {lobby.status === 'OPEN' && (
              <button
                id="postpone"
                disabled={saving}
                onClick={() => void changeLifecycle('POSTPONE')}
              >
                Postpone Lobby
              </button>
            )}
            {lobby.status === 'POSTPONED' && (
              <button
                id="resume"
                disabled={saving}
                onClick={() => void changeLifecycle('RESUME')}
              >
                Resume Lobby
              </button>
            )}
            {(lobby.status === 'OPEN' || lobby.status === 'POSTPONED') && (
              <button
                id="cancel"
                className="danger"
                disabled={saving}
                onClick={() => setConfirmAction('CANCEL')}
              >
                Cancel Lobby
              </button>
            )}
            {staff?.role === 'OWNER' &&
              (lobby.status === 'CANCELLED' || !committed) && (
                <button
                  id="archive"
                  disabled={saving}
                  onClick={() => setConfirmAction('ARCHIVE')}
                >
                  {committed ? 'Archive Lobby' : 'Delete Lobby'}
                </button>
              )}
          </div>
        )}
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="teams-grid">
        <TeamRoster
          name="RADIANT"
          players={radiant}
          lobby={lobby}
          onAdd={() => setAdding('RADIANT')}
          onRemove={setRemoving}
        />
        <TeamRoster
          name="DIRE"
          players={dire}
          lobby={lobby}
          onAdd={() => setAdding('DIRE')}
          onRemove={setRemoving}
        />
      </div>
      <section className="panel roster-pool">
        <h2>Live Pool Summary</h2>
        <div className="pool-summary-grid">
          <span>Radiant Roster: {formatPhpBigint(radiantPool)}</span>
          <span>Radiant Side Bets: {formatPhpBigint(radiantSideBetPool)}</span>
          <strong>Radiant Total: {formatPhpBigint(radiantTotal)}</strong>
          <span>Dire Roster: {formatPhpBigint(direPool)}</span>
          <span>Dire Side Bets: {formatPhpBigint(direSideBetPool)}</span>
          <strong>Dire Total: {formatPhpBigint(direTotal)}</strong>
          <strong>Total Pool: {formatPhpBigint(totalPool)}</strong>
          <strong>Pool Difference: {formatPhpBigint(poolDifference)}</strong>
          <strong>Leading Side: {leadingSide}</strong>
        </div>
        <p>{ready ? 'READY TO LOCK' : 'Waiting for players'}</p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">FINANCIAL HISTORY</p>
            <h2>Side Bets</h2>
          </div>
          <span>{lobby.side_bets.length} positions</span>
        </div>
        {lobby.side_bets.length === 0 ? (
          <p className="muted">No side bets have been placed.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bet #</th>
                  <th>Member</th>
                  <th>Discord</th>
                  <th>Side</th>
                  <th>Requested</th>
                  <th>Current Accepted</th>
                  <th>Status</th>
                  <th>Placed</th>
                  <th>Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {[...lobby.side_bets]
                  .sort((a, b) => b.bet_number - a.bet_number)
                  .map((bet) => (
                    <tr key={bet.id}>
                      <td>#{bet.bet_number}</td>
                      <td>{bet.display_name}</td>
                      <td>{bet.discord_user_id}</td>
                      <td>{bet.side}</td>
                      <td>{formatPhp(bet.requested_amount_centavos)}</td>
                      <td>{formatPhp(bet.accepted_amount_centavos)}</td>
                      <td>
                        <span
                          className={`badge ${bet.status === 'ACTIVE' ? 'active' : ''}`}
                        >
                          {bet.status}
                        </span>
                      </td>
                      <td>{new Date(bet.placed_at).toLocaleString('en-PH')}</td>
                      <td>
                        {bet.cancelled_at
                          ? new Date(bet.cancelled_at).toLocaleString('en-PH')
                          : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding && (
        <AddPlayerDialog
          lobby={lobby}
          team={adding}
          onClose={() => setAdding(null)}
          onAdded={query.reload}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.display_name} from ${removing.team === 'RADIANT' ? 'Radiant' : 'Dire'}?`}
          confirmLabel="Remove & Refund"
          busy={saving}
          onClose={() => !saving && setRemoving(null)}
          onConfirm={() => void remove()}
        >
          <p>
            {formatPhp(removing.stake_centavos)} reserved roster entry will be
            returned to their available balance.
          </p>
        </ConfirmDialog>
      )}
      {editing && (
        <EditLobbyDialog
          lobby={lobby}
          onClose={() => setEditing(false)}
          onSaved={query.reload}
        />
      )}
      {confirmAction === 'CANCEL' && (
        <ConfirmDialog
          title={`Cancel ${lobby.display_name}?`}
          confirmLabel="Cancel & Refund"
          busy={saving}
          onClose={() => !saving && setConfirmAction(null)}
          onConfirm={() => void confirmLifecycle()}
        >
          <p>
            All active roster and side-bet reservations will be returned to
            members. This action cannot be reversed.
          </p>
        </ConfirmDialog>
      )}
      {confirmAction === 'ARCHIVE' && (
        <ConfirmDialog
          title={`${committed ? 'Archive' : 'Delete'} ${lobby.display_name}?`}
          confirmLabel={committed ? 'Archive Lobby' : 'Delete Lobby'}
          busy={saving}
          onClose={() => !saving && setConfirmAction(null)}
          onConfirm={() => void confirmLifecycle()}
        >
          <p>
            This safely archives the lobby and hides it from active views.
            Financial and audit history is preserved.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
