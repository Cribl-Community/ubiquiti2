# Ubiquiti2

A Cribl App for monitoring a Ubiquiti (UniFi) home network — live dashboards for
access points, switches, the gateway, clients, and a topology map, plus an
AI **Network Investigator** that answers questions about the network by querying
its metrics and logs.

## What it shows

| Route | Page |
|---|---|
| `/` | **Overview** — whole-network health at a glance: connected clients, WAN/LAN throughput, per-device status, top talkers |
| `/access-points`, `/aps/:apName` | **Access points** and per-AP detail: clients by band, channel utilization, wireless traffic, per-client signal, AP health, events |
| `/switches`, `/switches/:switchName` | **Switches** and per-switch detail: ports, throughput, busiest ports, PoE draw, port errors + drops, health, syslog |
| `/gateway` | **Gateway (UDM)**: WAN/LAN throughput, packets, load average, WAN drops, temperatures |
| `/clients`, `/clients/:clientName` | **Clients** and per-client detail: signal, throughput, negotiated PHY, retries, satisfaction, DPI top applications, connection history |
| `/map` | **Network map** — force-directed topology (gateway → switches → APs → wireless clients) |
| `/events` | **Events** — controller events (CEF) and device syslog with counts by type |
| `/investigate` | **Network Investigator** — AI investigations (see below) |

## How to use it

**Time ranges and refresh.** Every dashboard page has a range picker
(*Last hour / Last 6 hours / Last 24 hours*), an auto-refresh toggle (30 s
interval), and a `↻` manual refresh. Charts and event tables re-query for the
selected range. Stat tiles and list counts (e.g. the Access Points page) are
point-in-time values, so the picker does not change those numbers.

**Map.** Nodes are clickable: click a device to pin a card with its live
throughput sparkline; wireless clients start collapsed under their AP
(*"N clients"* expands them, *Collapse nodes* re-folds them via the parent's
menu). Wired and wireless links are drawn differently; hovering a node shows
per-link traffic to and from it.

**Investigator.** Open `/investigate` for the AI chat, or use the *Investigate*
button on any device/client page — it pre-fires a question tuned to that entity
(e.g. port errors, PoE draw and temperature for a switch; RSSI, satisfaction
and roams for a client). Investigations run read-only Cribl searches and end
with a scorecard. Example questions: *"Which clients have the worst WiFi
experience right now, and why?"*, *"Is any access point saturated?"*, *"How
healthy is my WAN link — latency, loss, and drops?"*.

## Prerequisites — data flowing into Cribl

The app is read-only and expects two telemetry streams already in the
workspace:

1. **`unpoller_*` metrics** in the metrics store (PromQL dataset, `homelab`
   engine) — clients, devices, and sites, including counters for bytes,
   retries, and roams.
2. **UniFi controller events and device syslog** in the `main` dataset —
   controller events as CEF rows (`_raw` containing `CEF:0|Ubiquiti` with
   `UNIFI*` extension fields) and device syslog as `syslog_rfc3164`.

Section below covers producing the first with unPoller.

### Feeding metrics with unPoller

[unPoller](https://unpoller.com/) polls the UniFi controller and exports
Prometheus metrics; Cribl scrapes them into the metrics store.

1. **Create a read-only controller user.** In the UniFi Network app:
   *Settings → Admins → Add Admin*, role *Read only*. Use a local (non-SSO)
   account.

2. **Install unPoller** on any host that can reach the controller, e.g. Docker:

   ```bash
   docker run -d --name unpoller --restart unless-stopped \
     -p 9130:9130 \
     -e UP_UNIFI_DEFAULT_URL="https://<controller-ip>:8443" \
     -e UP_UNIFI_DEFAULT_USER="unpoller" \
     -e UP_UNIFI_DEFAULT_PASS="<password>" \
     -e UP_PROMETHEUS_DISABLE=false \
     qmcgaw/unifi-poller
   ```

   (Or install natively and edit `/etc/unpoller/up.conf` — same settings under
   the `[unifi]` and `[prometheus]` stanzas.)

3. **Expose the Prometheus endpoint.** Default output is
   `http://<unpoller-host>:9130/metrics`. Confirm the metric names start with
   `unpoller_` (recent versions do; older `unifipoller` versions used a
   `unifipoller_` prefix — the app expects `unpoller_`, so run a current
   release).

4. **Scrape it into Cribl.** In Cribl Stream add a **Prometheus** source
   (Sources → Prometheus), target
   `http://<unpoller-host>:9130/metrics`, scrape interval 30–60 s, and route it
   to the metrics engine backing the `homelab` engine / metrics dataset.

5. **Verify before starting the app.** In Cribl Search:

   ```text
   .catalog unpoller_
   ```

   You should see series like `unpoller_site_aps`, `unpoller_site_clients`,
   `unpoller_site_receive_rate_bytes`, `unpoller_client_*`, and
   `unpoller_device_*`. If metrics exist but start with `unifipoller_`,
   upgrade unPoller or set its namespace accordingly.

6. **Events.** Controller events reach the `main` dataset as CEF (`CEF:0|Ubiquiti`)
   and device syslog as RFC 3164. In UniFi, enable *Remote Syslog* against a
   Cribl Syslog source; route controller (user) syslog through the CEF
   formatting and device syslog as-is.

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
  controller events as CEF rows and device syslog (`syslog_rfc3164`).

Every query passes through `assertReadOnlyKql`; side-effect operators are
rejected before they ever reach the API.

## Architecture

- **Vite + React 19 + TypeScript**, bundled by the Cribl App platform
  (esbuild + esm.sh). `npm run dev` for the standalone dev server,
  `npm run build` for production.
- **`src/api/`** — data access:
  - `cribl.ts` re-exports the framework's `runQuery` (KQL search jobs).
  - `metrics.ts` wraps the framework's instant/range PromQL queries; range
    queries take `(step, earliest)` so the per-page time picker drives them.
  - `investigator.ts` wires the Investigator: tool definitions, the seed
    prompt (the UniFi data map the agent gets on every investigation),
    request context, tool executors, and the per-entity prompt templates.
  - `appSettings.ts` — app-level settings.
- **Published framework packages** — everything framework-side
  (investigator, agent loop, KQL guard, metrics, viz) comes from the
  published `@criblio/app-utils` on npmjs (`^0.8.2`), with its
  `@capra/core` peer (`^1.5.0`) declared explicitly. 0.8.2 is the minimum:
  it ships pre-compiled CSS with stable `criblio-au-*` class names that the
  platform bundler fetches from esm.sh and injects — earlier releases relied
  on runtime CSS-module compilation, which loses the class-name map in the
  esm.sh path and renders the investigator unstyled. Do not downgrade.
- **`src/components/TimeRange.tsx`** — shared hook behind every page's range
  picker, auto-refresh toggle, and refresh button.
- **`src/components/viz/`** — d3-based LineChart, BarList, StatTile, and
  sparkline components used across the dashboards.
- **Design system** — CDS tokens (`--cds-*`) defined in `src/styles/global.css`;
  Open Sans; navy `#1b1f3b` / teal `#0cc` brand.

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
