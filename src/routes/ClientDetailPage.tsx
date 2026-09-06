import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { queryMetric, type MetricPoint } from '../api/metrics';
import { runQuery } from '../api/cribl';
import LineChart, { type LineSeries } from '../components/viz/LineChart';
import BarList, { type BarListItem } from '../components/viz/BarList';
import EmptyTableRows from '../components/EmptyTableRows';
import { investigatePrompt } from '../api/investigator';
import { useTimeRange } from '../components/TimeRange';
import s from './ClientDetailPage.module.css';

const colors = ['#347fce', '#238b3c', '#d36b96', '#d69d2d'];
const asSeries = (name: string, color: string, rows: MetricPoint[], format?: (v: number) => string): LineSeries => ({ name, color, data: rows.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)).map(r => ({ t: (r.time ?? 0) < 1e10 ? (r.time ?? 0) * 1000 : r.time!, v: r.value })), format });
const value = (v: string, format: (n: number) => string) => v === '' ? '—' : format(Number(v));

export default function ClientDetailPage() {
  const { clientName = '' } = useParams(); const name = decodeURIComponent(clientName); const navigate = useNavigate(); const tr = useTimeRange();
  const [info, setInfo] = useState<Record<string, string>>({ ap: '', network: '', ip: '', rssi: '', satisfaction: '', uptime: '', mac: '', wired: '', swName: '', swPort: '' });
  const [charts, setCharts] = useState<Record<string, LineSeries[]>>({}); const [apps, setApps] = useState<BarListItem[]>([]); const [events, setEvents] = useState<string[][]>([]); const [eventsLoading, setEventsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const q = (query: string, step?: number) => queryMetric(query, step, tr.earliest); setEventsLoading(true);
    void q(`unpoller_client_uptime_seconds{name="${name}"}`).then(async identity => {
      const labels = identity.at(-1)?.labels ?? {}; const wired = labels.wired === 'true'; const mac = labels.mac ?? '';
      if (cancelled) return;
      setInfo(i => ({ ...i, ap: labels.ap_name ?? '', network: labels.essid ?? labels.network ?? '', ip: labels.ip ?? '', mac: labels.mac ?? '', wired: wired ? 'true' : 'false', swName: labels.sw_name ?? '', swPort: labels.sw_port ?? '', uptime: identity.at(-1) ? String(identity.at(-1)!.value) : '' }));
      const selector = labels.mac ? `mac="${labels.mac}"` : `name="${name}"`;
      const requests: Promise<MetricPoint[]>[] = [q(`100 * avg(unpoller_client_satisfaction_ratio{${selector}})`, tr.step), q(`sum(rate(unpoller_client_receive_bytes_total{${selector}}[5m]))`, 60), q(`sum(rate(unpoller_client_transmit_bytes_total{${selector}}[5m]))`, 60), q(`topk(10, sum by (application) (unpoller_client_dpi_receive_bytes{${selector},application!="TOTAL"}))` )];
      if (!wired) requests.push(q(`avg(unpoller_client_rssi_db{${selector}})`, 60), q(`avg(unpoller_client_radio_receive_rate_bps{${selector}})`, 60), q(`avg(unpoller_client_radio_transmit_rate_bps{${selector}})`, 60), q(`sum(rate(unpoller_client_transmit_retries_total{${selector}}[5m]))`, 60));
      const result = await Promise.all(requests); if (cancelled) return;
      const sat = result[0], down = result[1], upload = result[2], dpi = result[3];
      const next: Record<string, LineSeries[]> = { throughput: [asSeries('Download', colors[0], down, v => `${(v / 1024 / 1024).toFixed(2)} MB/s`), asSeries('Upload', colors[1], upload, v => `${(v / 1024 / 1024).toFixed(2)} MB/s`)], satisfaction: [asSeries('Satisfaction', colors[0], sat, v => `${v.toFixed(1)}%`)] };
      setInfo(i => ({ ...i, satisfaction: sat.at(-1) ? String(sat.at(-1)!.value) : i.satisfaction }));
      setApps(dpi.filter(x => Number.isFinite(x.value) && x.value > 0).map(x => ({ label: x.labels?.application ?? 'Unknown', value: x.value })).sort((a, b) => b.value - a.value));
      if (!wired) { next.signal = [asSeries('RSSI', colors[0], result[4], v => `${v.toFixed(0)} dB`)]; next.phy = [asSeries('Receive PHY', colors[0], result[5], v => `${(v / 1e6).toFixed(0)} Mbps`), asSeries('Transmit PHY', colors[1], result[6], v => `${(v / 1e6).toFixed(0)} Mbps`)]; next.retries = [asSeries('Retries', colors[0], result[7], v => v.toFixed(2))]; }
      else if (labels.sw_name && labels.sw_port) { const speed = await q(`unpoller_device_port_port_speed_bps{name="${labels.sw_name}",port_name="${labels.sw_port}"}`); next.phy = [asSeries('Negotiated link speed', colors[0], speed, v => `${(v / 1e9).toFixed(2)} Gbps`)]; }
      setCharts(next);
      void runQuery(`dataset="main" | where _raw contains "CEF:0|Ubiquiti" | extend evt_name=extract(@"CEF:0\\|Ubiquiti\\|UniFi Network\\|[^|]*\\|\\d+\\|([^|]*)\\|",1,_raw), client=extract(@"UNIFIclientHostname=(.*?) UNIFI[A-Za-z]",1,_raw), client_mac=extract(@"UNIFIclientMac=(\\S+)",1,_raw), prev_ap=extract(@"UNIFIlastConnectedToDeviceName=(.*?) UNIFI[A-Za-z]",1,_raw), ap=extract(@"UNIFIconnectedToDeviceName=(.*?) UNIFI[A-Za-z]",1,_raw) | where client_mac == "${labels.mac ?? ''}" or client == "${name}" | project _time,evt_name,prev_ap,ap | sort by _time desc | limit 100`, tr.earliest, 'now', 100).then(rows => setEvents(rows.map(r => [new Date(Number(r._time) * 1000).toLocaleString(), String(r.evt_name ?? 'Event'), String(r.ap ?? '—'), String(r.prev_ap && r.ap ? `${r.prev_ap} → ${r.ap}` : 'Connection event')]))).catch(() => undefined).finally(() => setEventsLoading(false));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [name, tr.earliest, tr.range, tr.refreshKey]);
  const duration = (v: string) => v === '' ? '—' : `${Math.floor(Number(v) / 86400)}d ${Math.floor(Number(v) / 3600) % 24}h`;
  const card = (label: string, v: string) => <div key={label}><span>{label}</span><strong>{label === 'Access point' && v ? <Link to={`/aps/${encodeURIComponent(v)}`}>{v}</Link> : v || '—'}</strong></div>;
  return <div className={s.page}><Link className={s.back} to="/clients">← All clients</Link><header><h1>{name || 'Client'} <small>Client detail{info.mac ? ` · ${info.mac}` : ''}</small></h1><div className={s.actions}><button onClick={() => navigate('/investigate', { state: { question: investigatePrompt.client(name, info.mac) } })}>Investigate</button>{tr.rangeSelect}{tr.autoSelect}<button onClick={tr.refresh}>↻</button></div></header><div className={s.cards}>{[card('Access point', info.ap), card('Network', info.network), card('IP', info.ip), card('RSSI', info.wired === 'true' ? '—' : value(info.rssi, n => `${n.toFixed(0)} dB`)), card('Satisfaction', value(info.satisfaction, n => `${n.toFixed(1)}%`)), card('Uptime', duration(info.uptime))]}</div><div className={s.grid}><LineChart title="Signal" subtitle="RSSI (dB) — higher is better" series={charts.signal ?? []} height={250}/><LineChart title="Throughput" series={charts.throughput ?? []} height={250} area/><LineChart title="Negotiated PHY rate" subtitle={info.wired === 'true' ? 'wired port link speed' : 'wireless radio link speed'} series={charts.phy ?? []} height={250}/><LineChart title="Transmit retries" subtitle="retries/s, rate over 5m" series={charts.retries ?? []} height={250}/><LineChart title="Satisfaction" series={charts.satisfaction ?? []} height={250} yMax={100} area/><div className={s.list}><h2>Top applications (DPI)</h2><BarList items={apps} format={v => `${(v / 1024 / 1024).toFixed(1)} MB`}/></div></div><section className={s.events}><div className={s.section}><h2>Connection history</h2><span>{info.wired === 'true' ? 'Wired client — wireless roam history is not applicable' : 'connects, roams, disconnects for this client'}</span></div><table><thead><tr>{['Time', 'Event', 'AP', 'Detail'].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{events.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}{events.length === 0 && <EmptyTableRows columns={4} rows={4} loading={eventsLoading} emptyMessage={info.wired === 'true' ? 'No wired connection events in this time range' : 'No connection events in this time range'}/>}</tbody></table></section></div>;
}
