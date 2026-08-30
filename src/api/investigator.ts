/**
 * Network Investigator wiring — everything the framework's
 * InvestigatorChat needs that is specific to this Ubiquiti app:
 * the advertised tools, the seed prompt (data map + rules),
 * the request context, and the tool executors.
 *
 * The agent endpoint is Cribl's own /ai/q/agents/local_search; the
 * loop, transcript, approvals, summary scorecard, and PNG export all
 * live in @criblio/app-utils/investigator. No external backend — the
 * original app polled a server-side investigation service, this one
 * drives the same agent loop from the browser.
 */
import { runQuery } from './cribl';
import { configureAgent, type AgentContext, type AgentToolDefinition } from '../vendor/agent';
import {
  runSearchDefinition,
  runMetricsQueryDefinition,
} from '../vendor/agent-tool-defs';
import {
  createRunSearchTool,
  createRunMetricsQueryTool,
  executeCommonToolCall,
  type ToolCallInvocation,
  type ToolExecutionResult,
} from '../vendor/agent-tools';
import { assertReadOnlyKql } from '../vendor/kql';
import { createMetricsCatalog, type CatalogTransport } from '../vendor/metrics-catalog';

configureAgent({ surface: 'ubiquiti2NetworkInvestigator' });

const apiUrl = () => window.CRIBL_API_URL ?? '/api/v1';

/** The dataset the log half of an investigation is scoped to. */
export const INVESTIGATION_DATASET = 'main';

/** The closing scorecard. Without this in the advertised set the
 *  agent cannot call the tool and falls back to dumping markdown as
 *  a plain assistant message — which renders without the card. */
const presentSummaryDefinition: AgentToolDefinition = {
  id: 'present_investigation_summary',
  description:
    'Present the final investigation scorecard. Call this as the LAST action of every investigation, ' +
    'after all queries are done. Do NOT write the summary as a chat message — findings written as ' +
    'markdown text are discarded; only this tool renders the scorecard. One finding per entity that ' +
    'matters, each category a short headline and each details a paragraph with the numbers that ' +
    'justify it. The conclusion ranks priorities across findings.',
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        description: 'The investigation findings, most important first.',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description:
                'Short headline for this finding, naming the entity, e.g. "Rosemarysiphone — critical poor WiFi experience".',
            },
            details: {
              type: 'string',
              description:
                'One paragraph with the evidence: the measured numbers (satisfaction %, RSSI, PHY rates, retry rates, event history) and what they imply. Plain prose, not markdown headings.',
            },
          },
          required: ['category', 'details'],
        },
      },
      conclusion: {
        type: 'string',
        description: 'The ranked conclusion: what to act on first and why.',
      },
    },
    required: ['findings', 'conclusion'],
  },
};

export const toolDefinitions = [
  runSearchDefinition({
    description:
      'Run a read-only Cribl Search (KQL) query against dataset="main" — the home network\'s log stream. ' +
      'It holds UniFi controller events as CEF rows (_raw contains "CEF:0|Ubiquiti"; the event name is CEF field 7, ' +
      'e.g. "WiFi Client Connected", "WiFi Client Roamed", "WiFi Client Disconnected"; useful UNIFI* fields include ' +
      'UNIFIclientHostname, UNIFIclientMac, UNIFIconnectedToDeviceName, UNIFIlastConnectedToDeviceName, UNIFIWiFiRssi, ' +
      'UNIFIwifiName, UNIFIwifiBand where na=5GHz and ng=2.4GHz) and device syslog (datatype=="syslog_rfc3164"; the device ' +
      'name is the first token of message, severityName is error/warning/info, and "MCA: compress failed" lines are benign ' +
      'chatter). Prefer run_metrics_query for numeric questions.',
  }),
  runMetricsQueryDefinition({
    metricsGuide:
      'The metrics dataset holds unpoller_* series for a Ubiquiti network. Clients: ' +
      'unpoller_client_satisfaction_ratio (0-1, multiply by 100 for %), unpoller_client_rssi_db, ' +
      'unpoller_client_radio_receive_rate_bps / unpoller_client_radio_transmit_rate_bps (negotiated PHY), ' +
      'unpoller_client_receive_bytes_total / unpoller_client_transmit_bytes_total (COUNTERS — use rate(...[5m])), ' +
      'unpoller_client_transmit_retries_total (counter), unpoller_client_roam_count_total (counter, group by ap_name), ' +
      'unpoller_client_uptime_seconds — labels: name, mac, ap_name, essid, radio_proto, radio_chan, wired. ' +
      'Devices: unpoller_device_cpu_utilization_ratio, unpoller_device_memory_utilization_ratio, ' +
      'unpoller_device_uptime_seconds, unpoller_device_stations{type="uap"|"usw"|"ugw",name}, unpoller_device_info. ' +
      'Sites: unpoller_site_users / _guests / _iots / _aps / _switches / _gateways, unpoller_site_latency_seconds, ' +
      'unpoller_site_transmit_rate_bytes / _receive_rate_bytes, unpoller_site_intenet_drops_total (counter). ' +
      'Start discovery with .catalog unpoller or .labels unpoller_client_satisfaction_ratio.',
  }),
  presentSummaryDefinition,
];

export const buildContext = async (): Promise<AgentContext> => ({
  resources: {
    availableDatasets: [
      { id: 'main', description: 'UniFi controller events (CEF) and UniFi device syslog' },
      { id: 'metrics', description: 'unpoller_* metrics for UniFi clients, devices, and sites' },
    ],
  },
});

/** Full first prompt: the data map + rules, then the question. */
export function buildSeedPrompt(seed: { question: string }): string {
  return [
    'You are investigating a home Ubiquiti (UniFi) network with Cribl Search. Today\'s data is live.',
    '',
    'DATA',
    '1. METRICS (fast — prefer for anything numeric) via run_metrics_query on dataset metrics: the unpoller_* series.',
    '   Client radio health: satisfaction (ratio 0-1), RSSI dB, negotiated PHY bps, retries, roam counts, throughput.',
    '   Device health: CPU/memory utilization, uptime, connected stations per device type.',
    '   Byte/rate/roam/retry counters are COUNTERS — wrap in rate(...[5m]) before aggregating.',
    '2. LOGS via run_search, always scoped dataset="main":',
    '   - Controller events are CEF rows: filter _raw contains "CEF:0|Ubiquiti". Field 7 of the CEF header is the event',
    '     name (WiFi Client Connected / Roamed / Disconnected). Extract UNIFI* extension fields with extract() regexes.',
    '   - Device syslog: datatype=="syslog_rfc3164". First token of message is the device name. "MCA: compress failed"',
    '     lines are benign inform chatter — ignore them; other MCA/TLS-S lines are real device problems.',
    '',
    'RULES',
    '- Every KQL query must be read-only and carry an explicit dataset="main" scope. Queries are validated; anything',
    '  with side effects is rejected and fed back to you.',
    '- Use the discovery dot-commands (.catalog, .labels <metric>, .values <label>) before guessing metric or label names.',
    '- Default time range is the last hour; widen only when the question needs it.',
    '- When you cite a client, give its name and mac; when you cite a device, give its name.',
    '',
    'FINISHING',
    '- End EVERY investigation by calling present_investigation_summary as your last action — one finding per entity',
    '  that matters, each with a short category headline (e.g. "PC-KODY — lowest current satisfaction") and a details',
    '  paragraph with the numbers that justify it, plus a conclusion that ranks priorities. These render as the',
    '  investigation scorecard.',
    '- Do NOT write the report as a chat message or markdown document: summary text sent as an assistant message is',
    '  not retained. All of it goes in the tool call. Keep interim messages short — what you ran and what you saw.',
    '',
    `QUESTION: ${seed.question}`,
  ].join('\n');
}

/** Browser transport for the metrics catalog (engine resolution + metadata). */
const catalogTransport: CatalogTransport = async (path, signal) => {
  const resp = await fetch(`${apiUrl()}${path}`, { signal });
  return { status: resp.status, ok: resp.ok, text: await resp.text() };
};

const metricsCatalog = createMetricsCatalog({
  transport: catalogTransport,
  group: 'default_search',
});

const runSearchTool = createRunSearchTool({
  runQuery: (kql, earliest, latest, limit) => runQuery(kql, earliest, latest, limit),
  assertSafe: (query, allowed) => {
    // Investigations are scoped to the log dataset; $vt_results is added
    // by the validator itself.
    return assertReadOnlyKql(query, allowed);
  },
  datasetId: async () => INVESTIGATION_DATASET,
});

const runMetricsTool = createRunMetricsQueryTool({
  dataset: async () => 'metrics',
  catalog: metricsCatalog,
});

export async function executeToolCall(
  call: ToolCallInvocation,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (call.name === 'run_search') return runSearchTool(call, signal);
  if (call.name === 'run_metrics_query') return runMetricsTool(call, signal);
  return executeCommonToolCall(call, { embedLabel: 'the Network Investigator' });
}

/** Suggested investigations shown on the empty state. */
export const SUGGESTED_QUESTIONS = [
  'Which clients have the worst WiFi experience right now, and why?',
  'Summarize the interesting network activity in the last hour',
  'Is any access point saturated? Which ones and why?',
  'How healthy is my WAN link — latency, loss, and drops?',
];

/**
 * The context-aware prompts the detail pages' Investigate buttons
 * navigate with (router state → InvestigatorChat seed). Same voice
 * as the original app: entity first, then the dimensions to look at.
 */
export const investigatePrompt = {
  ap: (name: string) =>
    `Investigate access point "${name}": client experience (RSSI, satisfaction, retries), ` +
    'channel utilization by band, roam/connect/disconnect events, and anything unusual in its recent history.',
  switch: (name: string) =>
    `Investigate switch "${name}": port errors/drops, PoE draw, throughput anomalies, temperature, ` +
    'and its device syslog.',
  client: (name: string, mac?: string) => {
    const id = mac ?? name;
    const namePart = name === id ? `"${name}"` : `"${name}" (MAC ${id})`;
    return `Investigate client ${namePart}: signal history, roams and disconnects, throughput, ` +
      'retries, and satisfaction. Is its experience degraded, and why?';
  },
  gateway: () =>
    'Investigate the gateway "Sharp - Los Gatos": WAN latency and drops, throughput vs uplink speed, ' +
    'load averages, and any anomalies.',
  /** Map-page nodes are gateway/switch/ap/client. */
  node: (kind: 'gateway' | 'switch' | 'ap' | 'client', name: string, mac?: string) =>
    kind === 'ap' ? investigatePrompt.ap(name)
      : kind === 'switch' ? investigatePrompt.switch(name)
      : kind === 'client' ? investigatePrompt.client(name, mac)
      : investigatePrompt.gateway(),
};
