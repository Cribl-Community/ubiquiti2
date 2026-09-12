import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import { ALERT_SPECS } from '../api/alertSpecs';
import { clearMetricsFailure, lastMetricsFailure, queryMetric } from '../api/metrics';
import {
  applyRow,
  foreignMonitors,
  listMonitors,
  orphanMonitors,
  planRows,
  storedPromql,
  type Inventory,
  type PlanRow,
} from '../api/monitors';

interface MetricsProbe {
  devices: number;
  /** Age of the newest unpoller sample, in seconds. Null when nothing returned. */
  ageSeconds: number | null;
  failed: boolean;
}

interface TargetsProbe {
  count: number | null;
  error?: string;
}

const apiUrl = (): string => window.CRIBL_API_URL ?? '/api/v1';

const MUTED = 'var(--cds-color-fg-muted)';
const SMALL = 'var(--cds-font-size-sm)';

function Row({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  const color = ok === null ? MUTED : ok ? 'var(--cds-color-success, #2e7d32)' : 'var(--cds-color-danger, #c62828)';
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--cds-color-border-subtle)' }}>
      <span style={{ minWidth: 200, fontWeight: 600 }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function stateLabel(row: PlanRow): string {
  if (row.kind === 'create') return 'not created';
  if (row.kind === 'noop') return 'up to date';
  return 'needs update';
}

function stateColor(row: PlanRow): string {
  if (row.kind === 'create') return 'var(--cds-color-danger, #c62828)';
  if (row.kind === 'noop') return 'var(--cds-color-success, #2e7d32)';
  return 'var(--cds-color-warning, #ed6c02)';
}

export default function SetupPage() {
  const [inventory, setInventory] = useState<Inventory>({ support: 'supported', monitors: [] });
  const [metrics, setMetrics] = useState<MetricsProbe | null>(null);
  const [targets, setTargets] = useState<TargetsProbe>({ count: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // The checks are read-only, so they run on load. Nothing is written without
  // a click on Apply.
  const probeMetrics = useCallback(async () => {
    clearMetricsFailure();
    const counts = await queryMetric('count(unpoller_device_uptime_seconds)');
    const failed = lastMetricsFailure() !== null;
    const samples = await queryMetric('unpoller_device_uptime_seconds');
    const newest = samples.reduce((acc, p) => Math.max(acc, p.time ?? 0), 0);
    setMetrics({
      devices: counts.at(-1)?.value ?? 0,
      ageSeconds: newest ? Math.max(0, Math.round(Date.now() / 1000 - newest)) : null,
      failed,
    });
  }, []);

  const probeTargets = useCallback(async () => {
    try {
      const resp = await fetch(`${apiUrl()}/notification-targets`);
      if (!resp.ok) {
        setTargets({ count: null, error: `HTTP ${resp.status}` });
        return;
      }
      const body = (await resp.json()) as { items?: unknown[] };
      setTargets({ count: body.items?.length ?? 0 });
    } catch (e) {
      setTargets({ count: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const loadMonitors = useCallback(async () => {
    setInventory(await listMonitors());
  }, []);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadMonitors(), probeMetrics(), probeTargets()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadMonitors, probeMetrics, probeTargets]);

  useEffect(() => {
    void (async () => {
      await reload();
      setLoading(false);
    })();
  }, [reload]);

  const rows = planRows(ALERT_SPECS, inventory.monitors);
  const foreign = foreignMonitors(inventory.monitors, ALERT_SPECS);
  const orphans = orphanMonitors(inventory.monitors, ALERT_SPECS);
  const pending = rows.filter((r) => r.kind !== 'noop');
  // What is actually stored, so the table shows reality rather than intent.
  const storedById = new Map(inventory.monitors.map((m) => [m.id, storedPromql(m) ?? '(none)']));

  // Deliberately NOT memoized: this runs only from a click, and the React
  // Compiler rule (react-hooks/preserve-manual-memoization) cannot preserve a
  // useCallback whose dependency is a freshly computed array plus an object
  // mutated across awaits. Local checks don't run that rule; CI does.
  const apply = async () => {
    setApplying(true);
    setError(null);
    const done: Record<string, string> = {};
    // Sequential and independent: one failure never aborts the rest.
    for (const row of pending) {
      try {
        done[row.spec.id] = await applyRow(row);
      } catch (e) {
        done[row.spec.id] = `failed — ${e instanceof Error ? e.message : String(e)}`;
      }
      setResults({ ...done });
    }
    setApplying(false);
    // Re-read so the table shows what was actually stored, not what we sent.
    await reload();
  };

  if (loading) {
    return (
      <div style={{ maxWidth: 860 }}>
        <h1 style={{ marginBottom: 16 }}>Setup</h1>
        <p style={{ color: MUTED, fontSize: SMALL }}>Checking what already exists…</p>
      </div>
    );
  }

  const metricsOk = metrics ? !metrics.failed && metrics.devices > 0 : null;
  const stale = metrics?.ageSeconds != null && metrics.ageSeconds > 300;

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ marginBottom: 8 }}>Setup</h1>
      <p style={{ color: MUTED, fontSize: SMALL, marginBottom: 16 }}>
        Checks what exists in this workspace and creates only what is missing. Alerts are monitored
        directly on the unpoller metrics already arriving here — no saved searches, no derived metrics.
        {' '}Re-run any time: matching alerts are left alone.
      </p>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      {inventory.error && <StatusBanner kind="error">Monitor API: {inventory.error}</StatusBanner>}
      {refreshing && !applying && <StatusBanner kind="info">Re-checking…</StatusBanner>}
      {applying && <StatusBanner kind="info">Applying changes…</StatusBanner>}

      <h2 style={{ fontSize: 'var(--cds-font-size-lg)', margin: '16px 0 8px' }}>Preconditions</h2>
      <div style={{ marginBottom: 16 }}>
        <Row
          label="unpoller metrics"
          value={
            metrics === null
              ? 'unknown'
              : metrics.failed
                ? 'query failed — the metrics dataset did not answer'
                : metricsOk
                  ? `${metrics.devices} devices reporting${metrics.ageSeconds != null ? `, newest sample ${metrics.ageSeconds}s old` : ''}`
                  : 'no unpoller series returned'
          }
          ok={metricsOk}
        />
        {stale && (
          <p style={{ color: 'var(--cds-color-warning, #ed6c02)', fontSize: SMALL, marginTop: 6 }}>
            Newest sample is older than five minutes — unpoller may have stopped scraping. Alerts built on
            it would fire on stale data.
          </p>
        )}
        <Row
          label="Notification targets"
          value={
            targets.count == null
              ? `unavailable${targets.error ? ` (${targets.error})` : ''}`
              : targets.count === 0
                ? 'none configured — monitors use default policy routing'
                : `${targets.count} configured`
          }
          ok={null}
        />
        <Row label="Log dataset" value='"main" — used by Events, Investigations and detail pages' ok={null} />
        <Row
          label="GoatTown agent"
          value="declared in goattown.config.yaml; activation is an admin action, so this app does not claim to verify it"
          ok={null}
        />
      </div>

      <h2 style={{ fontSize: 'var(--cds-font-size-lg)', margin: '24px 0 8px' }}>
        Alerts <span style={{ color: MUTED, fontWeight: 400, fontSize: SMALL }}>({ALERT_SPECS.length})</span>
      </h2>
      {rows.map((row) => (
        <div
          key={row.spec.id}
          style={{
            border: '1px solid var(--cds-color-border-subtle)',
            borderRadius: 'var(--cds-radius-md)',
            padding: 12,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
            <strong>{row.spec.name}</strong>
            <span style={{ color: stateColor(row), fontSize: SMALL, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {row.spec.priority} · {stateLabel(row)}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--cds-font-family-mono)', fontSize: SMALL, marginTop: 4 }}>{row.spec.condition}</div>
          {row.drift.length > 0 && (
            <ul style={{ color: 'var(--cds-color-warning, #ed6c02)', fontSize: SMALL, margin: '6px 0 0 16px' }}>
              {row.drift.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {row.adopting && (
            <p style={{ color: MUTED, fontSize: SMALL, margin: '6px 0 0' }}>
              Matched by name, not by our id ({row.targetId}) — updating in place rather than duplicating.
            </p>
          )}
          {row.kind !== 'create' && row.targetId && (
            <p style={{ color: MUTED, fontSize: SMALL, margin: '6px 0 0' }}>
              stored expression: <code>{storedById.get(row.targetId) ?? '(not found)'}</code>
            </p>
          )}
          {results[row.spec.id] && (
            <p style={{ color: MUTED, fontSize: SMALL, margin: '6px 0 0' }}>→ {results[row.spec.id]}</p>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
        <button
          onClick={() => void apply()}
          disabled={applying || inventory.support === 'unsupported' || pending.length === 0}
          style={{
            padding: '8px 20px',
            background: 'var(--cds-color-primary)',
            color: 'var(--cds-color-primary-fg)',
            border: 'none',
            borderRadius: 'var(--cds-radius-md)',
            fontWeight: 600,
            opacity: applying || inventory.support === 'unsupported' || pending.length === 0 ? 0.5 : 1,
          }}
        >
          {applying ? 'Applying…' : pending.length === 0 ? 'Nothing to apply' : `Create / update ${pending.length}`}
        </button>
        <button
          onClick={() => void reload()}
          disabled={refreshing}
          style={{
            padding: '8px 20px',
            background: 'transparent',
            color: 'var(--cds-color-fg)',
            border: '1px solid var(--cds-color-border)',
            borderRadius: 'var(--cds-radius-md)',
            fontWeight: 600,
          }}
        >
          Re-check
        </button>
      </div>

      {inventory.support === 'unsupported' && (
        <p style={{ color: MUTED, fontSize: SMALL, marginTop: 12 }}>
          This deployment refused the monitors API, so alerts cannot be provisioned from here. The conditions
          above still work as manual PromQL in the native Alerts UI.
        </p>
      )}

      {orphans.length > 0 && (
        <>
          <h2 style={{ fontSize: 'var(--cds-font-size-lg)', margin: '24px 0 8px' }}>Created by this app, no longer in the specs</h2>
          <p style={{ color: MUTED, fontSize: SMALL, marginBottom: 8 }}>
            These carry this app's prefix but no spec describes them — an alert that was dropped from the
            set. Left alone deliberately: silently deleting a live alert is not a safe side effect of
            re-checking. Remove them in the native Alerts UI if they are genuinely unwanted.
          </p>
          {orphans.map((m) => (
            <div key={m.id} style={{ fontSize: SMALL, color: MUTED, padding: '2px 0' }}>
              <code>{m.id}</code> — {m.name ?? '(unnamed)'}
            </div>
          ))}
        </>
      )}

      {foreign.length > 0 && (
        <>
          <h2 style={{ fontSize: 'var(--cds-font-size-lg)', margin: '24px 0 8px' }}>Other monitors</h2>
          <p style={{ color: MUTED, fontSize: SMALL, marginBottom: 8 }}>
            Not managed by this app. Never modified or deleted.
          </p>
          {foreign.map((m) => (
            <div key={m.id} style={{ fontSize: SMALL, color: MUTED, padding: '2px 0' }}>
              <code>{m.id}</code> — {m.name ?? '(unnamed)'}
            </div>
          ))}
        </>
      )}

      <h2 style={{ fontSize: 'var(--cds-font-size-lg)', margin: '24px 0 8px' }}>Manual steps</h2>
      <ul style={{ color: MUTED, fontSize: SMALL, marginLeft: 16 }}>
        <li>
          Activate the app's GoatTown revision after changes to <code>goattown.config.yaml</code> — that is
          what publishes the investigator agent, the read-only profile and the playbook skill.
        </li>
        <li>
          Auto-investigation schedules ship <strong>disabled</strong>. Enable them once one interactive
          investigation has been confirmed to read sensibly, so alerts do not burn model calls unattended.
        </li>
      </ul>
    </div>
  );
}
