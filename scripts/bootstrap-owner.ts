import pino from 'pino';
import { createServiceClient } from '../src/server/clients';
import { bootstrapOwner } from '../src/server/bootstrap-owner';

const logger = pino();
try {
  const owner = await bootstrapOwner(createServiceClient(), process.env);
  logger.info(
    { staffId: owner.id },
    'OWNER bootstrap completed; exactly one active OWNER is linked.',
  );
} catch (error) {
  logger.error(
    error instanceof Error ? error.message : 'OWNER bootstrap failed.',
  );
  process.exitCode = 1;
}
