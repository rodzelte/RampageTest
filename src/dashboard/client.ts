import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { publicSupabaseKeySchema } from '../shared/public-key';

export function createDashboardClient() {
  const config = z
    .object({ url: z.url(), key: publicSupabaseKeySchema })
    .parse({
      url: import.meta.env.VITE_SUPABASE_URL,
      key: import.meta.env.VITE_SUPABASE_ANON_KEY,
    });
  return createClient(config.url, config.key);
}
