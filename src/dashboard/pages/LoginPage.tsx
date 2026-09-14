import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { canAccessRoute } from '../routes/navigation';

export function LoginPage() {
  const { status, staff, message, login, logout } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (status === 'authenticated' && staff) {
    const requested: unknown = (location.state as { from?: unknown } | null)
      ?.from;
    const destination =
      typeof requested === 'string' && canAccessRoute(staff.role, requested)
        ? requested
        : '/overview';
    return <Navigate to={destination} replace />;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await login(email, password);
    setPassword('');
  }
  return (
    <main className="auth-screen">
      <div className="login-card">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <p className="eyebrow">RAMPAGE · COMMUNITY OPERATIONS</p>
        <h1>Staff sign in</h1>
        <p className="muted">Your community, under control.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={status === 'loading'}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={status === 'loading'}
          />
          <button
            className="primary"
            disabled={status === 'loading'}
            type="submit"
          >
            {status === 'loading' ? 'Verifying access…' : 'Sign in'}
          </button>
        </form>
        {message && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        {message.includes('Sign out could not') && (
          <button onClick={() => void logout()}>Retry sign out</button>
        )}
        <p className="login-note">For authorized OWNER and ADMIN accounts.</p>
      </div>
    </main>
  );
}
