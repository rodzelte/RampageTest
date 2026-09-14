import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getStaffSession,
  signInStaff,
  StaffAuthorizationError,
} from '../../shared/staff-auth';
import type { StaffProfile } from '../../shared/models';

export const UNAUTHORIZED_MESSAGE =
  'You are not authorized to access this dashboard.';
type AuthState = {
  status: 'loading' | 'authenticated' | 'anonymous';
  staff: StaffProfile | null;
  message: string;
};
type AuthContextValue = AuthState & {
  client: SupabaseClient;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  client,
  children,
}: {
  client: SupabaseClient;
  children: ReactNode;
}) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    staff: null,
    message: '',
  });
  const revision = useRef(0);
  const signingIn = useRef(false);
  const blockRestore = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (signingIn.current || blockRestore.current) return;
    const attempt = ++revision.current;
    const current = () => mounted.current && attempt === revision.current;
    try {
      const { data, error } = await client.auth.getSession();
      if (!current()) return;
      if (error)
        throw new Error(
          'Unable to restore your session. Please sign in again.',
        );
      if (!data.session) {
        setState((previous) => ({
          status: 'anonymous',
          staff: null,
          message: previous.message,
        }));
        return;
      }
      const staff = await getStaffSession(client);
      if (current()) setState({ status: 'authenticated', staff, message: '' });
    } catch (error) {
      if (!current()) return;
      const message =
        error instanceof StaffAuthorizationError
          ? UNAUTHORIZED_MESSAGE
          : 'Unable to verify your session. Please sign in again.';
      setState({ status: 'anonymous', staff: null, message });
      blockRestore.current = true;
      await closeSession(client);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        ++revision.current;
        if (mounted.current)
          setState((previous) => ({
            status: 'anonymous',
            staff: null,
            message: previous.message,
          }));
        return;
      }
      if (!signingIn.current) {
        clearTimeout(pending);
        // Defer Supabase calls until after its auth callback releases the lock.
        pending = setTimeout(() => void refresh(), 0);
      }
    });
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const interval = setInterval(onFocus, 60000);
    return () => {
      mounted.current = false;
      ++revision.current;
      clearTimeout(pending);
      clearInterval(interval);
      data.subscription.unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [client, refresh]);

  async function login(email: string, password: string) {
    signingIn.current = true;
    blockRestore.current = false;
    const attempt = ++revision.current;
    setState({ status: 'loading', staff: null, message: '' });
    try {
      const staff = await signInStaff(client, email, password);
      if (mounted.current && attempt === revision.current)
        setState({ status: 'authenticated', staff, message: '' });
    } catch (error) {
      blockRestore.current = true;
      const message =
        error instanceof StaffAuthorizationError
          ? UNAUTHORIZED_MESSAGE
          : error instanceof Error
            ? error.message
            : 'Unable to sign in. Please try again.';
      if (mounted.current)
        setState({ status: 'anonymous', staff: null, message });
    } finally {
      signingIn.current = false;
    }
  }

  async function logout() {
    ++revision.current;
    blockRestore.current = true;
    setState({ status: 'anonymous', staff: null, message: '' });
    const closed = await closeSession(client);
    if (!closed && mounted.current)
      setState({
        status: 'anonymous',
        staff: null,
        message: 'Sign out could not be completed. Please retry.',
      });
  }

  return (
    <AuthContext.Provider value={{ ...state, client, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

async function closeSession(client: SupabaseClient) {
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    return !error;
  } catch {
    return false;
  }
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required.');
  return context;
}
