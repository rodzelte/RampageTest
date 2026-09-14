import { z } from 'zod';

// Configuration validation only; JWT signature verification belongs to Supabase.
// Reject a service key accidentally pasted into a browser/public-key setting.
export const publicSupabaseKeySchema = z.string().refine((key) => {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload: unknown = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    return z.object({ role: z.literal('anon') }).safeParse(payload).success;
  } catch {
    return false;
  }
}, 'Use a Supabase anon or publishable key, never a service/secret key.');
