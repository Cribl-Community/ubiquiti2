# ubiquiti2 — Ubiquiti Network Monitor

## App overview
Rebuild of a Ubiquiti/UniFi network overview dashboard backed by UnPoller metrics in Cribl Search. The initial overview screen mirrors the supplied screenshot: KPI cards, throughput/client/drop charts, event summary, and device inventory.

## Architecture notes

- **`ROADMAP.md` is the planning source of truth** for where this app is going: what it surfaces today, the metric families we scrape but never query (measured with `.catalog` `queries30d`), the competitive comparison, the designer/PM/engineer lenses, and the phased plan with acceptance criteria. Check it before proposing new panels; update the "what we have" table when you add one.
- **Validate a metric before building a panel on it.** §2.1 of the roadmap records a validation pass that retired four *populated-but-always-zero* metrics (`vap_ccq_ratio`, `vap_dns_latency_average_seconds`, the radio airtime rx/tx split, `ast_be_xmit`). Series counts prove a metric exists, never that it means something; a "0" from a metric that never reports is not a healthy zero.
- **Two metric shapes that catch you out.** `unpoller_device_radio_{channel,ht,nss,transmit_power}` are *configuration* values — the channel is the metric's **value**, not a label, and they must be read per band (a `max()` across bands is meaningless for a channel number). The `unpoller_client_dpi_*` families are typed **gauges** (windowed counts, not monotonic counters), so they are read directly — wrapping them in `rate()` reports nonsense.
- **Ports read from `unpoller_device_port_*`**, joined to clients on `sw_port` == `port_name` (the pair ClientDetailPage already uses). A switch port can carry several clients (an AP uplink carries every wireless client behind it), so attribute a name only when exactly one client resolves; otherwise show the count.
- **`lint_app` is not sufficient.** Its bundled ESLint profile does not run the repo's `react-hooks/purity` (React Compiler) rule, which CI does enforce — `Date.now()` in a component body fails the build. Keep impure calls inside effects, and treat CI as authoritative.
- `src/routes/OverviewPage.tsx` owns the first dashboard screen and normalizes live metric values with conservative visual fallbacks.
- `src/api/metrics.ts` delegates to the framework's published metrics client (`@criblio/app-utils/metrics` — `cachedQueryInstant`/`cachedQueryRange`), not a hand-rolled fetch of `/search/query`; the framework owns URL building, NDJSON parsing, and job-status checking. Independent dashboard and metrics requests are issued **concurrently** — concurrent app fetches are supported, and the one-at-a-time gate this file used to describe was a workaround for a preview-only defect that no longer exists. Never add app-side serialization to work around a GoatTown preview error; report it as a preview defect instead.
- The Investigate page is driven by **GoatTown's server-side investigator** (durable sessions), not a browser agent loop. Both halves of that transport are the **framework's**, not ours:
  - `@criblio/app-utils/goattown` provides `GoatTownClient` (sessions, messages, lifecycle, list, protocol), `observeSession` (the poller — receipt tracking, cursor, backoff, hidden-tab pause), `runRequest`/`sendAndRun` (follow one turn to its receipt) and `SessionDiagnostics` (a redacted per-call record). `src/api/goattown.ts` is now only the app-specific remainder: the `goattown/connection` record, the write-only `goattownEmbedToken` key that `config/proxies.yml` injects from, the per-member session pointer/draft, and the connection diagnostics the pages show.
  - `@criblio/app-utils/kv` provides KV reads/writes and `memberKey()`. Two consequences matter: this app used to inject `${CRIBL_APP_ID}/` into the KV path (double-scoping), and member-scoped keys used the raw member id. `memberKey('goattown-sessions', memberId)` hex-encodes the id so a `:` or `%` cannot break the route, and `loadSessionState` still reads the old `goattown/sessions/{memberId}` key so an in-flight session survives the upgrade.
  - **The folding is `src/api/transcript.ts`** — `applyLoopEvent` for framework events, plus `foldUserTurn` for the one case the reducer has no opinion about (the wire user message and the composer's optimistic echo). Pure and dependency-light, unit-tested in `src/api/transcript.test.ts`; the old `src/api/wire-fold.ts` private mapper is gone. Keep it out of the transport: importing the transport in a plain Node test environment fails, which is what once made the suite uncollectable in CI.
  - The page renders `InvestigatorTranscript` + `MetricsToolCard` from `@criblio/app-utils/investigator`; an explicit Investigate action creates a session once and follows its receipt, reload/mount reattaches from the member session key, and an ambiguous create reconciles against server history rather than retrying. KV puts self-heal missing intermediate path segments (Cribl KV 404s a nested PUT whose parents do not exist — e.g. after a reinstall), and session-pointer saves are best-effort so a KV failure can never blank a live transcript.
- **The GoatTown first-run flow is the framework's too.** `src/routes/SettingsPage.tsx` binds the app's existing form to `useSetup` from `@criblio/app-utils/goattown/setup-panel`: the framework writes the service URL and the credential into the same two KV keys as before (`goattown/connection`, `goattownEmbedToken`), stages the bundled `goattown.config.yaml` with the top-level `producer:` stripped (the connection's credential names the producer, so a proposal carrying one is rejected), and verifies authentication, the active revision and the agent. Activation stays a human action in GoatTown's review page — nothing in this app activates anything. Note the two agent slugs: the app's interactive sessions use `investigator` (`DEFAULT_AGENT`, the slug the setup flow verifies), while the bundled configuration defines `ubiquiti-network-investigator` for the alert-driven schedules in that same file.
- **Framework libraries are pinned in `package.json`** (`@criblio/app-utils`, `@criblio/agent-protocol`, `@criblio/app-tooling`) and imported **by subpath, never from the package root** — the root drags `dotenv` → `node:fs/promises` into the browser graph and the Vite build dies resolving `readFile` against `__vite-browser-external`. tsc does not catch it; only the bundler does.
- **Do not fork framework code back into `src/`.** Charts and tables come from `@criblio/app-utils/viz` (the local `src/components/viz/*` copies of `LineChart`, `BarList` and `palette` are gone), design tokens and base styles from `@criblio/app-utils/styles/base.css` (imported once by `src/styles/global.css`, which no longer carries a copy of the token sheet — the package's `tokens.css` is a superset of what was copied, plus the alias/gap tokens the package's own stylesheets reference), time ranges and bin widths from `@criblio/app-utils/time`, and URL state from `@criblio/app-utils/url-state` (`src/components/TimeRange.tsx` keeps the app's three ranges and its control, but the selection lives in `?range=` so reload, Back and shared links keep it).
- `src/api/investigator.ts` holds only the prompts (`buildServerPrompt`, `investigatePrompt`, `SUGGESTED_QUESTIONS`). The unreachable browser agent-loop wiring that used to live there — advertised tool definitions, executors, the metrics catalog, the context builder — was deleted rather than kept as a second, divergent way to run an investigation.
- The bearer token for GoatTown is proxy-injected from KV `goattownEmbedToken` (see `config/proxies.yml`, host `goattown-shared.lab.cribl.io`); browser code only forwards `x-goattown-user` from `window.getCriblUser()`. A different host requires a `proxies.yml` entry + repackage.
- **Mesh topology** comes from the PATCHED unpoller build's device uplink metrics (`src/api/metrics.ts` → `queryMeshEdges`): `unpoller_device_uplink_info{uplink_type="wireless"}` gives child→parent edges (labels are the payload — `uplink_device` is the parent NAME; never filter the constant-1 value), and `tx_rate + rx_rate` by child name weights the edges (populated on wireless only; controller-native units). Caveat: these series do NOT exist in upstream unpoller — a container rebuild from ghcr.io/unpoller/unpoller removes them, and the map then loses its mesh edges — there is no manual override. Earlier findings that remain true: the WIRELESS `unpoller_topology_link_rate_mbps` series never reach the store (NaN over remote-write), and `unpoller_topology_link_experience_score{link_type="WIRELESS"}` edges are AP→client associations, NOT device backhaul — do not conflate them. A Stream/JSON-webserver feed was built and rolled back (unpoller's webserver flattens payloads and drops `uplink`).
- **Device classification gotcha (validated):** UniFi reports Dream-Machine-AP-class hardware (model UDMA69B, 9 devices named "AP … 7") as `type="udm"`; the only true gateway is UDMPROSE ("Sharp - Los Gatos"). Never filter APs by `type="uap"` and never treat `type="udm"` as gateway-only. Device metrics carry no `model` label and the metrics store has no vector `or`, so `src/api/metrics.ts` provides `apScoped(metric, extra?)` (APs = uap + udm/UDMA, joined against `unpoller_device_info{model=~"UAP.*|UDMA.*|UK.*"}` constant-1) and `gatewayScoped(metric, extra?)` (udm minus UDMA) for all label-filtered device queries.
- Keep Search endpoints in the `default_search` group. KV writes must use `text/plain`.
- **unpoller site gauges split by `subsystem` × `status` (validated):** `unpoller_site_users/_guests/_iots/_receive_rate_bytes/_transmit_rate_bytes` carry `subsystem` (lan/wlan/wan/www/vpn) and `status` labels. During controller API hiccups, brief `status="error"`/`"warning"` rows appear that DUPLICATE the `ok` counts (observed: 80 → 162 client-count spikes for 1–2 samples) — unfiltered `sum()` double-counts them. Always scope site-gauge sums to `{status="ok"}` (OverviewPage does), and scope throughput to `subsystem=~"wan|lan"` — `wan` mirrors `www` exactly (exclude it), and `lan` already contains the Wi-Fi clients' traffic (don't add `wlan` on top). Chart spikes that exit the plot frame are also fixed: LineChart clips series to the plot box.

## Configuration (`/configuration`)

Everything a user configures about this app is **one page with two tabs**, not two
sidebar items: `src/routes/ConfigurationPage.tsx` renders Settings (dataset and
GoatTown connection — `SettingsPage.tsx`) and Alerts setup (the monitor
inventory and provisioning — `SetupPage.tsx`). The selected tab is `?tab=settings`
(default) or `?tab=alerts`, so Back, reload and a shared link keep it. `/setup`
redirects to `?tab=alerts`, and the old `/settings` route redirects to `/configuration`.
Keep both: a browser sitting on a URL this app no longer serves matches no route, and React
Router then renders *nothing* — which reached us as "the app mounted nothing (no runtime error
was caught)". For the same reason `src/App.tsx` ends its route table with `path="*"`
redirecting to `/`, so no unmatched path is ever an empty page. Do not *nest* real screens
under a path containing "settings" (the host shell intercepts those); a redirect is enough. Each tab renders a page component
that owns its own section content and no longer renders its own `<h1>`.

`src/routes/SetupPage.tsx` inventories this workspace and upserts the network alerts. It is
the supported way to provision them — do not hand-create monitors in the UI.

- **Specs are data.** `src/api/alertSpecs.ts` holds the five alerts: managed id, name,
  PromQL, operator/limit, evaluation window, priority, and the trap that makes each one
  correct. Adding an alert means adding a spec; the page picks it up. All five are P1 by
  design (see ROADMAP.md for why the set stays small).
- **Transport.** `src/api/monitors.ts` calls
  `/products/lakehouse_engine_metrics/monitors` — unlike anything under `/search/*`, it takes
  no group prefix — through the framework's `createBrowserHttpClient()` from
  `@criblio/app-utils/provisioner`. A 403/404 becomes `unsupported` and the page degrades to
  read-only guidance rather than half-applying.
- **Inventory is read-only and runs on load:** monitor list, metrics freshness (device
  count plus the age of the newest sample), notification targets, log dataset. The GoatTown
  agent/profile/skill are reported as *declared*, never *verified* — `GET
  /ai/sessions/{slug}` answers "Invalid agent slug" even for a known-good agent, so it is
  not an existence test and the page does not pretend otherwise.
- **Reconcile, then apply on click.** Rows use the framework provisioner's vocabulary —
  `create` / `update` / `noop` — shown as `not created`, `needs update`, `up to date`, with
  the differences spelled out. Writes are sequential and independent (one failure does not
  abort the rest) and never destructive: monitors are created with an `ubiquiti2__` id, and
  `applyRow` refuses to create anything that does not carry that prefix, because the prefix
  is what bounds this app's blast radius. A monitor a human made is **adopted by exact name**
  and updated in place instead of duplicated.
- **The algorithm is mirrored, not imported.** APM's `src/api/provisioner.ts` is 42 lines
  because the reconciliation itself lives in `@criblio/app-utils/provisioner`. That
  `reconcile()` is bound to saved searches (`ProvisionedSearch`,
  `/m/default_search/search/saved`) and cannot provision monitors, so `monitors.ts` mirrors
  its shape — including the `isSameAsPlan`/`deepSubset` lesson that comparison must be
  "what we set is present", never exact equality, or every reconcile re-patches forever.
- **One deliberate divergence from APM:** its reconcile deletes `<prefix>*` saved searches
  absent from its plan. Here an app-created monitor absent from the specs is listed as an
  orphan and never removed automatically — silently deleting a live alert is not an
  acceptable side effect of pressing "re-check". Foreign monitors (neither our id nor a known
  name) are likewise listed and left untouched.
- **Verify by re-reading.** After applying, the page reloads and shows the stored `promql`
  for each monitor. That read-back is the point: the mesh alert carries its
  `uplink_type="wireless"` filter inside `promql` with `builder.labelFilters` empty (the
  entry shape is still unknown), so the stored expression is what proves the filter survived.
- **The payload shape is observed, not documented.** `expr`, `firingCondition`,
  `firingRule`, `notification` and `priority` are `oneOf` nulls in the API spec. The shape in
  `monitorPayload()` was read back off a monitor created by hand in the Search UI. Updates
  PATCH the full desired document minus `id`, so they are correct whether PATCH turns out to
  be partial or a full replacement.
- `METRICS_DATASET` is `'metrics'` in this workspace; not every workspace names it that.

## Design system
The overview uses a light gray canvas (`#f7f8fa`), white bordered cards, compact Open Sans typography, blue `#347fce` primary series, green `#238b3c` secondary series, and pink `#d65b8d` IoT series. Preserve the two-column panel grid, eight-card KPI row, and compact inventory table unless the reference screen changes.

## Platform rules
Use `window.CRIBL_API_URL` for Cribl calls, never hard-code workspace URLs. All `/search/` API calls use `/m/default_search`. External hosts must be declared in `config/proxies.yml`. Build after meaningful changes; do not deploy without user approval.

# Cribl App Platform Developer Guide

## Global Variables

The following are set on `window` automatically when your app runs inside Cribl. They are read-only and always present.

| Variable | Example | Description |
|---|---|---|
| `CRIBL_API_URL` | `https://localhost:9000/api/v1` | Base URL for all Cribl API calls |
| `CRIBL_BASE_PATH` | `/app-ui/my-app` | The base path your app is mounted at |
| `getCriblUser` | `() => Promise<CriblUser>` | The signed-in user — see below |

### Signed-in user identity

`window.getCriblUser()` returns a **memoized** Promise resolving to the
member viewing your app. Available in installed Apps and in Live Preview.

```js
const user = await window.getCriblUser();
// { id, username, email?, firstName?, lastName?, initials? }
```

| Field | Always present | Notes |
|---|---|---|
| `id` | yes | Stable member id — the field to key storage on |
| `username` | yes | Login name |
| `email` / `firstName` / `lastName` / `initials` | no | May be absent depending on the member record |

Call it once at startup and keep the result — it's memoized, so repeat
calls are cheap, but threading one value through your app is simpler than
awaiting a Promise in every component.

The intended use is **distinguishing members**: per-member preferences,
"last viewed" state, an avatar in the header. Namespace the KV key on
`user.id`:

```js
fetch(`${window.CRIBL_API_URL}/kvstore/prefs/${user.id}`, { method: 'PUT', body });
```

**It is identity, not authorization.** Two limits, and neither has a
workaround in the app:

- **No roles or permissions.** The platform states this plainly: the call
  provides identity only. If a feature should be admin-only, the API call
  behind it must be what enforces that — the proxy injects the caller's
  auth, so a request the member isn't entitled to make fails on the server.
  Hiding the button is presentation, not a control.
- **It does not reach your backend.** This is a browser-side call with no
  signed token attached, and `proxies.yml` header-injection expressions
  support only string literals, `kv.<key>`, and concatenation — there is no
  user context to inject. So a backend of your own can only be *told* who
  is asking, by a client that could say anything. Use it for separation
  (each member gets their own drawer), never for isolation (keeping one
  member out of another's). Keying a *credential* or any secret on a
  client-asserted id looks like it enforces per-user access while
  enforcing nothing.

## How API Calls Work (Fetch Proxy)

Your app runs inside a sandboxed iframe. The platform **automatically intercepts all `fetch()` calls** to `CRIBL_API_URL` and proxies them through the parent window. This is transparent to your code — just use `fetch()` normally.

**What the proxy does for you:**
- Injects authentication headers (your app never sees or handles auth tokens)
- Rewrites URLs to scope requests to your app's pack
- Streams responses back to your app

**What this means for your code:**
- Use `fetch()` as normal — it just works
- You do NOT need to handle authentication
- You cannot override or replace `window.fetch` (it is locked)
- **Every external request is proxied and checked against `config/proxies.yml`.**
  There is no "direct" path out of the iframe — see below.

### There is no un-proxied egress

A host not declared in `config/proxies.yml` returns
`403 {"error":"Domain example.com:443 is not declared in proxies.yml"}`.
Enforced twice — a `fetch`/XHR wrapper in your realm, and the iframe CSP —
so there is no way around it:

- A `Worker` or child iframe gets an unpatched native `fetch`, but inherits
  the CSP and still fails (`TypeError`, not a 403). `<img>`/`<script>` are
  blocked too. Don't spend time here.
- `localhost`/`127.0.0.1` are unreachable; declaring them dials Cribl's own
  loopback, not the user's machine. Private IPs are blocked (SSRF).
- `proxies.yml` is checked at **runtime**, not just packaging: a new host
  needs a file edit and a repackage, never a setting.
- The frame's origin is opaque (`self.origin === "null"`, not
  `location.origin`), so origin-gated APIs are unavailable —
  `navigator.serviceWorker` throws on *property access*, so feature-detect
  inside `try`/`catch`.

### URL Rewriting Rules

The proxy applies these rewrites automatically:

| What you call | What actually happens | Why |
|---|---|---|
| `fetch(CRIBL_API_URL + '/kvstore/my-key')` | Rewritten to `/api/v1/p/{yourPackId}/kvstore/my-key` | Scopes KV store access to your pack |
| `fetch(CRIBL_API_URL + '/proxy/some/path')` | Rewritten to `/api/v1/p/{yourPackId}/proxy/some/path` | Scopes proxy calls to your pack |
| `fetch('https://api.example.com/data')` | Rewritten to `/api/v1/p/{yourPackId}/proxy/api.example.com/data` — **403 unless `api.example.com` is declared in `config/proxies.yml`** | External calls are routed through the platform proxy |
| `fetch(CRIBL_API_URL + '/search/jobs')` | Passed through as-is | Standard API calls are not rewritten |

**Important:** Your app cannot access other packs' resources. Any request targeting a different pack ID will be rejected.

### Request Timeout

Proxied requests time out after **30 seconds** if no response is received. Use `AbortController` if you need to cancel requests earlier.

## Platform APIs

API endpoint definitions are available in `openapi.json` (if downloaded during project setup).

### Key-Value Store

Each app has a scoped KV store. Use `CRIBL_API_URL` as the base — the proxy handles scoping.

| Operation | Method | URL | Body |
|---|---|---|---|
| Get | GET | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| Set | PUT | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | value |
| Delete | DELETE | `CRIBL_API_URL + '/kvstore/the/path/to/key'` | — |
| List keys | POST | `CRIBL_API_URL + '/kvstore/keys'` | `{ prefix: 'my/key/prefix' }` |

### Config Group Context

Cribl REST API endpoints that don't begin with `/system/` are contextual and can be called in the context of a config group using the prefix `/m/:groupId`. Config groups can be listed using the `/master/groups` endpoint.

Endpoints beginning with `/search/` should ALWAYS use `groupId` set to `default_search` — for example: `/m/default_search/search/jobs`. Never use any other group ID for search endpoints.

When asked to build a feature, always inspect Cribl REST APIs and understand the context of the request before starting to build.

### External API Calls

To call external APIs, just use `fetch()` with the full URL. The platform will automatically route these through your pack's proxy endpoint. The external domain must be declared in your app's `config/proxies.yml`.

### proxies.yml — External Domain Configuration

Your app must declare every external domain it needs to access in `config/proxies.yml`. This file lives in your project's `config/` directory and gets packaged with your app. Admins can see exactly which external endpoints your app communicates with at install time.

**Schema:**

```yaml
# config/proxies.yml
# Top-level keys are domain:port pairs (port optional, defaults to 443)

api.openai.com:
  timeout: 10000          # Optional: request timeout in ms (1000–120000, default 30000)

  paths:                   # Optional: control which URL paths are allowed
    allowlist:             # Prefix match — request path must start with one of these
      - /v1/chat/
      - /v1/models
    blocklist:             # Prefix match — these paths are always blocked (takes precedence over allowlist)
      - /v1/admin/

  headers:                 # Optional: control header forwarding and injection
    inject:                # Headers to add to every outgoing request to this domain
      x-api-key: "'static-key'"
      Authorization: "'Bearer ' + kv.openaiApiKey"
      x-custom: kv.myHeaderValue
    allowlist:             # Only forward these headers from the original request (supports wildcards)
      - content-type
      - accept
      - x-custom-*
    blocklist:             # Never forward these headers (takes precedence, supports wildcards)
      - x-internal-*
```

**Header injection expressions** support:
- String literals: `"'my-static-value'"`
- KV store lookups: `kv.mySecretKey` (resolves encrypted KV values at request time)
- Concatenation: `"'Bearer ' + kv.apiToken"`

**Security notes:**
- Sensitive headers (`cookie`, `authorization`, `proxy-authorization`, `host`, `connection`, `transfer-encoding`) are always stripped from the original request before forwarding — use `headers.inject` to set auth headers instead
- The platform validates target domains against SSRF protections (private/reserved IPs are blocked)
- Requests are rate-limited per pack (100 requests/minute)
- All proxied requests use HTTPS

**Example — minimal config for a single API:**

```yaml
# config/proxies.yml
api.example.com:
  headers:
    inject:
      Authorization: "'Bearer ' + kv.apiKey"
```

**Example — multiple domains with path restrictions:**

```yaml
# config/proxies.yml
api.openai.com:
  timeout: 60000
  paths:
    allowlist:
      - /v1/chat/completions
      - /v1/embeddings
  headers:
    inject:
      Authorization: "'Bearer ' + kv.openaiKey"

hooks.slack.com:
  paths:
    allowlist:
      - /services/
  headers:
    inject:
      Content-Type: "'application/json'"
```

**How it connects to fetch:** When your app calls `fetch('https://api.openai.com/v1/chat/completions', ...)`, the platform rewrites this to `/api/v1/p/{yourPackId}/proxy/api.openai.com/v1/chat/completions`, looks up `api.openai.com` in your `proxies.yml`, validates the path, injects headers, and forwards the request.

## React Router

When using React Router, set the basename to `window.CRIBL_BASE_PATH`:

```jsx
<BrowserRouter basename={window.CRIBL_BASE_PATH}>
```

## Navigation

The platform synchronizes navigation between your app and the parent Cribl UI. If you use `history.pushState()` or `history.replaceState()`, the parent URL bar will update to reflect your app's current route. Navigation changes from the parent are also forwarded to your app as `popstate` events.

