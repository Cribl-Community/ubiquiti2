/**
 * App-facing metrics helpers — a thin delegation to the framework's
 * published metrics client (@criblio/app-utils/metrics). The fetch,
 * NDJSON parsing, job-status checking, and error shaping all live in
 * the framework so every app picks up its fixes; this module only
 * adapts the framework's MetricSample/MetricSeries shapes to the
 * flat MetricPoint the app's routes consume.
 *
 * Imported by SUBPATH, not from the package root — see the note in
 * cribl.ts for why the package root breaks the browser build.
 *
 * The cached* variants dedupe in-flight GETs and keep results for 12s:
 * the pages refire the same queries on every mount/nav/refresh, and the
 * metrics engine keeps computing a query even after the browser stops
 * reading it, so repeat identical reads are cheaper than fresh ones.
 */
import {
  cachedQueryInstant,
  cachedQueryRange,
  type MetricSample,
} from '@criblio/app-utils/metrics';

// The app-preview harness proxies every fetch the app makes and rejects
// new requests while one is still in flight ("Preview is busy. Wait for
// its current requests or Search jobs to finish.") — a page fanning out a
// dozen metrics GETs at once therefore self-rejects. Serialize the reads:
// at most one metrics request in flight. The framework's short-TTL cache
// absorbs the repeat navigations that would otherwise make serial latency
// painful. (Installed apps have no such gate; serializing is harmless
// there — the fan-out is just ordered instead of parallel.)
let tail: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = tail.then(run, run);
  tail = result.catch(() => undefined);
  return result;
}

/**
 * Failures used to vanish into `.catch(() => undefined)` and render as
 * plain empty states. Record the most recent failure (with the exact
 * PromQL and the framework's error message) and broadcast it so pages
 * can show a real error instead of silent emptiness.
 */
export interface MetricsFailure {
  query: string;
  message: string;
  at: number;
}
export const METRICS_ERROR_EVENT = 'ubiquiti2:metrics-error';
let lastFailure: MetricsFailure | null = null;

export function lastMetricsFailure(): MetricsFailure | null {
  return lastFailure;
}

export function clearMetricsFailure(): void {
  lastFailure = null;
}

function recordFailure(query: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  lastFailure = { query, message, at: Date.now() };
  console.error('[metrics]', query, '→', message);
  try {
    window.dispatchEvent(new CustomEvent(METRICS_ERROR_EVENT, { detail: lastFailure }));
  } catch { /* non-browser harness */ }
}

export interface MetricPoint {
  value: number;
  time?: number;
  /** Labels returned by grouped PromQL results (for example name/port_name). */
  labels?: Record<string, string>;
}

function toPoint(sample: MetricSample): MetricPoint {
  return { value: sample._value, time: sample._time, labels: sample.labels };
}

export async function queryMetric(query: string, step?: number, earliest = '-1h'): Promise<MetricPoint[]> {
  try {
    if (step) {
      // Range query: one sample per step per series, grouped by label set.
      // Flattened back to the app's flat MetricPoint rows (time-sorted).
      const series = await oneAtATime(() => cachedQueryRange(query, { earliest, step }));
      return series.flatMap((sr) => sr.points.map((p) => ({ value: p.v, time: p.t, labels: sr.labels })));
    }
    // Instant query: single sample per series at `latest`.
    const samples = await oneAtATime(() => cachedQueryInstant(query, { earliest, latest: 'now' }));
    return samples.map(toPoint);
  } catch (err) {
    recordFailure(query, err);
    return [];
  }
}

export async function latestMetric(query: string, fallback: number): Promise<number> {
  try {
    const points = await queryMetric(query);
    return points.at(-1)?.value ?? fallback;
  } catch { return fallback; }
}

/**
 * Device backhaul edges from the PATCHED unpoller build (branches
 * export-uplink-topology / uplink-parent-fields). These metrics do NOT
 * exist in upstream unpoller — if the container is rebuilt from
 * ghcr.io/unpoller/unpoller they disappear and the map loses mesh edges
 * (the KV mesh-config override in Settings remains the fallback).
 *
 * `unpoller_device_uplink_info` carries one series per device uplink; the
 * labels are the payload (value is a constant 1 — never filter on it):
 *   name          = child device
 *   uplink_device = PARENT device name (sent by the controller, no join)
 *   uplink_mac    = parent MAC
 *   uplink_type   = "wire" | "wireless"
 *   uplink_name   = child interface ("eth0", "vwiresta12" on mesh links)
 * Mesh backhaul = uplink_type="wireless". Rates: tx/rx_rate are populated
 * on wireless (zero on wired); bytes-rate the reverse. Units are the
 * controller's own — do not compare across the two families.
 */
export interface MeshEdge {
  childName: string;
  parentName: string;
  parentMac: string;
  iface: string;
  rate: number;
}

/**
 * Devices acting as access points, scoped for label-filtered queries.
 * UniFi reports Dream-Machine-AP-class hardware (model UDMA*, e.g.
 * UDMA69B) as type="udm", so type="uap" alone misses 9 of this network's
 * APs. Device metrics carry no model label, and this metrics store has no
 * vector `or` — so AP-only scoping multiplies by the device_info series
 * filtered to AP models (its value is a constant 1; labels are payload).
 * `extra` adds label matchers, e.g. apScoped('unpoller_device_stations', `name="${ap}"`).
 */
export function apScoped(metric: string, extra = ''): string {
  const matchers = extra ? `type=~"uap|udm",${extra}` : 'type=~"uap|udm"';
  return `${metric}{${matchers}} * on (name) group_left() unpoller_device_info{model=~"UAP.*|UDMA.*|UK.*"}`;
}

/** Gateway-only scoping: type="udm" MINUS the Dream-Machine-AP-class
 *  devices (negative model match), so gateway KPIs don't aggregate the 9
 *  UDMA APs. Same join trick as apScoped — no vector `or` in this store. */
export function gatewayScoped(metric: string, extra = ''): string {
  const matchers = extra ? `type="udm",${extra}` : 'type="udm"';
  return `${metric}{${matchers}} * on (name) group_left() unpoller_device_info{model!~"UAP.*|UDMA.*|UK.*"}`;
}

export const MESH_EDGES_QUERY =
  'max by (name, uplink_device, uplink_mac, uplink_name) (unpoller_device_uplink_info{uplink_type="wireless"})';

const MESH_RATE_QUERY =
  'max by (name) (unpoller_device_uplink_tx_rate) + on (name) group_left() max by (name) (unpoller_device_uplink_rx_rate)';

export async function queryMeshEdges(): Promise<MeshEdge[]> {
  const [edges, rates] = await Promise.all([
    queryMetric(MESH_EDGES_QUERY),
    queryMetric(MESH_RATE_QUERY),
  ]);
  const rateByName = new Map(rates.map((p) => [p.labels?.name, p.value]).filter(([n]) => Boolean(n)) as Array<[string, number]>);
  return edges.flatMap((p) => {
    const childName = p.labels?.name;
    const parentName = p.labels?.uplink_device;
    const parentMac = p.labels?.uplink_mac;
    if (!childName || !parentName) return [];
    return [{
      childName,
      parentName,
      parentMac,
      iface: p.labels?.uplink_name ?? '',
      rate: rateByName.get(childName) ?? 0,
    }];
  });
}
