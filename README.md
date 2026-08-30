# Ubiquiti2

A Cribl App for monitoring a Ubiquiti (UniFi) home network — live dashboards for
access points, switches, the gateway, clients, and a topology map, plus an
AI **Network Investigator** that answers questions about the network by querying
its metrics and logs.

## What it shows

| Route | Page |
|---|---|
| `/` | **Overview** — whole-network health at a glance |
| `/access-points`, `/aps/:apName` | **Access points** and per-AP detail: clients by band, channel utilization, wireless traffic, per-client signal, AP health, events |
| `/switches`, `/switches/:switchName` | **Switches** and per-switch detail: ports, throughput, busiest ports, PoE draw, port errors + drops, health, syslog |
| `/gateway` | **Gateway (UDM)**: WAN/LAN throughput, packets, load average, WAN drops, temperatures |
| `/clients`, `/clients/:clientName` | **Clients** and per-client detail: signal, throughput, negotiated PHY, retries, satisfaction, DPI top applications, connection history |
| `/map` | **Network map** — force-directed topology (gateway → switches → APs → wireless clients), wired vs wireless links, live link throughput, click-to-pin cards with sparklines |
| `/events` | **Events** — controller events (CEF) and device syslog with counts by type |
| `/investigate` | **Network Investigator** — AI investigations (see below) |

## The Network Investigator

`/investigate` embeds the Cribl Search App Framework's Investigator chat: an
agent loop against Cribl's `/ai/q/agents/local_search` endpoint, executed
client-side with read-only tools. It ends every investigation with a scorecard
(`present_investigation_summary`) and supports PNG export of the transcript.

Data the agent can use:

- **Metrics** (`run_metrics_query`, PromQL against the `metrics` dataset) —
  the `unpoller_*` series for clients, devices, and sites. Byte/rate/retry/roam
  counters are counters, so the tool guide tells the agent to wrap them in
  `rate(...[5m])`. Discovery dot-commands (`.catalog`, `.labels <metric>`) are
  backed by the metrics catalog API.
- **Logs** (`run_search`, KQL, hard-scoped to `dataset="main"`) — UniFi
  controller events as CEF rows (`CEF:0|Ubiquiti`, with `UNIFI*` extension
  fields) and device syslog (`syslog_rfc3164`).

Every query passes through `assertReadOnlyKql`; side-effect operators are
rejected before they ever reach the API.

**Context-aware prompts.** Every page's *Investigate* button navigates to
`/investigate` with a pre-fired seed question tuned to what that page shows
(`investigatePrompt` in `src/api/investigator.ts`):

> Investigate access point "AP Office": client experience (RSSI, satisfaction,
> retries), channel utilization by band, roam/connect/disconnect events, and
> anything unusual in its recent history.

## Architecture

- **Vite + React 19 + TypeScript**, bundled by the Cribl App platform
  (esbuild + esm.sh). `npm run dev` for the standalone dev server,
  `npm run build` for production.
- **`src/api/`** — data access:
  - `cribl.ts` re-exports the framework's `runQuery` (KQL search jobs).
  - `metrics.ts` wraps the framework's instant/range PromQL queries.
  - `investigator.ts` wires the Investigator: tool definitions, the seed
    prompt (the UniFi data map the agent gets on every investigation),
    request context, tool executors, and the per-entity prompt templates.
  - `appSettings.ts` — app-level settings.
- **`src/vendor/`** — the framework's investigator/agent/kql/metrics/viz
  source, vendored so the app's own bundler compiles it (package CSS modules
  and a second React copy via esm.sh broke rendering — see the note in
  `capra.tsx`). `capra.tsx` is a small local Button/Modal shim styled with the
  app's CDS tokens.
- **`src/components/viz/`** — d3-based LineChart, BarList, StatTile, and
  sparkline components used across the dashboards.
- **Design system** — CDS tokens (`--cds-*`) defined in `src/styles/global.css`;
  Open Sans; navy `#1b1f3b` / teal `#0cc` brand.

## Data source

The app expects UniFi telemetry already flowing into Cribl:

- `unpoller_*` metrics (e.g. from an [unpoller](https://unpoller.com/)
  Prometheus scrape ingested into the metrics store) on the `homelab` engine.
- UniFi controller events (CEF) and device syslog in the `main` dataset.

## Development

```bash
npm run dev        # standalone dev server
npm run verify     # lint + tests + typecheck
npm run build      # production build
npm run package    # build + cribl-app-package
npm run deploy     # install into the current Cribl workspace
```

CI runs Vitest, `tsc --noEmit`, and the production build on every push.

### External domains

`config/proxies.yml` is currently empty — the app talks only to the Cribl API
(search, metrics, and the agent endpoint), all through the platform's fetch
proxy with auth injected. No external egress is declared or needed.
