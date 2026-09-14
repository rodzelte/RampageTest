import { startBot } from './client/startBot';

void startBot().catch(() => {
  console.error('Discord bot failed to start. Check server configuration.');
  process.exitCode = 1;
});
