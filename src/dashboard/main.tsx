import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { createDashboardClient } from './client';
import './style.css';

const root = createRoot(document.getElementById('root')!);
try {
  root.render(
    <BrowserRouter>
      <App client={createDashboardClient()} />
    </BrowserRouter>,
  );
} catch {
  root.render(
    <main>
      <h1>Staff sign in</h1>
      <p>Set the public Supabase URL and anon key to enable sign in.</p>
    </main>,
  );
}
