import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { publicSupabaseKeySchema } from './src/shared/public-key.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (
    env.VITE_SUPABASE_ANON_KEY &&
    !publicSupabaseKeySchema.safeParse(env.VITE_SUPABASE_ANON_KEY).success
  ) {
    // Stop before bundling: a runtime-only check would already expose the value.
    throw new Error(
      'VITE_SUPABASE_ANON_KEY must be an anon or publishable key.',
    );
  }
  const serverEnv = loadEnv(mode, process.cwd(), 'APP_');
  const lobbyEnv = loadEnv(mode, process.cwd(), 'DEFAULT_PLATFORM_FEE_');
  const timezone = serverEnv.APP_TIMEZONE || 'Asia/Manila';
  const defaultPlatformFeeBpsText = lobbyEnv.DEFAULT_PLATFORM_FEE_BPS || '500';
  if (!/^\d+$/.test(defaultPlatformFeeBpsText)) {
    throw new Error(
      'DEFAULT_PLATFORM_FEE_BPS must be an integer from 0 to 1000.',
    );
  }
  const defaultPlatformFeeBps = Number(defaultPlatformFeeBpsText);
  if (defaultPlatformFeeBps < 0 || defaultPlatformFeeBps > 1000) {
    throw new Error(
      'DEFAULT_PLATFORM_FEE_BPS must be an integer from 0 to 1000.',
    );
  }
  new Intl.DateTimeFormat('en-PH', { timeZone: timezone }).format();
  return {
    plugins: [react()],
    define: {
      __DASHBOARD_CONFIG__: JSON.stringify({
        appName: 'Rampage',
        timezone,
        environment: mode,
        defaultPlatformFeeBps,
      }),
    },
  };
});
