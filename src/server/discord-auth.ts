import type { SupabaseClient } from '@supabase/supabase-js';
import type { User } from 'discord.js';
import {
  authorizationSchema,
  discordIdSchema,
  memberSchema,
  roleSchema,
  walletSchema,
  type Role,
} from '../shared/models';

// Accept only a Discord interaction's invoking user, never an option containing a target user.
export type InvokingInteraction = {
  user: Pick<User, 'id' | 'username' | 'globalName'>;
};

export async function ensureDiscordMember(
  client: SupabaseClient,
  interaction: InvokingInteraction,
) {
  const id = discordIdSchema.parse(interaction.user.id);
  const { data, error } = await client
    .rpc('ensure_member', {
      p_discord_user_id: id,
      p_username: interaction.user.username,
      p_display_name: interaction.user.globalName,
    })
    .single();
  if (error) throw new Error('Unable to ensure member identity.');
  return memberSchema.parse(data);
}

export async function requireDiscordRole(
  client: SupabaseClient,
  interaction: InvokingInteraction,
  required: Role,
) {
  const { data, error } = await client.rpc('authorize_discord', {
    p_discord_user_id: discordIdSchema.parse(interaction.user.id),
    p_required_role: roleSchema.parse(required),
  });
  if (error) throw new Error('You do not have permission to use this command.');
  return authorizationSchema.parse(data);
}

// Read-only foundation helper. The caller cannot supply another member's wallet ID.
export async function readInvokingWallet(
  client: SupabaseClient,
  interaction: InvokingInteraction,
) {
  const member = await ensureDiscordMember(client, interaction);
  const { data, error } = await client
    .from('wallets')
    .select('*')
    .eq('user_id', member.id)
    .single();
  if (error) throw new Error('Unable to read your wallet.');
  return walletSchema.parse(data);
}
