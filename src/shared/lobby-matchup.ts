export type MatchupPlayer = {
  id: string;
  discord_user_id: string;
  display_name: string;
  team: 'RADIANT' | 'DIRE';
  status?: 'ACTIVE' | 'REMOVED';
  added_at: string;
};

function firstActive(players: MatchupPlayer[], team: MatchupPlayer['team']) {
  return players
    .filter((player) => player.status !== 'REMOVED' && player.team === team)
    .sort(
      (left, right) =>
        left.added_at.localeCompare(right.added_at) ||
        left.id.localeCompare(right.id),
    )[0];
}

export function getLobbyMatchup(players: MatchupPlayer[]) {
  return {
    radiant: firstActive(players, 'RADIANT') ?? null,
    dire: firstActive(players, 'DIRE') ?? null,
  };
}

export function matchupName(player: MatchupPlayer | null) {
  if (!player) return 'TBD';
  return player.display_name.trim().replace(/^@+/, '') || 'TBD';
}

export function matchupLabel(players: MatchupPlayer[]) {
  const matchup = getLobbyMatchup(players);
  return `${matchupName(matchup.radiant)} vs ${matchupName(matchup.dire)}`;
}

export function dashboardMatchupLabel(players: MatchupPlayer[]) {
  const matchup = getLobbyMatchup(players);
  const label = (player: MatchupPlayer | null) =>
    player ? `@${matchupName(player)}` : 'TBD';
  return `${label(matchup.radiant)} vs ${label(matchup.dire)}`;
}
