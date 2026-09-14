import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { publicSupabaseKeySchema } from '../shared/public-key';

const serverConfig = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export function createServiceClient(env: NodeJS.ProcessEnv = process.env) {
  if (typeof window !== 'undefined')
    throw new Error('Server credentials cannot be used in a browser.');
  const config = serverConfig.parse(env);
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function createStaffClient(env: NodeJS.ProcessEnv = process.env) {
  const config = z
    .object({
      SUPABASE_URL: z.url(),
      SUPABASE_ANON_KEY: publicSupabaseKeySchema,
    })
    .parse(env);
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
