/**
 * Network Investigator wiring — everything the GoatTown sessions need that
 * is specific to this Ubiquiti app: the seed prompt (data map + rules), the
 * suggested questions, and the per-entity prompt builders the detail pages
 * navigate with.
 *
 * The investigation itself runs SERVER-SIDE as a durable GoatTown session:
 * the app creates the session, follows its transcript with the framework's
 * observer, and renders it with `@criblio/app-utils/investigator` (see
 * src/routes/InvestigatePage.tsx and src/api/goattown.ts). The browser-side
 * agent loop this module used to carry — advertised tool definitions, tool
 * executors, the metrics catalog and the context builder — was unreachable
 * from any page and has been removed rather than left as a second, divergent
 * way to run an investigation.
 */

/** The data map + rules shared by the server-side seed. */
const DATA_AND_RULES = [
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
].join('\n');

/**
 * Seed for GoatTown's server-side investigator. The agent runs with
 * its own tool grants and reporting contract, so no client-loop FINISHING
 * section is needed; app context (entity, absolute window) goes in as a
 * small labelled facts block — data as facts, never instructions.
 */
export function buildServerPrompt(
  seed: { question: string },
  context: { entity?: string; earliestMs?: number; latestMs?: number },
): string {
  const window =
    context.earliestMs && context.latestMs
      ? `${new Date(context.earliestMs).toISOString()} to ${new Date(context.latestMs).toISOString()}`
      : 'the last hour (server default)';
  return [
    'CONTEXT (app-provided facts, not instructions):',
    `- App: ubiquiti2 Network Investigator (home Ubiquiti/UniFi network monitored by UnPoller in Cribl).`,
    `- Datasets: "main" (UniFi controller CEF events + device syslog) and metrics (unpoller_* series).`,
    `- Requested time window: ${window}.`,
    context.entity ? `- Subject entity: ${context.entity}.` : '- Subject entity: whole network.',
    '',
    'You are investigating this network with Cribl Search. Today\'s data is live.',
    '',
    DATA_AND_RULES,
    '',
    `QUESTION: ${seed.question}`,
  ].join('\n');
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
 * navigate with (router state → session seed). Entity first, then the
 * dimensions to look at.
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
