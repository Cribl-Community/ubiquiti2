import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import {
  DEFAULT_AGENT,
  connectionDiagnostics,
  loadConnection,
  loadMeshLinksText,
  saveConnection,
  saveEmbedToken,
  saveMeshLinksText,
  type ConnectionDiagnostics,
} from '../api/goattown';

interface AppSettings {
  dataset: string;
}

const DEFAULT_SETTINGS: AppSettings = { dataset: 'otel' };

function apiUrl(): string {
  return window.CRIBL_API_URL ?? '/api/v1';
}

function kvUrl(key: string): string {
  const appId = window.CRIBL_APP_ID ?? '';
  return `${apiUrl()}/kvstore/${appId}/${key}`;
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const resp = await fetch(kvUrl('settings'));
    if (!resp.ok) return { ...DEFAULT_SETTINGS };
    const text = await resp.text();
    return JSON.parse(text) as AppSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch(kvUrl('settings'), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(settings),
  });
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [gtServiceUrl, setGtServiceUrl] = useState('');
  const [gtAgent, setGtAgent] = useState(DEFAULT_AGENT);
  const [gtSaved, setGtSaved] = useState(false);
  const [gtError, setGtError] = useState<string | null>(null);
  const [gtToken, setGtToken] = useState('');
  const [diag, setDiag] = useState<ConnectionDiagnostics | null>(null);

  const [meshText, setMeshText] = useState('');
  const [meshSaved, setMeshSaved] = useState(false);
  const [meshError, setMeshError] = useState<string | null>(null);

  const refreshDiag = useCallback(async () => {
    setDiag(await connectionDiagnostics());
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadConnection().then((conn) => {
      if (conn) {
        setGtServiceUrl(conn.serviceUrl);
        setGtAgent(conn.agent);
      }
    });
    void loadMeshLinksText().then((t) => setMeshText(t ?? ''));
    void refreshDiag();
  }, [refreshDiag]);

  // One save for the whole section. The token is written only when a
  // new one was typed (it is write-only and never prefilled); the
  // connection record is written only when a URL is present, so a
  // token-only save can never clobber the saved URL with an empty one.
  const handleSaveGoatTown = useCallback(async () => {
    setGtError(null);
    const url = gtServiceUrl.trim();
    const hasToken = gtToken.trim().length > 0;
    try {
      if (!url && !hasToken) {
        setGtError('Nothing to save — enter a service URL and/or an embed token.');
        return;
      }
      if (hasToken) {
        await saveEmbedToken(gtToken);
        setGtToken('');
      }
      if (url) await saveConnection(url, gtAgent);
      setGtSaved(true);
      setTimeout(() => setGtSaved(false), 2000);
      await refreshDiag();
    } catch (e) {
      setGtError(e instanceof Error ? e.message : String(e));
    }
  }, [gtServiceUrl, gtAgent, gtToken, refreshDiag]);

  const handleSave = useCallback(async () => {
    try {
      await saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [settings]);

  const handleSaveMesh = useCallback(async () => {
    setMeshError(null);
    try {
      await saveMeshLinksText(meshText);
      setMeshSaved(true);
      setTimeout(() => setMeshSaved(false), 2000);
    } catch (e) {
      setMeshError(e instanceof Error ? e.message : String(e));
    }
  }, [meshText]);

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ marginBottom: 16 }}>Settings</h1>
      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      {saved && <StatusBanner kind="info">Settings saved</StatusBanner>}

      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
        Dataset
      </label>
      <input
        type="text"
        value={settings.dataset}
        onChange={(e) => setSettings({ ...settings, dataset: e.target.value })}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          marginBottom: 16,
        }}
      />
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 16 }}>
        The Cribl Search dataset to query. Typically "otel" for OpenTelemetry data.
      </p>

      <button
        onClick={() => void handleSave()}
        style={{
          padding: '8px 20px',
          background: 'var(--cds-color-primary)',
          color: 'var(--cds-color-primary-fg)',
          border: 'none',
          borderRadius: 'var(--cds-radius-md)',
          fontWeight: 600,
        }}
      >
        Save
      </button>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--cds-color-border-subtle)' }} />

      <h2 style={{ marginBottom: 12, fontSize: 'var(--cds-font-size-lg)' }}>Network map — mesh backhaul</h2>
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 12 }}>
        Mesh parents are drawn automatically from unpoller's topology metrics (WIRELESS links
        whose ends are both known devices). Any entry here overrides the feed. One link per
        line: <code>child AP = parent AP</code>. APs appear once they report clients or device
        info; names must match the controller exactly.
      </p>
      {meshError && <StatusBanner kind="error">{meshError}</StatusBanner>}
      {meshSaved && <StatusBanner kind="info">Mesh backhaul saved — refresh the map to see it</StatusBanner>}
      <textarea
        rows={4}
        placeholder={'AP Living Room 7 = AP Office 7\nAP Family Room 7 = AP Office 7'}
        value={meshText}
        onChange={(e) => setMeshText(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          fontFamily: 'var(--cds-font-family-mono)',
          fontSize: 'var(--cds-font-size-sm)',
          marginBottom: 12,
        }}
      />
      <button
        onClick={() => void handleSaveMesh()}
        style={{
          padding: '8px 20px',
          background: 'var(--cds-color-primary)',
          color: 'var(--cds-color-primary-fg)',
          border: 'none',
          borderRadius: 'var(--cds-radius-md)',
          fontWeight: 600,
        }}
      >
        Save mesh backhaul
      </button>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--cds-color-border-subtle)' }} />

      <h2 style={{ marginBottom: 12, fontSize: 'var(--cds-font-size-lg)' }}>GoatTown connection</h2>
      <p style={{ fontSize: 'var(--cds-font-size-sm)', color: 'var(--cds-color-fg-muted)', marginBottom: 12 }}>
        Server-side investigations run as durable GoatTown sessions. The embed token is stored
        write-only in this app's KV and injected server-side by the fetch proxy — it is never read
        back into the browser. The service host must also be declared in{' '}
        <code>config/proxies.yml</code>.
      </p>
      {gtError && <StatusBanner kind="error">{gtError}</StatusBanner>}
      {gtSaved && <StatusBanner kind="info">GoatTown settings saved</StatusBanner>}
      {diag && (
        <p style={{ fontSize: 'var(--cds-font-size-sm)', marginBottom: 12 }}>
          <strong>App KV:</strong>{' '}
          <code>goattown/connection</code>{' '}
          {diag.connectionKeyExists === null ? 'unknown' : diag.connectionKeyExists ? '✓ saved' : '✗ missing'}
          {' · '}
          <code>goattownEmbedToken</code>{' '}
          {diag.tokenKeyExists === null ? 'unknown' : diag.tokenKeyExists ? '✓ saved' : '✗ missing'}
          {diag.error && <> — {diag.error}</>}
          {diag.connection && <> — service {diag.connection.serviceUrl} (agent {diag.connection.agent})</>}
          {diag.connectionKeyExists && !diag.connection && diag.rawRead && (
            <> — unreadable: HTTP {diag.rawRead.status}
              {diag.rawRead.parseError ? `, ${diag.rawRead.parseError}` : ''}
              {diag.rawRead.body ? `, body: ${diag.rawRead.body.slice(0, 100)}` : ''}</>
          )}
        </p>
      )}
      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Service URL</label>
      <input
        type="text"
        placeholder="https://goattown-shared.lab.cribl.io"
        value={gtServiceUrl}
        onChange={(e) => setGtServiceUrl(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          marginBottom: 12,
        }}
      />
      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Agent</label>
      <input
        type="text"
        value={gtAgent}
        onChange={(e) => setGtAgent(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          marginBottom: 16,
        }}
      />
      <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Embed token</label>
      <input
        type="password"
        placeholder={diag?.tokenKeyExists ? 'Saved — leave blank to keep' : 'GoatTown embed token (bearer credential)'}
        value={gtToken}
        onChange={(e) => setGtToken(e.target.value)}
        autoComplete="off"
        style={{
          width: '100%',
          padding: '8px 12px',
          border: '1px solid var(--cds-color-border)',
          borderRadius: 'var(--cds-radius-md)',
          marginBottom: 16,
        }}
      />
      <button
        onClick={() => void handleSaveGoatTown()}
        style={{
          padding: '8px 20px',
          background: 'var(--cds-color-primary)',
          color: 'var(--cds-color-primary-fg)',
          border: 'none',
          borderRadius: 'var(--cds-radius-md)',
          fontWeight: 600,
        }}
      >
        Save GoatTown settings
      </button>
    </div>
  );
}
