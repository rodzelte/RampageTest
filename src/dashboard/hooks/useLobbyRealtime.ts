import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect } from 'react';

export function useLobbyRealtime(
  client: SupabaseClient,
  reload: () => void,
  lobbyId?: string,
) {
  useEffect(() => {
    const suffix = lobbyId ?? 'all';
    const channel = client
      .channel(`dashboard-lobbies-${suffix}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lobbies',
          ...(lobbyId ? { filter: `id=eq.${lobbyId}` } : {}),
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lobby_players',
          ...(lobbyId ? { filter: `lobby_id=eq.${lobbyId}` } : {}),
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'side_bets',
          ...(lobbyId ? { filter: `lobby_id=eq.${lobbyId}` } : {}),
        },
        reload,
      )
      .subscribe();
    const fallback = window.setInterval(reload, 30_000);
    return () => {
      window.clearInterval(fallback);
      void client.removeChannel(channel);
    };
  }, [client, lobbyId, reload]);
}
