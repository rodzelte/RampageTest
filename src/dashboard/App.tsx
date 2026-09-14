import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthProvider } from './auth/AuthProvider';
import { DashboardRoutes } from './routes/DashboardRoutes';

export function App({ client }: { client: SupabaseClient }) {
  return (
    <AuthProvider client={client}>
      <DashboardRoutes />
    </AuthProvider>
  );
}
