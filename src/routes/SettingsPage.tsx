import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import { useSetup, type SetupStep } from '@criblio/app-utils/goattown/setup-panel';
import { loadSettings, saveSettings, type AppSettings } from '../api/appSettings';
import {
  connectionDiagnostics,
  DEFAULT_AGENT,
  type ConnectionDiagnostics,
} from '../api/goattown';
import bundledAgentConfig from '../../goattown.config.yaml?raw';

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

/**
 * The agent configuration this app stages into GoatTown, from the repository
 * that ships with the app.
 *
 * The top-level `producer:` is stripped: the connection's credential names
 * the producer (`AppConfigurationScope.producerInput === 'credential'`), so a
 * proposal that carries one would be rejected — and a second token would have
 * to live in the browser, which is the thing this flow exists to avoid.
 */
function buildAgentConfigYaml(): string {
  return bundledAgentConfig.replace(/^producer:.*\r?\n/m, '');
}

/**
 * The setup step, in words a human can act on. Each value names something
 * different to do, which is why the framework models it as a step and not a
 * boolean.
 */
const STEP_LABEL: Record<SetupStep, string> = {
  loading: 'Checking the GoatTown connection…',
  'needs-url': 'No service URL saved yet.',
  'needs-credential':
    'The service rejected the credential — save an embed token below, or have an administrator deliver one through Connected apps.',
  'needs-proposal':
    'Connected. This app\'s agent configuration has not been staged for this connection yet.',
  'awaiting-activation':
    'Configuration staged and waiting for a human to activate it in GoatTown.',
  ready: 'Ready — authenticated, the staged revision is active, and the agent is in the catalog.',
  error: 'Setup cannot continue from here; see the detail below.',
};

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid var(--cds-color-border)',
  borderRadius: 'var(--cds-radius-md)',
  marginBottom: 16,
} as const;

const buttonStyle = {
  padding: '8px 20px',
  background: 'var(--cds-color-primary)',
  color: 'var(--cds-color-primary-fg)',
  border: 'none',
  borderRadius: 'var(--cds-radius-md)',
  fontWeight: 600,
} as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [gtToken, setGtToken] = useState('');
  const [gtTokenSaved, setGtTokenSaved] = useState(false);
  const [diag, setDiag] = useState<ConnectionDiagnostics | null>(null);

  /**
   * Connection, credential, agent-configuration staging and verification are
   * the framework's setup flow. The service URL and the staged revision live
   * in the app's existing `goattown/connection` key, and the credential in the
   * key `config/proxies.yml` injects from — both unchanged from before, so an
   * existing install keeps its connection.
   */
  const setup = useSetup({
    agentSlug: DEFAULT_AGENT,
    buildYaml: buildAgentConfigYaml,
    stateKey: 'goattown/connection',
    tokenKey: 'goattownEmbedToken',
  });

  const refreshDiag = useCallback(async () => {
    setDiag(await connectionDiagnostics());
  }, []);

  useEffect(() => {
    // A KV read that fails (store unreachable, unparseable body) must be
    // visible, not an unhandled rejection: showing defaults as if they were
    // the stored settings would be a lie about what the app will use.
    void loadSettings(DEFAULT_SETTINGS)
      .then(setSettings)
      .catch((e: unknown) => setError(`Settings could not be read: ${e instanceof Error ? e.message : String(e)}`));
    void refreshDiag();
  }, [refreshDiag]);

  const handleSaveToken = useCallback(async () => {
    const token = gtToken.trim();
    if (!token) return;
    await setup.saveToken(token);
    setGtToken('');
    setGtTokenSaved(true);
    setTimeout(() => setGtTokenSaved(false), 2000);
    await refreshDiag();
  }, [gtToken, setup, refreshDiag]);

  const handleSave = useCallback(async () => {
    try {
      await saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [settings]);

  return (
    <div style={{ maxWidth: 600 }}>
      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      {saved && <StatusBanner kind="info">Settings saved</StatusBanner>}

      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
        Dataset
      </label>
      <input
        type="text"
        value={settings.dataset}
        onChange={(e) => setSettings({ ...settings, dataset: e.target.value })}
        style={inputStyle}
      />
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 16 }}>
        The Cribl Search dataset to query. Typically "otel" for OpenTelemetry data.
      </p>

      <button onClick={() => void handleSave()} style={buttonStyle}>
        Save
      </button>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--cds-color-border-subtle)' }} />

      <h2 style={{ marginBottom: 12, fontSize: 'var(--cds-font-size-lg)' }}>GoatTown connection</h2>
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 12 }}>
        Server-side investigations run as durable GoatTown sessions. The embed token is stored
        write-only in this app's KV and injected server-side by the fetch proxy — it is never read
        back into the browser. The service host must also be declared in{' '}
        <code>config/proxies.yml</code>.
      </p>

      {setup.error && <StatusBanner kind="error">{setup.error}</StatusBanner>}
      {gtTokenSaved && <StatusBanner kind="info">Embed token saved</StatusBanner>}
      <p style={{ fontSize: 'var(--cds-font-size-sm)', marginBottom: 12 }}>
        <strong>Status:</strong> {STEP_LABEL[setup.step]}
        {diag?.error && <> — key listing failed: {diag.error}</>}
        {diag?.readError && <> — saved connection unreadable: {diag.readError}</>}
      </p>

      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Service URL</label>
      <input
        type="text"
        placeholder="https://goattown-shared.lab.cribl.io"
        value={setup.serviceUrl}
        onChange={(e) => setup.setServiceUrl(e.target.value)}
        style={inputStyle}
      />
      <button
        onClick={() => void setup.saveServiceUrl()}
        disabled={setup.busy}
        style={{ ...buttonStyle, marginBottom: 16 }}
      >
        {setup.busy ? 'Working…' : 'Save service URL'}
      </button>

      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
        Embed token
      </label>
      <input
        type="password"
        placeholder={diag?.tokenKeyExists ? 'Saved — leave blank to keep' : 'GoatTown embed token (bearer credential)'}
        value={gtToken}
        onChange={(e) => setGtToken(e.target.value)}
        autoComplete="off"
        style={inputStyle}
      />
      <button
        onClick={() => void handleSaveToken()}
        disabled={setup.busy || !gtToken.trim()}
        style={{ ...buttonStyle, marginBottom: 16 }}
      >
        Save embed token
      </button>

      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 12 }}>
        Staging this app's agent configuration writes a revision to GoatTown. Activating it is a
        human action in GoatTown's review page — nothing in this app activates anything.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => void setup.stage()} disabled={setup.busy} style={buttonStyle}>
          Stage agent configuration
        </button>
        {setup.scope && (
          <button onClick={() => setup.review()} style={buttonStyle}>
            Review activation
          </button>
        )}
        <button onClick={() => void setup.recheck()} disabled={setup.busy} style={buttonStyle}>
          Re-check
        </button>
      </div>
    </div>
  );
}
