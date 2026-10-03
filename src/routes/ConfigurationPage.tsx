import { useSearchParams } from 'react-router-dom';
import SettingsPage from './SettingsPage';
import SetupPage from './SetupPage';
import s from './ConfigurationPage.module.css';

/**
 * One navigation entry for everything a user configures about this app.
 *
 * Setup (provisioning the network alerts) and Settings (dataset, mesh
 * backhaul, GoatTown connection) used to be two sidebar items pointing at two
 * routes, which made "where do I change this?" a guess. They are now two tabs
 * of one page; the selected tab lives in `?tab=` so Back, reload and a shared
 * link keep it.
 */
const TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'alerts', label: 'Alerts setup' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export default function ConfigurationPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const active: TabId = isTabId(requested) ? requested : 'settings';

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ marginBottom: 8 }}>Configuration</h1>
      <p style={{ color: 'var(--cds-color-fg-muted)', fontSize: 'var(--cds-font-size-sm)', marginBottom: 16 }}>
        App settings and the workspace checks that provision this app's network alerts.
      </p>

      <div className={s.tabs} role="tablist" aria-label="Configuration sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`${s.tab} ${active === tab.id ? s.tabActive : ''}`}
            onClick={() => setParams({ tab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === 'settings' ? <SettingsPage /> : <SetupPage />}
    </div>
  );
}
