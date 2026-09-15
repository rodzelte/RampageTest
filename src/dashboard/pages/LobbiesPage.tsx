import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { QueryState } from '../components/QueryState';
import { useLobbyRealtime } from '../hooks/useLobbyRealtime';
import { useQuery } from '../hooks/useQuery';
import { createLobby, loadDiscordChannels, loadLobbies } from '../lib/data';
import { dashboardConfig } from '../lib/config';
import { formatDate } from '../lib/dates';
import { formatBasisPoints, formatPhp } from '../../shared/money';
import { dashboardMatchupLabel } from '../../shared/lobby-matchup';

export function LobbiesPage() {
  const { client, staff } = useAuth();
  const navigate = useNavigate();
  const lobbies = useQuery(
    useCallback((signal: AbortSignal) => loadLobbies(client, signal), [client]),
  );
  const channels = useQuery(
    useCallback(
      (signal: AbortSignal) => loadDiscordChannels(client, signal),
      [client],
    ),
  );
  useLobbyRealtime(client, lobbies.reload);
  const [displayName, setDisplayName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [entry, setEntry] = useState('100.00');
  const [sideBetting, setSideBetting] = useState(false);
  const [sideMinimum, setSideMinimum] = useState('100.00');
  const [sideMaximum, setSideMaximum] = useState('5000.00');
  const configuredFee = dashboardConfig.defaultPlatformFeeBps;
  const [platformFee, setPlatformFee] = useState(
    `${Math.floor(configuredFee / 100)}.${String(configuredFee % 100).padStart(2, '0')}`,
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [filter, setFilter] = useState<
    'ACTIVE' | 'OPEN' | 'POSTPONED' | 'CANCELLED' | 'ARCHIVED' | 'ALL'
  >('ACTIVE');
  const filteredLobbies = useMemo(
    () =>
      (lobbies.data ?? []).filter((lobby) => {
        if (filter === 'ALL') return true;
        if (filter === 'ACTIVE')
          return lobby.status === 'OPEN' || lobby.status === 'POSTPONED';
        return lobby.status === filter;
      }),
    [filter, lobbies.data],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const channel = channels.data?.find((row) => row.channel_id === channelId);
    if (!channel) {
      setFormError('Select a Discord channel where the bot can post.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const lobby = await createLobby(client, {
        displayName,
        channel,
        rosterEntry: entry,
        sideBettingEnabled: sideBetting,
        sideBetMinimum: sideMinimum,
        sideBetMaximum: sideMaximum,
        platformFee,
      });
      await navigate(`/lobbies/${lobby.id}`);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Unable to create lobby.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="section-intro">
        <p>Create OPEN scrim lobbies and manage 5v5 roster reservations.</p>
        <span className="badge">OWNER / ADMIN</span>
      </div>
      <section className="panel form-panel">
        <h2>Create Lobby</h2>
        <p>
          The platform fee is disclosed now and applies only to winning profit
          during future settlement. Phase 4 does not collect it.
        </p>
        <form className="lobby-create-form" onSubmit={submit}>
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
              required
            >
              <option value="">Select a channel</option>
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
              inputMode="decimal"
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
              required
            />
          </label>
          <label>
            Platform Fee
            <input
              inputMode="decimal"
              value={platformFee}
              onChange={(event) => setPlatformFee(event.target.value)}
              required
            />
            <small>Percent of winning profit · 0.00%–10.00%</small>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sideBetting}
              onChange={(event) => setSideBetting(event.target.checked)}
            />
            Side Betting Enabled (Phase 5 configuration only)
          </label>
          <label>
            Side Bet Minimum
            <input
              inputMode="decimal"
              value={sideMinimum}
              onChange={(event) => setSideMinimum(event.target.value)}
              disabled={!sideBetting}
              required={sideBetting}
            />
          </label>
          <label>
            Side Bet Maximum
            <input
              inputMode="decimal"
              value={sideMaximum}
              onChange={(event) => setSideMaximum(event.target.value)}
              disabled={!sideBetting}
              required={sideBetting}
            />
          </label>
          <div className="form-submit">
            <button
              className="primary"
              type="submit"
              disabled={saving || channels.loading || !channels.data?.length}
            >
              {saving ? 'Creating…' : 'Create Lobby'}
            </button>
          </div>
        </form>
        {channels.error && <p className="error">{channels.error}</p>}
        {!channels.loading && channels.data?.length === 0 && (
          <p className="muted">
            No postable Discord channels are cached. Start the Discord bot to
            synchronize channels.
          </p>
        )}
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Lobby List</h2>
          <div className="lobby-list-controls">
            <label>
              <span className="sr-only">Lobby status filter</span>
              <select
                aria-label="Lobby status filter"
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as typeof filter)
                }
              >
                <option value="ACTIVE">Active</option>
                <option value="OPEN">Open</option>
                <option value="POSTPONED">Postponed</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="ARCHIVED">Archived</option>
                <option value="ALL">All</option>
              </select>
            </label>
            <button onClick={lobbies.reload}>Refresh</button>
          </div>
        </div>
        <QueryState
          loading={lobbies.loading}
          error={lobbies.error}
          retry={lobbies.reload}
        />
        {lobbies.data &&
          (filteredLobbies.length === 0 ? (
            <div className="empty-state">
              <h2>No lobbies yet.</h2>
              <p>Choose another filter or create an OPEN scrim lobby.</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="lobbies-table">
                <thead>
                  <tr>
                    <th>Lobby</th>
                    <th>Status</th>
                    <th>Radiant</th>
                    <th>Dire</th>
                    <th className="amount">Entry</th>
                    <th>Side Betting</th>
                    <th>Platform Fee</th>
                    <th>Discord Channel</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLobbies.map((lobby) => {
                    const active = lobby.lobby_players.filter(
                      (player) => player.status === 'ACTIVE',
                    );
                    const radiant = active.filter(
                      (player) => player.team === 'RADIANT',
                    ).length;
                    const dire = active.filter(
                      (player) => player.team === 'DIRE',
                    ).length;
                    const ready = radiant === 5 && dire === 5;
                    return (
                      <tr key={lobby.id}>
                        <td>
                          <strong>{lobby.display_name}</strong>
                          <span className="cell-detail">
                            {dashboardMatchupLabel(lobby.lobby_players)}
                          </span>
                        </td>
                        <td>
                          <span className="badge active">{lobby.status}</span>
                          {ready && (
                            <span className="cell-detail ready-text">
                              READY TO LOCK
                            </span>
                          )}
                        </td>
                        <td>{radiant}/5</td>
                        <td>{dire}/5</td>
                        <td className="amount">
                          {formatPhp(lobby.roster_entry_centavos)}
                        </td>
                        <td>
                          {lobby.side_betting_enabled ? 'Enabled' : 'Disabled'}
                        </td>
                        <td>
                          {formatBasisPoints(lobby.platform_fee_bps)} of winning
                          profit
                        </td>
                        <td>
                          #{lobby.discord_channels?.channel_name ?? 'unknown'}
                        </td>
                        <td className="date">{formatDate(lobby.created_at)}</td>
                        <td>
                          <details className="action-menu">
                            <summary>Actions</summary>
                            <div>
                              <Link to={`/lobbies/${lobby.id}`}>View</Link>
                              {(lobby.status === 'OPEN' ||
                                lobby.status === 'POSTPONED') && (
                                <Link to={`/lobbies/${lobby.id}#edit`}>
                                  Edit
                                </Link>
                              )}
                              {lobby.status === 'OPEN' && (
                                <Link to={`/lobbies/${lobby.id}#postpone`}>
                                  Postpone
                                </Link>
                              )}
                              {lobby.status === 'POSTPONED' && (
                                <Link to={`/lobbies/${lobby.id}#resume`}>
                                  Resume
                                </Link>
                              )}
                              {(lobby.status === 'OPEN' ||
                                lobby.status === 'POSTPONED') && (
                                <Link to={`/lobbies/${lobby.id}#cancel`}>
                                  Cancel
                                </Link>
                              )}
                              {staff?.role === 'OWNER' &&
                                (lobby.status === 'CANCELLED' ||
                                  lobby.lobby_players.length === 0) && (
                                  <Link to={`/lobbies/${lobby.id}#archive`}>
                                    {lobby.lobby_players.length === 0
                                      ? 'Delete'
                                      : 'Archive'}
                                  </Link>
                                )}
                            </div>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </section>
    </>
  );
}
