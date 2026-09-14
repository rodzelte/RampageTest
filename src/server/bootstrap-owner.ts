import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { discordIdSchema, staffSchema } from '../shared/models';

export async function bootstrapOwner(
  client: SupabaseClient,
  env: NodeJS.ProcessEnv,
) {
  const email = z.email().parse(env.OWNER_EMAIL?.trim());
  const discordId = env.OWNER_DISCORD_USER_ID
    ? discordIdSchema.parse(env.OWNER_DISCORD_USER_ID)
    : null;
  const { data, error } = await client
    .rpc('bootstrap_owner', {
      p_owner_email: email,
      p_discord_user_id: discordId,
    })
    .single();
  if (error) {
    if (error.code === '23505')
      throw new Error(
        'OWNER or identity conflict. Existing staff data was not changed.',
      );
    throw new Error(
      'OWNER bootstrap failed. Check the confirmed Auth account, configuration, and existing Discord mapping.',
    );
  }
  return staffSchema.parse(data);
}
