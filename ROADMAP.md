# ROADMAP — ubiquiti2: best-in-class home UniFi observability

**Status:** living document · **Owner:** app maintainers · **Last evidence pass:** 2026-09-11

This document answers three questions:

1. **What do we have today?** (verified against the code and the live metric store)
2. **What are we missing**, compared with UniFi's own tooling, the unpoller/Grafana
   ecosystem, enterprise monitoring, and consumer mesh apps?
3. **What would best-in-class look like for a home user** — designed, prioritized and
   engineered?

Evidence rules used throughout: **[V]** = verified in this workspace (code or live metric
catalog). **[S]** = public search excerpt, source cited, page **not** fetched. Nothing here
claims more than those two levels.

---

## 1. What we have today [V]

### 1.1 Surfaces

| Route | Answers |
|---|---|
| `/` Overview | Site throughput, connected clients (users / guests / IoT), internet drops, network event counts, device inventory; tiles for APs, switches, gateways, WAN latency, uplink uptime |
| `/access-points` → `/aps/:apName` | Per-AP clients, average client RSSI, wireless TX/RX, 2.4/5 GHz channel utilization, AP CPU/memory, clients by channel, clients by vendor (OUI), RSSI-tier row colouring; detail page adds connected-client table, six time-series panels, per-AP controller events |
| `/clients` → `/clients/:clientName` | Wireless/wired split, average satisfaction, top talkers up/down, DPI top applications, DPI top categories, client satisfaction, roams per AP; detail page adds per-client history |
| `/switches` → `/switches/:switchName` | Ports table (speed, attached client, PoE), switch throughput, busiest ports `topk(8)`, PoE draw by port, port errors + drops, CPU/memory |
| `/gateway` | Uptime, CPU, memory, WAN link speed, WAN latency, direct clients; WAN/LAN throughput, WAN packets, load average, WAN drops, temperatures |
| `/map` | Force-directed topology: gateway → switch → AP → client clusters; wired vs wireless edges; edge width = traffic; **mesh backhaul edges**; pin card with traffic, client count, CPU/mem, sparkline, drill-through links, "Investigate" |
| `/events` | CEF controller log: connects, roams, disconnects, other controller events, device problems |
| `/investigate` | GoatTown agent: natural-language investigation with live metric tools and per-entity prompt builders |
| `/settings` | Mesh-link overrides (manual topology corrections), GoatTown connection |

### 1.2 Data plane [V]

- **Metrics** — unpoller (v5.2.4, **patched build**) → Prometheus remote-write → Cribl
  metrics store. 1,684 active metrics / 48,948 series / ~173k samples/min; 286 metric names
  match `unpoller`.
- **Wireless topology** — `unpoller_device_uplink_info{...}` and `_up` from the patched
  `uplink-parent-fields` branch (`uplink_type="wireless"` = mesh backhaul; 3 links currently
  live). `unpoller_topology_link_*` carries per-link rate/experience, but its WIRELESS edges
  are **client associations**, not device backhaul [V, verified in earlier investigation].
- **Events** — UniFi controller CEF syslog into the Search dataset.
- **Agent** — GoatTown server-side sessions over the app proxy (`proxies.yml`, token in KV).
- **Workspace notification targets already exist** — email (SMTP) and webhook targets are
  configured platform-wide and reusable by ID (`GET /api/v1/notification-targets`) [V]. Any
  alerting we add should reference these, never ask the user to paste a webhook URL.

### 1.3 What we already do that the ecosystem largely does not [V + S]

- **Mesh backhaul as a first-class, historical signal.** The patched unpoller exporter emits
  device uplink topology; upstream unpoller does not, and the shipped Grafana dashboards have
  no mesh-backhaul panels at all [S: unpoller repo ships 12 dashboards — 6 InfluxDB, 6
  Prometheus — UAP/Client/PDU insights; none model device backhaul].
- **Metrics + controller events + topology + agent in one app**, with cross-drill from map
  card → device → client → investigation.
- **History beyond the controller.** UniFi retains limited history; our store keeps the full
  time series, so "what was it like at 19:03 last Tuesday" is answerable here and mostly not in
  the UniFi app.
- **Guardrails** we learned the hard way and should keep: scope site gauges to
  `status="ok"`, never conclude from an empty result, and treat unpoller units as
  controller-native (`uplink_tx_rate` populated on wireless, `*_bytes_rate` on wired — the two
  are **not** comparable).

---

## 2. The biggest gap is data we already collect and never look at [V]

The metric catalog reports `queries30d` per metric. That is a free "capability we own but do
not exercise" report:

| Family | Series | Queries (30d) | What it unlocks |
|---|---:|---:|---|
| `unpoller_client_dpi_transmit_bytes` | 961 | **0** | Upload-side app visibility (receive side is used on `/clients` only as a top-10 chart) |
| `unpoller_client_dpi_{receive,transmit}_packets` | 955 / 945 | **0** | App packet rates → "who is saturating the link", not just bytes |
| `unpoller_speedtest_{download_mbps,upload_mbps,latency_ms,timestamp_seconds}` | 2 each | **0** | ISP speed-test history — the single most-requested home-user number |
| `unpoller_device_speedtest_*` | 1 each | **0** | Gateway-initiated speed test history |
| `unpoller_site_{xput_down_rate,xput_up_rate,speedtest_ping}` | 1 each | **0** | WAN capacity trend without a live test |
| `unpoller_dhcp_{is_static,lease_end}` | 84 / 83 | **0** | IP/lease hygiene, "which device just took that IP" |
| `unpoller_firewall_rule_{enabled,index}` | 66 / 66 | **0** | Firewall inventory drift |
| `unpoller_device_radio_{channel_utilization_receive_ratio,transmit_ratio}` | 29 each | **0** | Our own AP airtime vs neighbours' — split of the used "total" metric |
| `unpoller_device_radio_transmit_retries` | 29 | **0** | RF retransmission → hidden airtime loss |
| `unpoller_device_radio_ast_be_xmit` | 29 | **0** | Airtime consumed by beacons (dense-AP problem detector) |
| `unpoller_device_radio_{channel,ext_channel,ht,nss,min,max_transmit_power,current_antenna_gain}` | 29 each | **0** | Channel plan, width, spatial streams, TX-power/tuning audit |
| `unpoller_device_vap_{ccq_ratio,dns_latency_average_seconds,mac_filter_rejects,average_client_signal}` | 60 each | 0 / 0 / 0 / **1** | Per-SSID health, per-SSID DNS latency, filter rejects, SSID signal floor |
| `unpoller_device_port_{receive,transmit}_errors_total`, `..._drops_total` (transmit side), `port_satisfaction_ratio`, broadcast/multicast | 63 each | **0** | Port-level satisfaction; broadcast-storm detection |
| `unpoller_client_radio_{receive,transmit}_mcs_index`, `..._spatial_streams`, `transmit_power_dbm` | 45 each | **0** | PHY truth: is a client stuck at a low MCS/1 stream? |
| `unpoller_site_{adopted,disconnected,pending,disabled}` | 3 each | **0** | Device inventory drift / offline detection |
| `unpoller_site_remote_user_*`, `site_to_site_enabled` | 1 each | **0** | VPN / Teleport / site-to-site usage |

**Verified absent [V]:** a `rogue` search over the catalog returns **0 matches** — there is no
neighbour-scan / rogue-AP / interference-source metric in this pipeline. RF *environment*
visibility (who else is on my channel) therefore cannot come from metrics alone; UniFi's own
Channel AI does this with neighbour reports and RRM scans [S:
help.ui.com Channel AI article]. We should design around the gap and say so honestly, or add a
controller-API read (see §7.3).

**Read-through:** we are not short of data; we are short of *interpretation*. The catalog says
we use roughly a third of what we scrape.

---

## 3. How we compare

### 3.1 UniFi's own tooling

- **UniFi Network app** ships WiFi Experience Score, per-device/client views, RF/Channel AI
  (neighbour reports + automated RRM scans), Minimum RSSI, band steering, 802.11k/v/r,
  airtime fairness, DPI traffic/device identification, gateway speed tests
  [S: help.ui.com Channel AI, Optimizing WiFi Connectivity, Minimum RSSI, Gateway Traffic and
  Device Identification].
- **WiFiman** adds phone-based signal mapping/heatmaps — but the network heat-map feature
  requires a UDM-class gateway [S: WiFiman heat-map walkthroughs; community threads].
- **The recurring complaint is comprehension, not capability.** Community threads titled
  variants of "does anyone understand the data on the UniFi dashboard anymore?" are a strong
  signal that the incumbent's weakness is *presentation*, and that third parties are paid to
  produce reports from the same controller data [S: r/Ubiquiti thread; UniHosted client
  reporting / NOC dashboard / analytics posts]. **This is our opening:** the home user's
  question is "is my Wi-Fi bad right now, and is it my ISP or my house?" — not "show me
  `channel_utilization_total_ratio`".

### 3.2 unpoller + Grafana (our closest cousins)

The ecosystem's dashboards (UAP Insights 11314, Client Insights 11315, PDU 23027) model
per-area panels: radio utilization (receive/transmit ratios), VAP stats, station counts, keyed
on `$Site`/`$AP` [S: Grafana dashboard listings; vdaluz.com dashboard teardown; unpoller repo
"12 dashboards included"; Techno Tim build guide]. They are **kiosk dashboards for operators**:
no mesh backhaul, no cross-device attribution, no narrative, no alerting state machine, and no
drill-through from a topology edge to a client.

### 3.3 Enterprise monitoring (LogicMonitor, Datadog-class)

Full UniFi device/port/health monitoring, alerting, dashboards [S: LogicMonitor UniFi
monitoring docs]. Wrong shape for a home: assumes an NOC, costs more than the hardware, and
still leaves "why was my video call bad?" unanswered.

### 3.4 Consumer mesh (eero, Google Nest, TP-Link Deco/Omada)

What home users actually get from the mass market, per app listings and comparisons [S]:
dead-simple health language, **speed tests in-app**, pause/block device, schedules, profiles,
parental controls, device naming/recognition, security add-ons. What they *don't* get:
RF detail, channel/airtime analysis, per-client PHY truth, or anything historical worth
exporting.

### 3.5 Positioning matrix

| Capability | UniFi app | WiFiman | unpoller+Grafana | Enterprise APM | Consumer mesh | **Us (today)** | **Target** |
|---|---|---|---|---|---|---|---|
| Live device/client metrics | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ |
| Historical retention beyond controller | ⚠️ limited | – | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Mesh backhaul visibility (historical) | ⚠️ live only | – | ❌ | ⚠️ | ❌ | ✅ **[V]** | ✅ |
| Controller event log (CEF) correlation | ⚠️ in-app | – | ❌ | ⚠️ | ❌ | ✅ | ✅ |
| RF detail (airtime split, retries, MCS, TX power) | ⚠️ partial | – | ⚠️ some panels | ✅ | ❌ | ❌ **unused [V]** | ✅ |
| DPI / app visibility | ✅ | – | ❌ | ⚠️ | ⚠️ | ⚠️ receive-only | ✅ |
| ISP/WAN truth (speed-test history, loss) | ✅ live | – | ⚠️ | ✅ | ✅ | ❌ **unused [V]** | ✅ |
| Topology + drill-through to client | ✅ | – | ❌ | ⚠️ | ❌ | ✅ | ✅ |
| Proactive alerting that prescribes action | ⚠️ | – | ❌ | ✅ | ⚠️ | ❌ | ✅ |
| Plain-language "is it me or my ISP?" verdict | ❌ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ✅ |
| Incident narrative ("what happened at 19:03") | ❌ | ❌ | ❌ | ⚠️ | ❌ | ⚠️ via agent | ✅ |
| Natural-language investigation | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Room-level coverage evidence | ⚠️ heatmap (UDM) | ✅ manual | ❌ | ❌ | ❌ | ❌ | ✅ |

**Thesis.** Everyone else sells dashboards or simplicity. Nobody gives a home user
*attributed, time-bounded, plain-language answers*. Our data advantage (history + events +
topology + agent) is exactly the raw material for that, and §2 shows most of it is already
paid for.

---

## 4. Three lenses

### 4.1 Designer — "a home user is not an operator"

**Job to be done:** answer three questions in under 30 seconds, on a phone, while something is
actually broken: *Is my network OK? · Is it my Wi-Fi or my ISP? · What should I do?*

Asks:

1. **One status header, one verdict.** A single health band on Overview — `Internet`,
   `Wi-Fi`, `Devices` — each `Good / OK / Poor` with the *reason* inline ("5 GHz airtime 78%
   on AP Office 7"). Never a bare number as the headline.
2. **Language before units.** Replace ratio-first labels (`channel_utilization_total_ratio`)
   with tiers, and keep the raw value as secondary text. Colour-blind-safe tiers only
   (blue→amber→red is already our language via RSSI rows; extend it, don't invent a second
   palette). Tiers must carry text/icons, never colour alone.
3. **Progressive disclosure, one drill path.** Every meaningful element has the same three
   levels: tier → sparkline/history → "why" (contributing signals) → Investigate. No dead-end
   numbers.
4. **Answer-first, evidence-second incident card.** "Your 19:03 video call dropped: client
   *Living Room TV* roamed twice, RSSI -71 dBm, 5 GHz airtime 81%, WAN latency normal → Wi-Fi
   side, not ISP." with each clause clickable to its chart.
5. **Mobile and dark/light.** Home users check from a sofa. Dense tables need a card
   fallback; charts need ≥44px touch targets (the map pin card is the pattern to generalise).
6. **Honest states.** Distinguish "loading" (skeleton, first load only), "refreshing" (thin
   progress bar, keep stale data), "empty window" (explicit), and "collector down" (its own
   state — never render an empty chart that looks like a healthy zero). *A zero from a dead
   exporter is a lie.*
7. **Stability as a design requirement.** We already lost a card's styling because it was
   scoped to a framework-owned wrapper class. Design tokens in our own namespaces, and treat
   "an upstream rename must not be able to break our chrome" as a design constraint, not a bug
   report.

### 4.2 PM — what best-in-class means, and in what order

**Definition of best-in-class for a home user (scorecard):**

| # | Criterion | Today | Program target |
|---|---|---|---|
| 1 | "Is my network healthy?" answered on one screen in <30 s | ⚠️ tiles, no verdict | ✅ |
| 2 | "Is it my ISP or my Wi-Fi?" attributable | ❌ | ✅ |
| 3 | "Why was *that* bad?" — incident narrative for any symptom | ⚠️ agent-only | ✅ |
| 4 | "What should I do?" — prescriptive alerts, no alarm spam | ❌ | ✅ |
| 5 | Every scraped metric family either surfaced or consciously retired | ⚠️ ~1/3 surfaced [V] | ✅ |
| 6 | Works for a non-technical household member | ❌ | ✅ |
| 7 | History: "what was it like last week?" | ✅ | ✅ |
| 8 | Does not require the UniFi app to interpret | ⚠️ | ✅ |

**Prioritisation principle:** rank by *answers unlocked per unit of data already paid for*.
That puts telemetry we already scrape and never read (§2) ahead of anything new to collect,
and public-agent features (reports, digests, alerts) ahead of model-driven ones.

**Non-negotiables:** never show a number we can't source; never alert without a suggested
action; never require a cloud account.

**Explicit non-goals:** replacing UniFi configuration changes, becoming a NOC/multi-site
product, packet capture, IDS/IPS, and per-app parental controls (see §6).

### 4.3 Engineer — how the roadmap actually gets built here

1. **Query economics.** 48,948 active series. Every panel must be bounded
   (`topk`, narrow `by (...)`, step-appropriate windows). Panels that fan out over
   `unpoller_client_*` join-scope to `unpoller_device_info` only, or they multiply series.
2. **Caching.** Anything on Overview/digests should be a scheduled search writing a lookup or
   reading `$vt_results` in one batched query (`jobName in (...)`), with live fallback on
   cache miss — the pattern already used for alert state elsewhere. Managed search IDs get the
   `ubiquiti2__` prefix so user searches are never touched, and provisioning is idempotent.
3. **Alerting state machine.** Three searches: previous-window export → evaluator (thresholds
   from KV, per-member) → state export with `ok → pending → firing → resolving → ok` and
   `fireAfter`/`clearAfter` debounce. Delivery reuses the workspace's existing notification
   targets by ID. Alerts must dedupe per entity and carry the evidence line.
4. **Own the metric inventory.** `.catalog` reports `queries30d` per metric. Turn §2 into a
   tracked number: *metric families surfaced / families available*, recomputed monthly. It is
   both the gap list and the KPI.
5. **Units and semantics are a contract.** `uplink_tx_rate` vs `*_bytes_rate` populate on
   different link types and are not comparable [V]. Every panel states its unit and source;
   metric-name units are not trusted.
6. **Fragile dependency on a patched exporter.** Mesh backhaul exists only because of a
   patched unpoller build. Detect its absence and degrade gracefully ("backhaul metrics
   missing — exporter lacks uplink topology") rather than rendering an empty map. Fallback path
   if it disappears: controller API `/api/s/{site}/stat/device` (session reuse; it rate-limits
   with 429).
7. **Testability.** CI collects `src/api/goattown.test.ts` against `src/api/wire-fold.ts`
   (pure folding logic) — the transport import cannot load in a Node test environment, which
   is why the suite must never import `./goattown` directly. Keep `npm run verify` (lint +
   test + `tsc --noEmit`) green as the merge bar; a temporary `if: failure()` CI diagnostics
   step prints the vitest cause lines until the suite is confirmed green.
8. **Verification bar for every new panel:** one bounded live query validated *before* the
   widget exists, plus an explicit empty/error state. No panel ships on a compile alone.

---

## 5. Roadmap

Each phase is independently shippable and measurable. Effort: S ≤ 1 day, M ≤ 3 days,
L > 3 days (single maintainer).

### Phase 0 — Surface what we already scrape (S–M each)
*Goal: exercise the ~2/3 of collected telemetry we ignore.*
1. **ISP truth panel**: `unpoller_speedtest_{download,upload}_mbps` + `latency_ms` history on
   `/gateway`, with "last test" freshness. Accept: shows ≥7 days of tests or an explicit
   empty state.
2. **Per-client app visibility**: upload side of DPI + packet rates; add app/category
   breakdown to `/clients/:clientName`. Accept: per-client top apps, receive *and* transmit.
3. **RF detail on AP detail**: airtime split (`channel_utilization_receive/transmit_ratio`),
   `transmit_retries`, `ast_be_xmit`, channel/width/NSS/TX-power audit row.
4. **Per-SSID health**: `vap_ccq_ratio`, `vap_dns_latency_average_seconds`,
   `vap_mac_filter_rejects`, `vap_average_client_signal`.
5. **Wired/fabric hygiene**: transmit-side port errors/drops, `port_satisfaction_ratio`,
   broadcast/multicast rates (storm detector), `port_speed_bps` mismatch audit.
6. **Inventory drift**: `site_{adopted,disconnected,pending,disabled}` on Overview ("3 devices
   offline > 10 min") — the cheapest real alert.
7. **DHCP + firewall inventory**: `dhcp_{is_static,lease_end}`, `firewall_rule_{enabled,index}`.

### Phase 1 — Health score with attribution (M)
*Goal: the one-line verdict.*
- Compute `Internet`, `Wi-Fi`, `Devices` tiers from a small, documented set of inputs
  (WAN latency/loss/speed-test vs baseline; per-band airtime + retry + client RSSI
  distribution; device up/adopted drift). Every tier carries its top contributing factor.
- **"Is it me or my ISP?"** verdict: when clients complain, compare WAN-path health vs
  Wi-Fi-path health over the same window and state which side degraded.
- Accept: verdict reproducible from a live query at any time; each factor click-through to
  evidence; no tier without a reason string.

### Phase 2 — Alerting that prescribes (M–L)
- State machine per §4.3; thresholds in KV, per member; targets by ID.
- Starter alert set: device offline; AP airtime saturation (band, sustained); mesh backhaul
  down/degraded; WAN latency or loss breach; speed test below X% of baseline; client stuck at
  low MCS/1 stream for N minutes; PoE budget near/over cap; port errors climbing.
- Accept: no duplicate alerts per entity per window; every alert body contains the evidence
  line and one suggested action; test-fire documented.

### Phase 3 — Incident narratives and digests (M)
- **"Why was that bad?"** card: pick a time (or let an alert link to it), correlate RSSI,
  roams, airtime, retries, port errors, WAN latency/loss and CEF events; render an ordered
  story with clickable clauses. Reuse the map-pin card pattern.
- **Weekly/monthly digest** ("what changed"): new/offline devices, worst clients, airtime
  trend, throughput trend, speed-test trend, top apps — delivered via an existing notification
  target; identical content available in-app.
- Accept: narrative generated for any 15-minute window in the last 7 days; digest renders with
  zero manual assembly.

### Phase 4 — Coverage & roaming quality (M–L)
- **Sticky-client detector**: long sessions at RSSI below a floor with a stronger AP visible in
  the data (`client_rssi_db` + `roam_count_total` + per-AP signal) → "this client should have
  roamed".
- **Roaming quality**: roam count/latency per client and per AP; flapping detector
  (min-RSSI too aggressive); band-steering evidence (2.4-only clients that support 5).
- **PHY truth**: MCS index, spatial streams, TX power, negotiated rate vs actual.
- **Coverage evidence without rogue scan**: per-AP RSSI percentiles over time → a
  room/space-level "weakest client" view; explicitly labelled as *observed clients*, not a
  heat-map substitute.
- Accept: every claim traceable to a named metric and window.

### Phase 5 — Advisory and predictive (L, data-permitting)
- **Channel advisory**: correlate channel utilization (own vs neighbours' share), retries and
  client distribution per band → "5 GHz ch 44 is your worst band/channel pair; consider…",
  with the honest caveat that we have no neighbour scan [V: no rogue/neighbour metric].
- **TX-power/placement advisory**: clients consistently at low RSSI with high retries near one
  AP → placement/power suggestion.
- **PoE and thermal budget**: port PoE watts vs cap; gateway/switch temperature trend.
- **"What changed?" attribution**: correlate a throughput drop with DPI shifts, a new client,
  or a firmware/version change.
- Accept: advisories are suggestions with evidence, never automatic config changes.

---

## 6. Non-goals

- Applying configuration changes to the controller (advisory only, for now).
- Packet capture, IDS/IPS, content inspection beyond what DPI already provides.
- Multi-site / MSP fleet management (this is a home app).
- Parental control, profiles, pause/block — the consumer-mesh feature set we deliberately do
  not compete on.
- Replacing the UniFi app for provisioning, firmware, or adoption.

## 7. Risks and guardrails

1. **Patched-exporter dependency** (mesh backhaul, uplink topology). Rebuilding unpoller from
   upstream silently deletes the metrics. → Feature-detect, degrade gracefully, document the
   dependency in the app's own help text, and know the controller-API fallback.
2. **No RF-environment data** (verified absent). → Never imply we can see neighbouring
   networks; if that matters enough, add a controller-API read (neighbour scan) as an explicit
   new data source with its own risk notes (429 rate-limits, session reuse).
3. **Metric semantics drift** across unpoller versions (units, label sets). → Panels state
   units and sources; add a smoke query per panel family to the verification checklist.
4. **Cardinality blowups** from client/DPI joins. → Bounded `topk`, deliberate label sets,
   never join `unpoller_device_info` across unrelated families.
5. **Empty-result conclusions.** A failed query and a genuinely quiet window are different
   outcomes; the UI must distinguish them, and so must this roadmap's acceptance criteria.

## 8. Measuring ourselves

| KPI | Source | Baseline | Target |
|---|---|---|---|
| Metric families surfaced ÷ families available | `.catalog` `usage`/`queries30d` | ~1/3 [V] | >80% surfaced or formally retired |
| Time-to-answer for the three home questions | manual, in-app | untested | <30 s each |
| Alerts that name an action | alert bodies | n/a | 100% |
| Dead-end panels (number with no drill path) | design review | several | 0 |
| CI green on `main` | `check_ci` | red (Vitest suite collection) | green |

## Appendix A — Reproduce the inventory

```
.catalog unpoller                 # families + series + queries30d (the gap list)
.labels unpoller_client_dpi_receive_bytes
.catalog unpoller_device_radio / unpoller_site / unpoller_client_r / speedtest
```

Metric names, label sets and units in this document were observed live; treat dashboard
labels as authoritative and metric-name units as untrusted.

## Appendix B — Sources

Search excerpts only; pages were not fetched.
- UniFi Channel AI and automated Wi-Fi optimization — https://help.ui.com/hc/en-us/articles/37367741854743-UniFi-Channel-AI-and-Automated-WiFi-Optimization
- Optimizing Wi-Fi connectivity and reducing latency — https://help.ui.com/hc/en-us/articles/221029967-Optimizing-WiFi-Connectivity-and-Reducing-Latency
- Understanding and implementing Minimum RSSI — https://help.ui.com/hc/en-us/articles/221321728-Understanding-and-Implementing-Minimum-RSSI
- UniFi Gateway traffic and device identification (DPI) — https://help.ui.com/hc/en-us/articles/12570783535383-UniFi-Gateway-Traffic-and-Device-Identification
- UID Enterprise one-click Wi-Fi / WiFi Experience Score — https://help.ui.com/hc/en-us/articles/17169852687639-UID-Enterprise-One-Click-WiFi
- unpoller project (12 Grafana dashboards) — https://github.com/unpoller/unpoller
- Grafana UniFi-Poller Client Insights (11315) — https://grafana.com/grafana/dashboards/11315-unifi-poller-client-insights-prometheus/
- Grafana UniFi-Poller PDU Insights (23027) — https://grafana.com/grafana/dashboards/23027-unifi-poller-pdu-insights-prometheus/
- Dashboard teardown of UAP/Client insights panels — https://vdaluz.com/blog/unifi-device-monitoring
- Enterprise-style UniFi observability with unpoller/Grafana — https://technotim.com/posts/unpoller-unifi-metrics/
- UniFi client reporting (third-party paid reporting) — https://www.unihosted.com/blog/unifi-client-reporting-how-to-monitor-and-analyze-network-activity
- "Does anyone understand the UniFi dashboard anymore?" — https://www.reddit.com/r/Ubiquiti/comments/1hzvuoi/
- UniFi roaming / band-steering / min-RSSI practice — https://demarcnetworks.com/guides/unifi-wifi-roaming · https://evanmccann.net/blog/2021/11/unifi-advanced-wi-fi-settings
- WiFiman heat-map requirements — https://www.anythingtech.ca/story/wifiman-app-measure-wifi-signal-strength-home-mapping
- eero app capability list (consumer baseline) — https://play.google.com/store/apps/details?id=com.eero.android
