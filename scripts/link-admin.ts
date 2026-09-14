import pino from 'pino';
import { z } from 'zod';
import { createStaffClient } from '../src/server/clients';
import { signInStaff } from '../src/shared/staff-auth';
import { discordIdSchema, staffSchema } from '../src/shared/models';

const logger = pino();
const client = createStaffClient();
try {
  const email = z.email().parse(process.argv[2]);
  const discordId = process.argv[3]
    ? discordIdSchema.parse(process.argv[3])
    : null;
  const credentials = z
    .object({
      STAFF_LOGIN_EMAIL: z.email(),
      STAFF_LOGIN_PASSWORD: z.string().min(1),
    })
    .parse(process.env);
  const owner = await signInStaff(
    client,
    credentials.STAFF_LOGIN_EMAIL,
    credentials.STAFF_LOGIN_PASSWORD,
  );
  if (owner.role !== 'OWNER') throw new Error('Active OWNER required.');
  // The RPC independently verifies the OWNER; the check above only improves CLI errors.
  const { data, error } = await client
    .rpc('owner_set_admin', { p_email: email, p_discord_user_id: discordId })
    .single();
  if (error)
    throw new Error(
      'ADMIN linking failed. Check the existing confirmed Auth account and Discord ID uniqueness.',
    );
  logger.info({ staffId: staffSchema.parse(data).id }, 'ADMIN linked.');
} catch (error) {
  logger.error(
    error instanceof Error ? error.message : 'ADMIN linking failed.',
  );
  process.exitCode = 1;
} finally {
  await client.auth.signOut({ scope: 'local' });
}
