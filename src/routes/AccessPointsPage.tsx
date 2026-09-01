import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { latestMetric } from '../api/metrics';
import BarList, { type BarListItem } from '../components/viz/BarList';
import LineChart, { type LineSeries } from '../components/viz/LineChart';
import type { ReactNode } from 'react';
import { useTimeRange } from '../components/TimeRange';
import s from './AccessPointsPage.module.css';

type AP = { name: string; clients: number; two: number; five: number; cpu: number; memory: number; rssi: string };
const aps: AP[] = [
  { name: 'AP Office', clients: 14, two: 42, five: 6, cpu: 13.3, memory: 72.7, rssi: '37 dB' },
  { name: 'AP Laundry South', clients: 6, two: 27, five: 5, cpu: 7.6, memory: 69.4, rssi: '38 dB' },
  { name: 'AP Main Bedroom', clients: 4, two: 21, five: 7, cpu: 8.7, memory: 68.5, rssi: '32 dB' },
  { name: 'AP Theater Rack', clients: 2, two: 31, five: 24, cpu: 9.3, memory: 67.8, rssi: '44 dB' },
  { name: 'AP Bedroom 2', clients: 1, two: 13, five: 3, cpu: 6.5, memory: 68.3, rssi: '28 dB' },
  { name: 'AP Guest House Patio', clients: 1, two: 59, five: 2, cpu: 1.4, memory: 78.8, rssi: '24 dB' },
  { name: 'AP Guest House', clients: 0, two: 28, five: 7, cpu: 10.3, memory: 71.4, rssi: '—' },
];

function Chart({ title, subtitle, format, yMax, area = false }: { title: string; subtitle?: string; bases: number[]; format?: (v: number) => string; yMax?: number; area?: boolean }) {
  return <LineChart title={title} subtitle={subtitle} series={[]} height={164} yFormat={format} yMax={yMax} area={area} />;
}
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className={s.listPanel}><h2>{title}</h2>{children}</section>; }

export default function AccessPointsPage() {
  const tr = useTimeRange();
  const [count, setCount] = useState(7); const [clients, setClients] = useState(28); const [two, setTwo] = useState(14); const [five, setFive] = useState(14);
  useEffect(() => { void Promise.all([latestMetric('count(unpoller_device_uptime_seconds{type="uap"})',7), latestMetric('sum(unpoller_device_stations{type="uap"})',28), latestMetric('sum(unpoller_device_radio_stations{radio="ng"})',14), latestMetric('sum(unpoller_device_radio_stations{radio="na"})',14)]).then(([a,c,n,f]) => { setCount(a);setClients(c);setTwo(n);setFive(f); }); }, [tr.range, tr.refreshKey]);
  const channelItems: BarListItem[] = [['100',9],['1',8],['6',5],['161',4],['44',4],['48',3],['11',1]].map(([label,value]) => ({ label, value }));
  const vendorItems: BarListItem[] = [['Unknown',13],['AMPAK Technology, Inc.',4],['Apple, Inc.',3],['Alpha Networks Inc.',3],['Samsung Electronics Co.,Ltd',2],['Microsoft Corporation',2],['Microchip Technology Inc.',1],['Qolsys Inc.',1],['Tesla Inc',1],['Eight Sleep',1]].map(([label,value]) => ({ label, value }));
  const percent = (v: number) => `${v.toFixed(1)}%`; const db = (v: number) => `${v.toFixed(0)} dB`;
  return <div className={s.page}><header className={s.header}><h1>Access Points <small>UAP insights</small></h1><div className={s.controls}>{tr.rangeSelect}{tr.autoSelect}<button onClick={tr.refresh}>↻</button></div></header><div className={s.cards}>{[['Access points',count],['Wireless clients',clients],['2.4 GHz clients',two],['5 GHz clients',five]].map(([label,value])=><div className={s.card} key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}</div><section className={s.inventory}><div className={s.panelTitle}><h2>Access points</h2><span>click an AP to see who's on it</span></div><table><thead><tr>{['Access point','Clients','2.4 GHz util','5 GHz util','CPU','Memory','Avg client RSSI'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{aps.map(a=><tr key={a.name}><td><Link to={`/aps/${encodeURIComponent(a.name)}`}>{a.name}</Link></td><td>{a.clients}</td><td>{percent(a.two)}</td><td>{percent(a.five)}</td><td>{percent(a.cpu)}</td><td>{percent(a.memory)}</td><td>{a.rssi}</td></tr>)}</tbody></table></section><div className={s.grid}><Chart title="Clients per AP" bases={aps.map(a=>a.clients)} format={v => v.toFixed(0)} yMax={16}/><Chart title="Average client signal per AP" subtitle="mean client RSSI (dB) — higher is better" bases={[24,35,38,45,29,22,34]} format={db} yMax={50}/><Chart title="Wireless traffic per AP — transmit" bases={[2.6,.12,.08,.05,.03,.02,.01]} format={v => `${v.toFixed(1)} MB/s`} area/><Chart title="Wireless traffic per AP — receive" bases={[.12,.03,.02,.02,.03,.02,.01]} format={v => `${v.toFixed(0)} KB/s`}/><Chart title="2.4 GHz channel utilization" bases={[86,33,33,28,26,17,14]} format={percent} yMax={100}/><Chart title="5 GHz channel utilization" bases={[23,4,3,2,2,1,1]} format={percent} yMax={100}/><Chart title="AP CPU usage" bases={aps.map(a=>a.cpu)} format={percent} yMax={100}/><Chart title="AP memory usage" bases={aps.map(a=>a.memory)} format={percent} yMax={100}/><Panel title="Clients by channel"><BarList items={channelItems} color="#347fce" /></Panel><Panel title="Clients by vendor (MAC OUI)"><BarList items={vendorItems} color="#347fce" /></Panel></div></div>;
}
