/**
 * Monitor provisioning for the Setup workflow.
 *
 * Mirrors the framework provisioner the APM app binds to
 * (`@criblio/app-utils/provisioner`): a prefix scoping every object we may
 * touch, a dry-run plan, the same create/update/delete/noop vocabulary,
 * one ActionResult per object, and the comparison rule from that module's
 * `isSameAsPlan`/`deepSubset` — never require exact equality with a
 * server-echoed object, or every reconcile sees a diff and re-patches
 * forever. The HTTP client is the framework's, so transport and error
 * shape match.
 *
 * The framework's `reconcile()` itself is bound to saved searches
 * (`/m/default_search/search/saved`, `ProvisionedSearch`), so it cannot
 * provision monitors; the algorithm is mirrored here, not imported.
 *
 * ONE DELIBERATE DIVERGENCE: APM's reconcile deletes `<prefix>*` saved
 * searches that are absent from its plan. App-created monitors absent from
 * the specs are reported as `orphan` and never removed automatically —
 * silently deleting a live alert is not an acceptable side effect of
 * pressing "re-check".
 */

import { createBrowserHttpClient, type HttpClient } from '@criblio/app-utils/provisioner';
import {
  CLEAR_DELAY_SECONDS,
  FIRE_DELAY_SECONDS,
  METRICS_DATASET,
  type AlertSpec,
} from './alertSpecs';

/** Every object this app may create, update or delete starts with this. */
export const UBIQUITI2_PREFIX = 'ubiquiti2__';

/** No group prefix here, unlike anything under /search/. */
export const MONITORS_PATH = '/products/lakehouse_engine_metrics/monitors';

export interface MonitorQuery {
  promql?: string;
  datasetId?: string;
  builder?: {
    metric?: string;
    aggregation?: string;
    groupBy?: string[];
    evaluationWindow?: { value?: number; unit?: string };
  };
}

export interface MonitorThreshold {
  severity?: string;
  limit?: number;
  operator?: string;
}

export interface RemoteMonitor {
  id: string;
  name?: string;
  enabled?: boolean;
  description?: string;
  priority?: { value?: string };
  query?: Record<string, MonitorQuery>;
  firingRule?: { threshold?: MonitorThreshold[] };
}

/** The expression the engine actually evaluates, as stored. */
export function storedPromql(m: RemoteMonitor): string | undefined {
  return m.query?.A?.promql;
}

/** Framework vocabulary: what the reconciler needs to do with one object. */
export type ActionKind = 'create' | 'update' | 'noop';

export interface PlanRow {
  spec: AlertSpec;
  kind: ActionKind;
  /** The id to update: ours, or the hand-made monitor we are adopting. */
  targetId?: string;
  /** Matched by name rather than by our id — a monitor a human made. */
  adopting: boolean;
  /** Human-readable differences, empty when the row matches the plan. */
  drift: string[];
}

export type MonitorSupport = 'supported' | 'unsupported';

export interface Inventory {
  support: MonitorSupport;
  monitors: RemoteMonitor[];
  error?: string;
}

/**
 * A 403 or 404 from this endpoint is a real answer — "this deployment cannot
 * create monitors" — not something to retry, so it becomes `unsupported` and
 * the page degrades to read-only guidance instead of half-applying.
 */
export async function listMonitors(http?: HttpClient): Promise<Inventory> {
  const client = http ?? createBrowserHttpClient();
  try {
    const body = (await client.get(MONITORS_PATH)) as { items?: RemoteMonitor[] };
    return { support: 'supported', monitors: body.items ?? [] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const unsupported = /\((403|404)\)/.test(message);
    return { support: unsupported ? 'unsupported' : 'supported', monitors: [], error: message };
  }
}

/**
 * The observed payload shape, rebuilt from a spec.
 *
 * `id` is omitted for updates so one builder serves create and replace —
 * this sidesteps the open question of whether PATCH is partial or a full
 * replacement, because a full desired document is correct either way.
 */
export function monitorPayload(spec: AlertSpec, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    enabled: true,
    type: 'threshold',
    datasetId: METRICS_DATASET,
    searchMode: 'new',
    priority: { value: spec.priority },
    team: { value: '' },
    metadata: {},
    silence: [],
    notification: { enabled: true, type: 'policy', config: [] },
    query: {
      A: {
        mode: 'builder',
        promql: spec.promql,
        builder: {
          metric: spec.metric,
          labelFilters: [],
          aggregation: spec.aggregation,
          groupBy: spec.groupBy,
          evaluationWindow: { value: spec.windowMinutes, unit: 'm' },
          units: '',
        },
        datasetId: METRICS_DATASET,
      },
    },
    expr: [{ label: 'Alert Query', text: 'A', queryLabels: ['A'], left: 'A' }],
    firingCondition: { fire_delay: FIRE_DELAY_SECONDS, clear_delay: CLEAR_DELAY_SECONDS },
    firingRule: {
      label: 'Alert Query',
      threshold: [
        { severity: 'critical', limit: spec.limit, includedTags: [], excludedTags: [], operator: spec.operator, timesTriggered: 1 },
        { severity: 'warning', limit: 0, includedTags: [], excludedTags: [], operator: 'gt', timesTriggered: 2 },
        { severity: 'info', limit: 0, includedTags: [], excludedTags: [], operator: 'gt', timesTriggered: 5 },
      ],
    },
  };
  if (id) payload.id = id;
  return payload;
}

/**
 * Compare the specs against what exists. Pure — no writes, no side effects —
 * so it is safe to run on every render.
 *
 * Only fields the plan sets are compared, on purpose: the server fills in
 * `user`, `createdAt` and friends, and returning them must not count as drift.
 */
export function planRows(specs: AlertSpec[], monitors: RemoteMonitor[]): PlanRow[] {
  return specs.map((spec) => {
    const byId = monitors.find((m) => m.id === spec.id);
    const byName = monitors.find((m) => (m.name ?? '') === spec.name);
    const target = byId ?? byName;
    if (!target) return { spec, kind: 'create', adopting: false, drift: [] };

    const drift: string[] = [];
    const promql = storedPromql(target);
    if (promql !== spec.promql) drift.push(`expression → ${spec.promql}`);

    const crit = target.firingRule?.threshold?.find((t) => t.severity === 'critical');
    if (crit?.operator !== spec.operator || Number(crit?.limit) !== spec.limit) {
      drift.push(`condition → ${spec.operator} ${spec.limit}`);
    }
    if ((target.priority?.value ?? '') !== spec.priority) {
      drift.push(`priority ${target.priority?.value ?? 'none'} → ${spec.priority}`);
    }
    if (target.enabled !== true) drift.push('disabled → enabled');

    return {
      spec,
      kind: drift.length ? 'update' : 'noop',
      targetId: target.id,
      adopting: !byId && Boolean(byName),
      drift,
    };
  });
}

/** Monitors this app does not manage at all — shown, never touched. */
export function foreignMonitors(monitors: RemoteMonitor[], specs: AlertSpec[]): RemoteMonitor[] {
  const ourIds = new Set(specs.map((s) => s.id));
  const ourNames = new Set(specs.map((s) => s.name));
  return monitors.filter((m) => !ourIds.has(m.id) && !ourNames.has(m.name ?? ''));
}

/**
 * Monitors carrying our prefix that the specs no longer describe. Reported so
 * a dropped spec is visible, never deleted automatically.
 */
export function orphanMonitors(monitors: RemoteMonitor[], specs: AlertSpec[]): RemoteMonitor[] {
  const ourIds = new Set(specs.map((s) => s.id));
  return monitors.filter((m) => m.id.startsWith(UBIQUITI2_PREFIX) && !ourIds.has(m.id));
}

/** Apply one row. Create when absent, replace when drifted. Never deletes. */
export async function applyRow(row: PlanRow, http?: HttpClient): Promise<string> {
  if (row.kind === 'noop') return 'already up to date';
  const client = http ?? createBrowserHttpClient();
  if (row.kind === 'create') {
    if (!row.spec.id.startsWith(UBIQUITI2_PREFIX)) {
      // The prefix is what bounds this app's blast radius; refuse rather than
      // create an object we could never safely reconcile or remove.
      throw new Error(`refusing to create ${row.spec.id}: id must start with ${UBIQUITI2_PREFIX}`);
    }
    await client.post(MONITORS_PATH, monitorPayload(row.spec, row.spec.id));
    return 'created';
  }
  if (!row.targetId) throw new Error('no target id to update');
  await client.patch(`${MONITORS_PATH}/${encodeURIComponent(row.targetId)}`, monitorPayload(row.spec));
  return row.adopting ? 'updated (adopted)' : 'updated';
}