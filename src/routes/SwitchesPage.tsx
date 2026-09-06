import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { queryMetric, type MetricPoint } from '../api/metrics';
import EmptyTableRows from '../components/EmptyTableRows';
import LineChart, { type LineSeries } from '../components/viz/LineChart';
import BarList, { type BarListItem } from '../components/viz/BarList';
import { useTimeRange } from '../components/TimeRange';
import s from './SwitchesPage.module.css';

type Sw = { name: string; clients: number | null; poe: number | null; temp: number | null; cpu: number | null; memory: number | null };
const colors = ['#347fce', '#238b3c', '#d36b96', '#d69d2d', '#3a9d84'];
const emptySwitches: Sw[] = [];
function toSeries(rows: MetricPoint[], format?: (v: number) => string, port = false): LineSeries[] {
  const grouped = new Map<string, MetricPoint[]>();
  rows.forEach(row => { const name = row.labels?.name ?? 'Unknown'; const suffix = port && row.labels?.port_name ? ` · ${row.labels.port_name}` : ''; const key = `${name}${suffix}`; grouped.set(key, [...(grouped.get(key) ?? []), row]); });
  return [...grouped.entries()].map(([name, points], i) => ({ name, color: colors[i % colors.length], data: points.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)).map(p => ({ t: (p.time ?? 0) < 10000000000 ? (p.time ?? 0) * 1000 : (p.time ?? 0), v: p.value })), format }));
}
function Chart({ title, subtitle, series, yMax, area = false }: { title: string; subtitle?: string; series: LineSeries[]; yMax?: number; area?: boolean }) { return <div className={s.chart}><LineChart title={title} subtitle={subtitle} series={series} height={210} yMax={yMax} area={area} /></div>; }
const n = (value: number | null, suffix = '') => value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}${suffix}`;

export default function SwitchesPage() {
  const tr = useTimeRange();
  const [switches, setSwitches] = useState<Sw[]>(emptySwitches);
  const [count, setCount] = useState<number | null>(null); const [clients, setClients] = useState<number | null>(null); const [poe, setPoe] = useState<number | null>(null); const [hot, setHot] = useState<number | null>(null);
  const [receive, setReceive] = useState<LineSeries[]>([]); const [transmit, setTransmit] = useState<LineSeries[]>([]); const [busiest, setBusiest] = useState<LineSeries[]>([]); const [temperature, setTemperature] = useState<LineSeries[]>([]); const [cpuSeries, setCpuSeries] = useState<LineSeries[]>([]); const [memorySeries, setMemorySeries] = useState<LineSeries[]>([]); const [poeItems, setPoeItems] = useState<BarListItem[]>([]);
  useEffect(() => {
    const instant = async (query: string) => queryMetric(query);
    void Promise.all([
      queryMetric('unpoller_device_info{type="usw"}'),
      instant('count(unpoller_device_uptime_seconds{type="usw"})'),
      instant('count(unpoller_client_uptime_seconds{wired="true"})'),
      instant('sum(unpoller_device_port_poe_watts)'),
      instant('max(unpoller_device_temperature_celsius{type="usw"})'),
      instant('count by (sw_name) (unpoller_client_uptime_seconds{wired="true"})'),
      instant('unpoller_device_port_poe_watts'),
    ]).then(([info, countRows, clientRows, poeRows, hotRows, clientBySwitch, portPoe]) => {
      const clientMap = new Map(clientBySwitch.map(r => [r.labels?.sw_name ?? '', r.value]));
      const cpu = new Map<string, number>(); const memory = new Map<string, number>(); const temps = new Map<string, number>();
      return Promise.all([instant('100 * unpoller_device_cpu_utilization_ratio{type="usw"}'), instant('100 * unpoller_device_memory_utilization_ratio{type="usw"}'), instant('unpoller_device_temperature_celsius{type="usw"}')]).then(([cpuRows, memoryRows, tempRows]) => {
        cpuRows.forEach(r => cpu.set(r.labels?.name ?? '', r.value)); memoryRows.forEach(r => memory.set(r.labels?.name ?? '', r.value)); tempsRows: tempRows.forEach(r => temps.set(r.labels?.name ?? '', r.value));
        setSwitches(info.map(r => { const name = r.labels?.name ?? 'Unknown'; return { name, clients: clientMap.get(name) ?? null, poe: null, temp: temps.get(name) ?? null, cpu: cpu.get(name) ?? null, memory: memory.get(name) ?? null }; }));
        setCount(countRows[0]?.value ?? null); setClients(clientRows[0]?.value ?? null); setPoe(poeRows[0]?.value ?? null); setHot(hotRows[0]?.value ?? null);
        setPoeItems(portPoe.filter(r => r.value > 0).map(r => ({ label: `${r.labels?.name ?? 'Unknown'} · ${r.labels?.port_name ?? r.labels?.port_num ?? 'Port'}`, value: r.value })).sort((a, b) => b.value - a.value));
      });
    }).catch(() => undefined);
  }, [tr.earliest, tr.range, tr.refreshKey]);
  useEffect(() => {
    void Promise.all([
      queryMetric('sum by (name) (rate(unpoller_device_port_receive_bytes_total[5m]))', tr.step, tr.earliest),
      queryMetric('sum by (name) (rate(unpoller_device_port_transmit_bytes_total[5m]))', tr.step, tr.earliest),
      queryMetric('topk(8, sum by (name, port_name) (rate(unpoller_device_port_receive_bytes_total[5m])))', tr.step, tr.earliest),
      queryMetric('unpoller_device_temperature_celsius{type="usw"}', tr.step, tr.earliest),
      queryMetric('100 * unpoller_device_cpu_utilization_ratio{type="usw"}', tr.step, tr.earliest),
      queryMetric('100 * unpoller_device_memory_utilization_ratio{type="usw"}', tr.step, tr.earliest),
    ]).then(([r, t, b, temp, cpu, memory]) => { setReceive(toSeries(r, v => `${(v / 1024 / 1024).toFixed(1)} MB/s`)); setTransmit(toSeries(t, v => `${(v / 1024 / 1024).toFixed(1)} MB/s`)); setBusiest(toSeries(b, v => `${(v / 1024 / 1024).toFixed(1)} MB/s`, true)); setTemperature(toSeries(temp, v => `${v.toFixed(1)}°C`)); setCpuSeries(toSeries(cpu, v => `${v.toFixed(1)}%`)); setMemorySeries(toSeries(memory, v => `${v.toFixed(1)}%`)); }).catch(() => undefined);
  }, [tr.earliest, tr.range, tr.refreshKey, tr.step]);
  return <div className={s.page}><header><h1>Switches <small>USW insights</small></h1><div className={s.controls}>{tr.rangeSelect}{tr.autoSelect}<button onClick={tr.refresh}>↻</button></div></header><div className={s.cards}>{[['Switches', count == null ? '—' : count], ['Wired clients', clients == null ? '—' : clients], ['PoE draw', n(poe, ' W')], ['Hottest switch', n(hot, '°C')]].map(([label, value]) => <div className={s.card} key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}</div><section className={s.inventory}><div className={s.title}><h2>Switches</h2><span>click a switch to see its ports and clients</span></div><table><thead><tr>{['Switch', 'Wired clients', 'PoE draw', 'Temp', 'CPU', 'Memory'].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{switches.map(x => <tr key={x.name}><td><Link to={`/switches/${encodeURIComponent(x.name)}`}>{x.name}</Link></td><td>{x.clients ?? '—'}</td><td>{n(x.poe, ' W')}</td><td>{n(x.temp, '°C')}</td><td>{n(x.cpu, '%')}</td><td>{n(x.memory, '%')}</td></tr>)}{switches.length === 0 && <EmptyTableRows columns={6} rows={4}/>}</tbody></table></section><div className={s.grid}><Chart title="Switch throughput — receive" series={receive}/><Chart title="Switch throughput — transmit" series={transmit}/><div className={s.wide}><Chart title="Busiest ports — receive" subtitle="topk(8), rate over 5m — click a line for its switch" series={busiest}/></div><Chart title="Switch temperature" series={temperature} yMax={50}/><div className={s.list}><h2>PoE draw by port</h2><BarList items={poeItems} color="#347fce" format={v => `${v.toFixed(1)} W`} /></div><Chart title="Switch CPU usage" series={cpuSeries} yMax={100}/><Chart title="Switch memory usage" series={memorySeries} yMax={100}/></div></div>;
}