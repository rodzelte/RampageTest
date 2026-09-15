import { Icon } from '../components/Icon';
import { dashboardConfig } from '../lib/config';

const modules = {
  rampage: {
    title: 'Head-to-head, coming soon',
    text: 'Rampage functionality will be implemented in Phase 8.',
    phase: 8,
  },
  cashouts: {
    title: 'A clear cashout workflow',
    text: 'Manual GCash cashout will be implemented in Phase 9.',
    phase: 9,
  },
  autopost: {
    title: 'Keep your community in the loop',
    text: 'Autopost management will be completed in Phase 10.',
    phase: 10,
  },
};
export function PlaceholderPage({ module }: { module: keyof typeof modules }) {
  const entry = modules[module];
  return (
    <section className="panel placeholder">
      <div className="empty-icon">
        <Icon name={module} />
      </div>
      <span className="badge">COMING IN PHASE {entry.phase}</span>
      <h2>{entry.title}</h2>
      <p>{entry.text}</p>
    </section>
  );
}
export function SettingsPage() {
  return (
    <>
      <div className="section-intro">
        <p>Application information.</p>
        <span className="badge owner">OWNER ACCESS</span>
      </div>
      <section className="panel settings-panel">
        <h2>Workspace details</h2>
        <dl>
          <div>
            <dt>Application</dt>
            <dd>{dashboardConfig.appName}</dd>
          </div>
          <div>
            <dt>App timezone</dt>
            <dd>{dashboardConfig.timezone}</dd>
          </div>
          <div>
            <dt>Dashboard environment</dt>
            <dd>{dashboardConfig.environment}</dd>
          </div>
          <div>
            <dt>Current release</dt>
            <dd>Phase 4 · Lobby and Roster Foundation</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
