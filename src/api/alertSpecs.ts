/**
 * The network alerts, as data — the single source of truth for the Setup
 * workflow and for anything that wants to describe an alert.
 *
 * Why this file exists: the monitor payload shape is NOT discoverable from
 * the Cribl API spec. `expr`, `firingCondition`, `firingRule`, `notification`
 * and `priority` all describe as `oneOf` nulls there. The shape below was
 * read back off a monitor created by hand in the Search UI, so treat it as
 * observed rather than designed — `sum(sum(x))` in `query.A.promql` was the
 * UI composing its own aggregation, which is the tell.
 *
 * Adding an alert: add a spec here. Nothing else needs to change; the Setup
 * page inventories, creates and updates from this list.
 */

/** Dataset holding the unpoller_* series. Not every workspace calls it this. */
export const METRICS_DATASET = 'metrics';

/** Sustained-breach and clear delays, in seconds, as the UI defaults them. */
export const FIRE_DELAY_SECONDS = 300;
export const CLEAR_DELAY_SECONDS = 600;

export type AlertOperator = 'lt' | 'gt';
export type AlertPriority = 'P1' | 'P2' | 'P3';

export interface AlertSpec {
  /** Managed id. App-prefixed so our monitors stay distinguishable. */
  id: string;
  /** Matched exactly when adopting a monitor a human made in the UI. */
  name: string;
  /** The condition in plain words, for the setup UI. */
  condition: string;
  /** Written into the monitor. Carries the trap that makes the alert correct. */
  description: string;
  /** The expression the engine evaluates. */
  promql: string;
  /** The bare metric, for the builder half of the payload. */
  metric: string;
  aggregation: string;
  groupBy: string[];
  windowMinutes: number;
  operator: AlertOperator;
  limit: number;
  priority: AlertPriority;
}

export const ALERT_SPECS: AlertSpec[] = [
  {
    id: 'ubiquiti2__internet_down',
    name: 'Ubiquiti Internet Down',
    condition: 'sum(unpoller_wan_interface_state) < 1',
    description:
      'Every WAN interface is down. A standby WAN legitimately reports 0 — Internet 2 sits at BACKUP ' +
      'on this network — so only the sum across interfaces is an outage test. Per-interface would fire ' +
      'permanently. Data: unpoller_wan_interface_state{wan_interface,wan_networkgroup,state}.',
    promql: 'sum(unpoller_wan_interface_state)',
    metric: 'unpoller_wan_interface_state',
    aggregation: 'sum',
    groupBy: [],
    windowMinutes: 5,
    operator: 'lt',
    limit: 1,
    priority: 'P1',
  },
  {
    id: 'ubiquiti2__mesh_backhaul_down',
    name: 'Ubiquiti Mesh Backhaul Down',
    condition: 'sum by (name) (unpoller_device_uplink_up{uplink_type="wireless"}) < 1',
    description:
      'A meshed AP has no wireless uplink left. An AP may hold two vwiresta links (AP Family Room 7 had ' +
      'vwiresta12 and vwiresta13), so one link dropping is not an orphaned AP. Device backhaul only: ' +
      'topology_link WIRELESS edges are client associations and are not this.',
    promql: 'sum by (name) (unpoller_device_uplink_up{uplink_type="wireless"})',
    metric: 'unpoller_device_uplink_up',
    aggregation: 'sum',
    groupBy: ['name'],
    windowMinutes: 5,
    operator: 'lt',
    limit: 1,
    priority: 'P1',
  },
  {
    id: 'ubiquiti2__device_offline',
    name: 'Ubiquiti Device Offline',
    condition: 'count(unpoller_device_uptime_seconds) < 16',
    description:
      'Fewer devices are reporting than the fleet baseline. unpoller_device_uptime_seconds has one series ' +
      'per device and the baseline here is 16. Raise the limit when hardware is added. Identify which ' +
      'device stopped reporting before assuming an outage.',
    promql: 'count(unpoller_device_uptime_seconds)',
    metric: 'unpoller_device_uptime_seconds',
    aggregation: 'count',
    groupBy: [],
    windowMinutes: 5,
    operator: 'lt',
    limit: 16,
    priority: 'P1',
  },
  {
    id: 'ubiquiti2__uplink_errors',
    name: 'Ubiquiti Uplink Errors',
    condition: 'sum by (name, port_name) (rate(receive_errors_total[10m]) + rate(receive_dropped_total[10m])) > 1',
    description:
      'Sustained receive errors or drops on a switch port. Worst observed rate on this network is about ' +
      '0.35/s (Sharp - Los Gatos Port 1), so 1/s sustained points at a failing cable or SFP rather than ' +
      'normal noise. Identify the port and the device behind it.',
    promql:
      'sum by (name, port_name) (rate(unpoller_device_port_receive_errors_total[10m]) + ' +
      'rate(unpoller_device_port_receive_dropped_total[10m]))',
    metric: 'unpoller_device_port_receive_errors_total',
    aggregation: 'sum',
    groupBy: ['name', 'port_name'],
    windowMinutes: 10,
    operator: 'gt',
    limit: 1,
    priority: 'P1',
  },
  {
    id: 'ubiquiti2__dhcp_pool_exhausted',
    name: 'Ubiquiti DHCP Pool Exhausted',
    condition: 'min(unpoller_dhcp_free_percent) < 10',
    description:
      'A DHCP pool is nearly full. At build time the Default pool had 65% free and Servers 100%, so there ' +
      'is large headroom and this fires only as a pool genuinely fills. Name which network and how fast.',
    promql: 'min(unpoller_dhcp_free_percent)',
    metric: 'unpoller_dhcp_free_percent',
    aggregation: 'min',
    groupBy: [],
    windowMinutes: 5,
    operator: 'lt',
    limit: 10,
    priority: 'P1',
  },
];
