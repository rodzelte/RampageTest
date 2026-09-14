import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { staffSchema, type StaffProfile } from './models';

export class StaffAuthorizationError extends Error {}

export async function getStaffSession(
  client: SupabaseClient,
): Promise<StaffProfile> {
  // Verify the current access token with Supabase Auth; do not trust local storage role claims.
  const { data: identity, error: authError } = await client.auth.getUser();
  if (authError || !identity.user) throw new Error('Please sign in again.');
  const { data, error } = await client.rpc('get_staff_session').single();
  if (error) {
    if (error.code === '42501')
      throw new StaffAuthorizationError(
        'An active OWNER or ADMIN account is required.',
      );
    throw new Error('Unable to verify staff access. Please try again.');
  }
  const staff = staffSchema.parse(data);
  if (!staff.active || staff.auth_user_id !== identity.user.id)
    throw new StaffAuthorizationError('Staff authorization failed.');
  return staff;
}

export async function signInStaff(
  client: SupabaseClient,
  email: string,
  password: string,
) {
  const credentials = z
    .object({ email: z.email(), password: z.string().min(1) })
    .parse({ email: email.trim(), password });
  const { error } = await client.auth.signInWithPassword(credentials);
  if (error)
    throw new Error('Unable to sign in. Check your email and password.');
  try {
    const staff = await getStaffSession(client);
    const { error: auditError } = await client.rpc('record_staff_login');
    if (auditError)
      throw new Error('Unable to record staff sign in. Try again.');
    return staff;
  } catch (error) {
    await client.auth.signOut({ scope: 'local' });
    throw error;
  }
}
