# Ubiquiti2

Ubiquiti2 is a read-only Cribl App for monitoring a Ubiquiti/UniFi network with
[unPoller](https://unpoller.com/) metrics and UniFi controller logs.

## Features

- **Overview** — network health, throughput, clients, events, and device inventory
- **Access Points** — AP health, channel utilization, wireless traffic, and connected clients
- **Switches** — ports, throughput, PoE, errors, drops, and syslog
- **Gateway** — UDM throughput, packets, load, drops, latency, and temperatures
- **Clients** — signal, throughput, PHY rate, retries, satisfaction, DPI, and connection history
- **Map** — interactive gateway-to-client topology
- **Events** — controller events and device syslog
- **Network Investigator** — read-only AI-assisted investigations over UniFi metrics and logs

Most pages support a time range, 30-second auto-refresh, and manual refresh.
Devices and clients can be opened for detailed views, and detail pages can
launch a preconfigured investigation.

## Data requirements

The app expects these streams in the Cribl workspace:

1. **Metrics** — `unpoller_*` Prometheus metrics in the `metrics` dataset,
   backed by the `homelab` metrics engine. These provide client, device, site,
   throughput, retry, and roam data.
2. **Logs** — UniFi controller events and device syslog in the `main` dataset.
   Controller events should be CEF records containing `CEF:0|Ubiquiti`; device
   logs should be RFC 3164 syslog.

To verify that metrics are available, run this in Cribl Search:

```text
.catalog unpoller_
```

### Collecting metrics with unPoller

1. Create a local, read-only UniFi controller user.
2. Run unPoller on a host that can reach the controller. For Docker:

   ```bash
   docker run -d --name unpoller --restart unless-stopped \
     -p 9130:9130 \
     -e UP_UNIFI_DEFAULT_URL="https://<controller-ip>:8443" \
     -e UP_UNIFI_DEFAULT_USER="unpoller" \
     -e UP_UNIFI_DEFAULT_PASS="<password>" \
     -e UP_PROMETHEUS_DISABLE=false \
     qmcgaw/unifi-poller
   ```

3. Configure a Cribl Stream Prometheus source to scrape
   `http://<unpoller-host>:9130/metrics` every 30–60 seconds and route it to
   the metrics engine used by `homelab`.
4. Configure UniFi Remote Syslog to send controller events and device logs to
   Cribl, routing them to `main`.

The app expects the current `unpoller_` metric prefix. Older releases may use
`unifipoller_`; upgrade unPoller or configure its namespace accordingly.

## Development

```bash
npm install
npm run dev       # standalone development server
npm run verify    # lint, tests, and typecheck
npm run build     # production build
npm run package   # build and package the Cribl App
npm run deploy    # install into the current Cribl workspace
```

The project uses Vite, React 19, and TypeScript. The Cribl App platform bundles
it with esbuild and esm.sh. Data access lives in `src/api/`, reusable charts
and layout components live in `src/components/`, and dashboard pages live in
`src/routes/`. Search requests use the `default_search` context. No external
API domains are required; `config/proxies.yml` is intentionally empty.
