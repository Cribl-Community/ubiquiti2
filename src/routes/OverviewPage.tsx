import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  METRICS_ERROR_EVENT,
  clearMetricsFailure,
  lastMetricsFailure,
  latestMetric,
  queryMetric,
  type MetricPoint,
  type MetricsFailure,
} from '../api/metrics';
import StatusBanner from '../components/StatusBanner';
import LineChart, { type LineSeries } from '../components/viz/LineChart';
import { runQuery } from '../api/cribl';
import { useTimeRange } from '../components/TimeRange';
import s from './OverviewPage.module.css';

type Device = { name: string; type: string; model: string; ip: string; version: string; clients: number; cpu: number; memory: number; uptime: string };
const initialDevices: Device[] = [];
/* Same aggregation the Events page's stat bars use — controller events by type. */
const EVENTS_COUNT_QUERY = `dataset="main" | where _raw contains "CEF:0|Ubiquiti" `
  + `| extend evt_name=extract(@"CEF:0\\|Ubiquiti\\|UniFi Network\\|[^|]*\\|\\d+\\|([^|]*)\\|",1,_raw) `
  + `| summarize count_ = count() by evt_name | sort by count_ desc`;
const chartSeries = (name: string, color: string, points: MetricPoint[], format?: (v: number) => string): LineSeries => ({ name, color, data: points.map((p, i) => ({ t: (p.time ?? Date.now() - (points.length - i) * 120000) * (p.time && p.time < 10000000000 ? 1000 : 1), v: p.value })), format });
function Panel({ title, subtitle, children, className = '' }: { title: string; subtitle?: string; children: ReactNode; className?: string }) { return <section className={`${s.panel} ${className}`}><div className={s.panelHead}><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{children}</section>; }

export default function OverviewPage() {
  const tr = useTimeRange();
  const [values, setValues] = useState({ aps: 0, switches: 0, gateways: 0, users: 0, guests: 0, iots: 0, latency: 0, uptime: 0 });
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [receive, setReceive] = useState<MetricPoint[]>([]); const [transmit, setTransmit] = useState<MetricPoint[]>([]); const [userSeries, setUserSeries] = useState<MetricPoint[]>([]);
  const [guestSeries, setGuestSeries] = useState<MetricPoint[]>([]); const [iotSeries, setIotSeries] = useState<MetricPoint[]>([]); const [dropSeries, setDropSeries] = useState<MetricPoint[]>([]);
  const [eventRows, setEventRows] = useState<[string, number][]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<MetricsFailure | null>(lastMetricsFailure());

  // Metrics failures used to render as silent empty states; surface the
  // most recent one. New refreshes clear it before the queries re-fire.
  useEffect(() => {
    const onError = (e: Event) => setMetricsError((e as CustomEvent<MetricsFailure>).detail);
    window.addEventListener(METRICS_ERROR_EVENT, onError);
    return () => window.removeEventListener(METRICS_ERROR_EVENT, onError);
  }, []);
  useEffect(() => {
    clearMetricsFailure();
    setMetricsError(null);
  }, [tr.refreshKey]);
  useEffect(() => { void queryMetric('unpoller_device_info').then(rows => setDevices(rows.map(r => ({ name: r.labels?.name ?? 'Unknown', type: (r.labels?.type ?? 'unknown').toUpperCase(), model: r.labels?.model ?? '—', ip: r.labels?.ip ?? '—', version: r.labels?.version ?? '—', clients: 0, cpu: 0, memory: 0, uptime: '—' })))).catch(() => undefined); }, [tr.earliest, tr.range, tr.refreshKey]);
  useEffect(() => { void Promise.all([latestMetric('sum(unpoller_site_aps)',7),latestMetric('sum(unpoller_site_switches)',6),latestMetric('sum(unpoller_site_gateways)',1),latestMetric('sum(unpoller_site_users)',79),latestMetric('sum(unpoller_site_guests)',0),latestMetric('sum(unpoller_site_iots)',1),latestMetric('1000 * avg(unpoller_site_latency_seconds)',18),latestMetric('max(unpoller_site_uptime_seconds)',1296000)]).then(([aps,switches,gateways,users,guests,iots,latency,uptime]) => setValues({ aps,switches,gateways,users,guests,iots,latency,uptime })); void Promise.all([queryMetric('sum(unpoller_site_receive_rate_bytes)',tr.step,tr.earliest),queryMetric('sum(unpoller_site_transmit_rate_bytes)',tr.step,tr.earliest),queryMetric('sum(unpoller_site_users)',tr.step,tr.earliest),queryMetric('sum(unpoller_site_guests)',tr.step,tr.earliest),queryMetric('sum(unpoller_site_iots)',tr.step,tr.earliest),queryMetric('rate(unpoller_site_intenet_drops_total[5m])',tr.step,tr.earliest)]).then(([r,t,u,g,i,d]) => { if(r.length) setReceive(r); if(t.length) setTransmit(t); if(u.length) setUserSeries(u); if(g.length) setGuestSeries(g); if(i.length) setIotSeries(i); if(d.length) setDropSeries(d); }); }, [tr.earliest, tr.range, tr.refreshKey, tr.step]);
  useEffect(() => {
    setEventsLoading(true);
    let stale = false;
    void runQuery(EVENTS_COUNT_QUERY, tr.earliest, 'now', 50)
      .then(rows => { if (!stale) setEventRows(rows.map(r => [String(r.evt_name ?? '—'), Number(r.count_ ?? 0)] as [string, number])); })
      .catch(() => { if (!stale) setEventRows([]); })
      .finally(() => { if (!stale) setEventsLoading(false); });
    return () => { stale = true; };
  }, [tr.earliest, tr.range, tr.refreshKey]);
  const cards = [['Access points', values.aps, ''], ['Switches', values.switches, ''], ['Gateways', values.gateways, ''], ['Clients', values.users, ''], ['Guests', values.guests, ''], ['IoT devices', values.iots, ''], ['WAN latency', `${values.latency.toFixed(1)} ms`, 'blue'], ['Uplink uptime', `${Math.floor(values.uptime / 86400)}d ${Math.floor(values.uptime / 3600) % 24}h`, '']];
  const receiveSeries = chartSeries('Receive', '#347fce', receive, v => `${(v / 1024 / 1024).toFixed(1)} MB/s`);
  const transmitSeries = chartSeries('Transmit', '#238b3c', transmit, v => `${(v / 1024 / 1024).toFixed(1)} MB/s`);
  const users = chartSeries('Users', '#347fce', userSeries, v => v.toFixed(0));
  const guests = chartSeries('Guests', '#238b3c', guestSeries, v => v.toFixed(0));
  const iots = chartSeries('IoT', '#d65b8d', iotSeries, v => v.toFixed(0));
  const maxEvents = Math.max(1, ...eventRows.map(([, c]) => c));
  return <div className={s.page}>{metricsError && <StatusBanner kind="error">Metrics query failed: {metricsError.message} — query: <code>{metricsError.query}</code></StatusBanner>}<header className={s.header}><div><h1>Network Overview <small>UniFi via UnPoller</small></h1></div><div className={s.controls}>{tr.rangeSelect}{tr.autoSelect}<button aria-label="Refresh" onClick={tr.refresh}>↻</button></div></header><div className={s.cards}>{cards.map(([label,value,kind]) => <div className={s.card} key={String(label)}><span>{label}</span><strong className={kind === 'blue' ? s.blue : ''}>{value}</strong></div>)}</div><div className={s.grid}><LineChart title="Site throughput" subtitle="unpoller_site_*_rate_bytes" series={[receiveSeries, transmitSeries]} height={190} area/><LineChart title="Connected clients" subtitle="users / guests / IoT" series={[users, guests, iots]} height={190} yMax={100}/><LineChart title="Internet drops" subtitle="rate(unpoller_site_intenet_drops_total[5m])" series={[chartSeries('Drops', '#347fce', dropSeries)]} height={190} yMax={1}/><Panel title="Network events" subtitle="from the UniFi log streams, over the selected window"><div className={s.events}>{eventRows.map(([name,count]) => <div key={String(name)}><span>{name}</span><b style={{width:`${Math.max(2,Math.round(Number(count)*82/maxEvents))}%`}}/><em>{count}</em></div>)}{!eventRows.length&&<div className={s.eventsEmpty}>{eventsLoading?'Loading…':'No controller events in this time range'}</div>}<Link to="/events">View all events →</Link></div></Panel></div><Panel title="Device inventory" subtitle={`${devices.length} devices — APs and switches drill through`}><div className={s.tableWrap}><table><thead><tr>{['Device','Type','Model','IP','Version','Clients','CPU','Memory','Uptime'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{devices.map(d=><tr key={d.name}><td><Link to={d.type === 'UAP' ? `/aps/${encodeURIComponent(d.name)}` : d.type === 'USW' ? `/switches/${encodeURIComponent(d.name)}` : '/gateway'}>{d.name}</Link></td><td>{d.type}</td><td>{d.model}</td><td>{d.ip}</td><td>{d.version}</td><td>{d.clients}</td><td>{d.cpu.toFixed(1)}%</td><td>{d.memory.toFixed(1)}%</td><td>{d.uptime}</td></tr>)}</tbody></table></div></Panel></div>;
}