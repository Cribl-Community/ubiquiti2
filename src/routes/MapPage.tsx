import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { NetworkGraph, type ForceLink, type ForceNode } from '@criblio/app-utils/graph';
import { queryMetric, type MetricPoint } from '../api/metrics';
import { investigatePrompt } from '../api/investigator';
import { useTimeRange } from '../components/TimeRange';
import s from './MapPage.module.css';

type Node = ForceNode & { kind:'gateway'|'switch'|'ap'|'client'; mac?:string; name:string; clients?:number; apName?:string; rate:number };
type Edge = ForceLink<Node> & { kind:'wired'|'wireless'; rate:number };
type WirelessGroup={apId:string;apName:string;clients:{mac:string;name:string}[]};

const palette={gateway:'#347fce',switch:'#168454',ap:'#76509a',client:'#e7ebf1'};

/* Rate formatting mirrors the original: one decimal under ~100 KB/s or for MB/s,
   whole KB above that ("8.6 KB/s", "883 KB/s", "2.1 MB/s", "12.0 MB/s"). */
const fmtRate=(n:number)=>n>=1048576?`${(n/1048576).toFixed(1)} MB/s`
  :n>=102400?`${Math.round(n/1024)} KB/s`
  :n>=1024?`${(n/1024).toFixed(1)} KB/s`
  :`${Math.round(n)} B/s`;

/* Latest value per distinct series (a device spans several port/VAP rows),
   aggregated per device name. Summing every point is what produced the
   impossible 743 MB/s earlier — always take the newest point per series. */
const aggByName=(rows:MetricPoint[])=>{
  const per=new Map<string,{t:number;v:number}>();
  rows.forEach(p=>{
    const l=p.labels??{};const n=l.name;if(!n)return;
    const key=`${n}|${l.mac??''}|${l.vap_name??l.port_num??l.band??l.radio??''}`;
    const t=p.time??0;const cur=per.get(key);
    if(!cur||t>=cur.t)per.set(key,{t,v:p.value});
  });
  const out=new Map<string,number>();
  per.forEach(({v},key)=>{const n=key.split('|')[0];out.set(n,(out.get(n)??0)+v)});
  return out;
};

const clientRatesFrom=(rows:MetricPoint[])=>{
  const per=new Map<string,{t:number;v:number}>();
  rows.forEach(p=>{
    const l=p.labels??{};const t=p.time??0;
    for(const key of [l.mac,l.name]){
      if(!key)continue;const cur=per.get(key);
      if(!cur||t>=cur.t)per.set(key,{t,v:p.value});
    }
  });
  const out=new Map<string,number>();
  per.forEach(({v},k)=>out.set(k,v));
  return out;
};

export default function MapPage(){
  const navigate=useNavigate();const tr=useTimeRange();
  const [devices,setDevices]=useState<Node[]>([]);
  const [topology,setTopology]= useState<Edge[]>([]);
  const [wiredGroups,setWiredGroups]=useState<{parentId:string;clients:{mac:string;name:string}[]}[]>([]);
  const [wireless,setWireless]=useState<WirelessGroup[]>([]);
  const [clientRates,setClientRates]=useState<Map<string,number>>(new Map());
  const [trafficSeries,setTrafficSeries]=useState<Map<string,{rx:number[];tx:number[]}>>(new Map());
  const [cpu,setCpu]=useState<Map<string,number>>(new Map());
  const [memory,setMemory]=useState<Map<string,number>>(new Map());
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const [pinned,setPinned]=useState<string|null>(null);
  const [hovered,setHovered]=useState<Node|null>(null);
  const [loading,setLoading]=useState(true);
  const mapRef=useRef<HTMLElement>(null);
  const [size,setSize]=useState({width:1450,height:700});

  useEffect(()=>{
    const el=mapRef.current;if(!el)return;
    const ro=new ResizeObserver(([entry])=>setSize({width:Math.max(600,Math.floor(entry.contentRect.width)),height:700}));
    ro.observe(el);return()=>ro.disconnect();
  },[]);

  useEffect(()=>{
    void Promise.all([
      queryMetric('unpoller_device_info'),
      queryMetric('unpoller_topology_link_rate_mbps'),
      queryMetric('unpoller_client_uptime_seconds'),
      queryMetric('sum by (name, mac, ap_name) (rate(unpoller_client_receive_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('sum by (name, mac) (rate(unpoller_client_transmit_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('sum by (name) (rate(unpoller_device_switch_receive_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('sum by (name) (rate(unpoller_device_switch_transmit_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('sum by (name) (rate(unpoller_device_vap_receive_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('sum by (name) (rate(unpoller_device_vap_transmit_bytes_total[5m]))',tr.step,tr.earliest),
      queryMetric('100 * max by (name) (unpoller_device_cpu_utilization_ratio)',tr.step,tr.earliest),
      queryMetric('100 * max by (name) (unpoller_device_memory_utilization_ratio)',tr.step,tr.earliest),
    ]).then(([devicesQ,topologyQ,clients,clientRx,clientTx,switchRx,switchTx,vapRx,vapTx,cpuRows,memoryRows])=>{
      /* devices */
      const byMac=new Map<string,Node>();
      devicesQ.forEach(p=>{
        const l=p.labels??{};const mac=l.mac;if(!mac)return;
        const t=(l.type??'').toLowerCase();
        const kind=t==='udm'?'gateway':t==='uap'?'ap':'switch';
        byMac.set(mac,{id:mac,kind,mac,name:l.name??mac,rate:0});
      });
      const byName=[...byMac.values()];

      /* per-device traffic = receive + transmit (latest point per series) */
      const dev=new Map<string,number>();
      const merge=(m:Map<string,number>)=>m.forEach((v,n)=>dev.set(n,(dev.get(n)??0)+v));
      const swRx=aggByName(switchRx);const swTx=aggByName(switchTx);
      merge(swRx);merge(swTx);merge(aggByName(vapRx));merge(aggByName(vapTx));
      dev.forEach((v,n)=>{const node=byName.find(x=>x.name===n);if(node)node.rate=v});

      /* per-switch rx/tx series for the pinned-card throughput chart */
      const series=new Map<string,{rx:number[];tx:number[]}>();
      const push=(rows:MetricPoint[],pick:'rx'|'tx')=>rows.forEach(p=>{
        const n=p.labels?.name;if(!n)return;
        const x=series.get(n)??{rx:[],tx:[]};x[pick].push(p.value);series.set(n,x);
      });
      push(switchRx,'rx');push(switchTx,'tx');

      /* clients: wireless grouped under their AP, wired attached via sw_name */
      /* client traffic = receive + transmit (latest point per series) */
      const rx=clientRatesFrom(clientRx);const tx=clientRatesFrom(clientTx);
      const rates=new Map(rx);
      tx.forEach((v,k)=>rates.set(k,(rates.get(k)??0)+v));
      const seen=new Set<string>();
      const groups=new Map<string,WirelessGroup>();
      const wired=new Map<string,{parentId:string;clients:{mac:string;name:string}[]}>();
      clients.forEach(p=>{
        const l=p.labels??{};const mac=l.mac??l.name;if(!mac||seen.has(mac))return;seen.add(mac);
        if(l.wired==='false'||(!l.sw_name&&l.ap_name)){
          const apName=l.ap_name;if(!apName)return;
          const ap=byName.find(x=>x.kind==='ap'&&x.name===apName);if(!ap)return;
          const g=groups.get(ap.id)??{apId:ap.id,apName,clients:[]};
          g.clients.push({mac,name:l.name??mac});
          groups.set(ap.id,g);
        }else if(l.sw_name){
          const d=byName.find(x=>x.name===l.sw_name);
          if(d){const g=wired.get(d.id)??{parentId:d.id,clients:[]};g.clients.push({mac,name:l.name??mac});wired.set(d.id,g)}
        }
      });

      groups.forEach(g=>{const ap=byName.find(x=>x.id===g.apId);if(ap)ap.clients=g.clients.length});

      /* topology edges carry the downstream side's traffic */
      const links:Edge[]=topologyQ.map(p=>{
        const l=p.labels??{};
        const a=byMac.get(l.uplink_mac??''),b=byMac.get(l.downlink_mac??'');
        return (a&&b)?{source:a.id,target:b.id,rate:b.rate,kind:(l.link_type??'WIRED').toLowerCase()==='wireless'?'wireless':'wired'} as Edge:null;
      }).filter((e):e is Edge=>e!==null);

      const pct=(rows:MetricPoint[])=>{const m=new Map<string,number>();rows.forEach(p=>{const n=p.labels?.name;if(n)m.set(n,p.value)});return m};
      setDevices(byName);setTopology(links);setWiredGroups([...wired.values()]);
      setWireless([...groups.values()]);setClientRates(rates);setTrafficSeries(series);
      setCpu(pct(cpuRows));setMemory(pct(memoryRows));
      setLoading(false);
    }).catch(()=>setLoading(false));
  },[tr.range,tr.refreshKey]);

  const graph=useMemo(()=>{
    const nodes:Node[]=[...devices];
    const links:Edge[]=[...topology];
    for(const g of wireless){
      const total=g.clients.reduce((s,c)=>s+(clientRates.get(c.mac)??clientRates.get(c.name)??0),0);
      const isSingle=g.clients.length===1;
      if(isSingle||expanded.has(g.apId)){
        g.clients.forEach(c=>{
          const id=`client:${c.mac}:${g.apId}`;
          nodes.push({id,kind:'client',mac:c.mac,name:c.name,apName:g.apName,rate:clientRates.get(c.mac)??clientRates.get(c.name)??0});
          links.push({source:g.apId,target:id,rate:clientRates.get(c.mac)??clientRates.get(c.name)??0,kind:'wireless'} as Edge);
        });
        if(isSingle)continue;
        /* collapsed clusters stay visible for multi-client APs only */
      }else{
        const id=`clients:${g.apId}`;
        nodes.push({id,kind:'client',name:`${g.clients.length} clients`,clients:g.clients.length,apName:g.apName,rate:total});
        links.push({source:g.apId,target:id,rate:total,kind:'wireless'} as Edge);
      }
    }
    /* wired client clusters: single client renders as itself, otherwise a
       collapsible "N clients" bubble per device (the reference's 22-client
       bubble is the theater rack switch's wired clients) */
    wiredGroups.forEach(g=>{
      const total=g.clients.reduce((s,c)=>s+(clientRates.get(c.mac)??clientRates.get(c.name)??0),0);
      const key=`wclients:${g.parentId}`;
      const leaf=(c:{mac:string;name:string})=>{
        const id=`wclient:${c.mac}`;
        nodes.push({id,kind:'client',mac:c.mac,name:c.name,rate:clientRates.get(c.mac)??clientRates.get(c.name)??0});
        links.push({source:g.parentId,target:id,rate:clientRates.get(c.mac)??clientRates.get(c.name)??0,kind:'wired'} as Edge);
      };
      if(g.clients.length===1||expanded.has(key))g.clients.forEach(leaf);
      else{
        nodes.push({id:key,kind:'client',name:`${g.clients.length} clients`,clients:g.clients.length,rate:total});
        links.push({source:g.parentId,target:key,rate:total,kind:'wired'} as Edge);
      }
    });
    return {nodes,links};
  },[devices,topology,wireless,wiredGroups,clientRates,expanded]);

  const activeNode=graph.nodes.find(n=>n.id===(pinned??hovered?.id))??hovered;
  const nodeTraffic=activeNode?.rate??0;
  const deviceSeries=activeNode?trafficSeries.get(activeNode.name):undefined;

  const toggle=(apId:string)=>setExpanded(prev=>{
    const next=new Set(prev);
    if (next.has(apId)) next.delete(apId); else next.add(apId);
    return next;
  });

  return <div className={s.page}>
    <header>
      <h1>Network Map <small>live topology — edge width &amp; label = traffic on that link</small></h1>
      <div className={s.controls}>
        {tr.rangeSelect}
        {tr.autoSelect}
        <button onClick={tr.refresh}>↻</button>
      </div>
    </header>
    <section ref={mapRef} className={s.map} onPointerLeave={()=>{if(!pinned)setHovered(null)}}>
      {loading?<div className={s.loading}>Loading live topology…</div>:
      <NetworkGraph<Node,Edge>
        nodes={graph.nodes}
        links={graph.links}
        width={size.width}
        height={size.height}
        nodeRadius={n=>n.kind==='gateway'?22:n.kind==='switch'?19:n.kind==='ap'?16:n.clients?Math.min(20,11+n.clients/3.2):8}
        nodeFill={n=>palette[n.kind]}
        nodeStroke={n=>n.kind==='client'?'#c9d2de':palette[n.kind]}
        renderNodeContent={n=>n.kind==='client'&&n.clients
          ?<text y={5} textAnchor="middle" fill="#52606d" fontSize={n.clients>99?10:n.clients>9?12:13}>{n.clients}</text>
          :null}
        nodeLabel={n=>n.kind==='client'&&n.clients?`${n.clients} clients`:n.name}
        edgeWidth={l=>Math.max(1.5,Math.min(l.kind==='wireless'?9:14,Math.sqrt(Math.max(0,l.rate))/220))}
        edgeColor={l=>l.kind==='wireless'?'#7a4f9e':'#d2d6dc'}
        edgeDash={l=>l.kind==='wireless'?'6 5':undefined}
        edgeLabel={l=>fmtRate(l.rate)}
        onNodeClick={n=>{
          if(n.clients&&n.id.startsWith('clients:')){toggle(n.id.replace('clients:',''));setPinned(null);return}
          if(n.clients&&n.id.startsWith('wclients:')){toggle(n.id);setPinned(null);return}
          setPinned(n.id);
        }}
        onNodeHover={setHovered}
        annotationNodeId={pinned??hovered?.id}
        renderAnnotation={n=><>
          <div className="cardTitle"><strong>{n.name}</strong>{pinned===n.id&&<button type="button" aria-label="Close" onClick={()=>setPinned(null)}>×</button>}</div>
          <span>{n.kind==='gateway'?'Gateway':n.kind==='switch'?'Switch':n.kind==='ap'?'Access point':n.clients?'Client cluster':'Client'}</span>
          <div>Traffic <b>{fmtRate(nodeTraffic)}</b></div>
          {n.clients!=null&&<div>Clients <b>{n.clients}</b></div>}
          {(n.kind==='switch'||n.kind==='gateway')&&<><div>CPU <b>{cpu.get(n.name)==null?'—':`${cpu.get(n.name)!.toFixed(1)}%`}</b></div><div>Memory <b>{memory.get(n.name)==null?'—':`${memory.get(n.name)!.toFixed(1)}%`}</b></div></>}
          {pinned===n.id&&<>
            <div className="sparkline" aria-label="throughput, last hour">
              <svg viewBox="0 0 220 34" preserveAspectRatio="none">
                <path d={`M 0 34 L ${(deviceSeries?.rx??[]).map((v,i)=>`${i*220/Math.max(1,(deviceSeries?.rx.length??1)-1)} ${33-(v/Math.max(1,Math.max(...(deviceSeries?.rx??[1]))))*28}`).join(' L ')} L 220 34 Z`} fill="#dbeafa" stroke="none"/>
                <polyline points={(deviceSeries?.rx??[]).map((v,i)=>`${i*220/Math.max(1,(deviceSeries?.rx.length??1)-1)},${33-(v/Math.max(1,Math.max(...(deviceSeries?.rx??[1]))))*28}`).join(' ')} fill="none" stroke="#2774c5" strokeWidth="2"/>
                <polyline points={(deviceSeries?.tx??[]).map((v,i)=>`${i*220/Math.max(1,(deviceSeries?.tx.length??1)-1)},${33-(v/Math.max(1,Math.max(...(deviceSeries?.tx??[1]))))*28}`).join(' ')} fill="none" stroke="#7d8792" strokeWidth="1.5"/>
              </svg>
            </div>
            <small>throughput, last hour</small>
            <div className="cardActions">
              <Link to={n.kind==='ap'?`/aps/${encodeURIComponent(n.name)}`:n.kind==='switch'?`/switches/${encodeURIComponent(n.name)}`:'/clients'}>Details</Link>
              {n.kind==='ap'&&n.clients&&expanded.has(n.id)&&<button type="button" className="collapseLink" onClick={()=>{toggle(n.id);setPinned(null)}}>Collapse clients</button>}
              {expanded.has(`wclients:${n.id}`)&&<button type="button" className="collapseLink" onClick={()=>{toggle(`wclients:${n.id}`);setPinned(null)}}>Collapse clients</button>}
              <button type="button" onClick={()=>{navigate('/investigate',{state:{question:investigatePrompt.node(n.kind,n.name,n.mac)}});setPinned(null)}}>Investigate</button>
            </div>
          </>}
          {!pinned&&<small>Click to pin</small>}
        </>}
        forces={{linkDistance:l=>(l as Edge).kind==='wireless'?120:175,charge:-650,settleAlpha:0.12}}
      />}
    </section>
    <div className={s.legend}>
      <span><i className={s.gateway}/>Gateway</span>
      <span><i className={s.switch}/>Switch</span>
      <span><i className={s.ap}/>Access point</span>
      <span><i className={s.client}/>Client</span>
      <span><i className={s.wire}/>Wireless link</span>
    </div>
    <p className={s.note}>Hover a node for its metrics; click to pin. Click a client cluster to expand the individual wireless clients; the parent access point then offers Collapse clients. Edge width and labels show live traffic for the downstream side of each link over the 5m rate window; dashed purple links are wireless.</p>
  </div>;
}
