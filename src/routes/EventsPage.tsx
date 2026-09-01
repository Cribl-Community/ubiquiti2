import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { runQuery } from '../api/cribl';
import { useTimeRange } from '../components/TimeRange';
import s from './EventsPage.module.css';

/** One CEF controller event, parsed at read time. */
type EventRow={
  time:string;
  name:string;
  client:string;
  ap:string;
  detail:string;
};
type SyslogRow={device:string;severity:string;events:number;lastSeen:number};
type SyslogFeedRow={time:string;severity:string;device:string;model:string;msg:string};

const CEF_QUERY=`dataset="main" | where _raw contains "CEF:0|Ubiquiti" `
  +`| extend evt_name=extract(@"CEF:0\\|Ubiquiti\\|UniFi Network\\|[^|]*\\|\\d+\\|([^|]*)\\|",1,_raw), `
  +`client=extract(@"UNIFIclientHostname=(.*?) UNIFI[A-Za-z]",1,_raw), `
  +`ap=extract(@"UNIFIconnectedToDeviceName=(.*?) UNIFI[A-Za-z]",1,_raw), `
  +`prev_ap=extract(@"UNIFIlastConnectedToDeviceName=(.*?) UNIFI[A-Za-z]",1,_raw), `
  +`prev_rssi=extract(@"UNIFIlastConnectedToWiFiRssi=(-?\\d+)",1,_raw), `
  +`rssi=extract(@"UNIFIWiFiRssi=(-?\\d+)",1,_raw), `
  +`wifi_name=extract(@"UNIFIwifiName=(.*?) UNIFI[A-Za-z]",1,_raw), `
  +`wifi_band=extract(@"UNIFIwifiBand=(\\S+)",1,_raw) `
  +`| project _time,evt_name,client,ap,prev_ap,prev_rssi,rssi,wifi_name,wifi_band | sort by _time desc | limit 200`;

/* Only the "compress failed" inform spam is benign; the remaining MCA/TLS-S
   lines are real device problems. Warnings+errors count as "device problems". */
const SYSLOG_QUERY=`dataset="main" | where datatype=="syslog_rfc3164" and message !contains "compress failed" `
  +`| extend device=extract(@"^(\\S+)",1,message) `
  +`| summarize events=count(), last_seen=max(_time) by device, severityName | sort by events desc`;

const SYSLOG_FEED_QUERY=`dataset="main" | where datatype=="syslog_rfc3164" and message !contains "compress failed" `
  +`| extend device=extract(@"^(\\S+)",1,message), `
  +`model=extract(@",(\\S+)-[\\d.]+:",1,message), `
  +`msg=extract(@":\\s(.*)$",1,message) `
  +`| project _time,severityName,device,model,msg | sort by _time desc | limit 200`;

/* Full-window per-type counts — separate from the 200-row feed so the stat
   cards and bars never undercount when the feed truncates. */
const COUNT_QUERY=`dataset="main" | where _raw contains "CEF:0|Ubiquiti" `
  +`| extend evt_name=extract(@"CEF:0\\|Ubiquiti\\|UniFi Network\\|[^|]*\\|\\d+\\|([^|]*)\\|",1,_raw) `
  +`| summarize count() by evt_name | sort by count_ desc`;

const when=(t:number)=>{const d=new Date(t*1000);return `${d.toLocaleString('en-US',{month:'short',day:'numeric'})}, ${d.toLocaleString('en-US',{hour:'2-digit',minute:'2-digit'})}`};
const classify=(n:string)=>n.includes('Connected')?'connects':n.includes('Roamed')?'roams':n.toLowerCase().includes('disconnect')?'disconnects':'other';
const band=b=>b==='na'?'5 GHz':b==='ng'?'2.4 GHz':b==='ax'?'6 GHz':`${b} band`;
const detailOf=(r:Record<string,unknown>):string=>{
  const ap=String(r.ap??'');const prev=String(r.prev_ap??'');
  if(prev&&ap&&prev!==ap)return `${prev} → ${ap} (${r.prev_rssi?`${r.prev_rssi} dBm`:'—'} → ${r.rssi?`${r.rssi} dBm`:'—'})`;
  return `joined ${ap||'—'} · ${r.wifi_name??'—'} · ${band(String(r.wifi_band??''))}${r.rssi?` at ${r.rssi} dBm`:''}`;
};

export default function EventsPage(){
  const [events,setEvents]=useState<EventRow[]>([]);
  const [syslog,setSyslog]=useState<SyslogRow[]>([]);
  const [syslogFeed,setSyslogFeed]=useState<SyslogFeedRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState<string|null>(null);   /* bar click filters the feed */
  const [pinned,setPinned]=useState<number|null>(null);   /* clicked time pins a row */
  const tr=useTimeRange();
  
  const earliest=tr.earliest;

  useEffect(()=>{
    setLoading(true);setPinned(null);
    void Promise.all([
      runQuery(CEF_QUERY,earliest,'now',200),
      runQuery(COUNT_QUERY,earliest,'now',200),
      runQuery(SYSLOG_QUERY,earliest,'now',200),
      runQuery(SYSLOG_FEED_QUERY,earliest,'now',200),
    ]).then(([ev,counts,sl,slf])=>{
      setEvents(ev.map(r=>({
        time:when(Number(r._time)),
        name:String(r.evt_name??'Event'),
        client:String(r.client??'—'),
        ap:String(r.ap??'—'),
        detail:detailOf(r),
      })));
      setBars(counts.map(r=>({name:String(r.evt_name??'—'),count:Number(r.count_??0)})));
      setSyslog(sl.map(r=>({device:String(r.device??'—'),severity:String(r.severityName??'info'),events:Number(r.events??0),lastSeen:Number(r.last_seen??0)})));
      setSyslogFeed(slf.map(r=>({time:when(Number(r._time)),severity:String(r.severityName??'info'),device:String(r.device??'—'),model:String(r.model??'—'),msg:String(r.msg??'—')})));
      setLoading(false);
    }).catch(()=>setLoading(false));
  },[earliest,tr.refreshKey]);

  const [bars,setBars]=useState<{name:string;count:number}[]>([]);

  const stats=useMemo(()=>{
    const c={connects:0,roams:0,disconnects:0,other:0};
    bars.forEach(({name,count})=>{c[classify(name)]+=count});
    const problems=syslog.filter(r=>r.severity!=='info').reduce((s,r)=>s+r.events,0);
    return {...c,problems};
  },[bars,syslog]);

  const maxBar=Math.max(1,...bars.map(b=>b.count));
  const feed=filter?events.filter(e=>e.name===filter):events;

  return <div className={s.page}>
    <header>
      <h1>Events <small>UniFi log streams, parsed at read time</small></h1>
      <div className={s.controls}>
        {tr.rangeSelect}
        {tr.autoSelect}
        <button onClick={()=>tr.refresh()}>↻</button>
      </div>
    </header>
    <div className={s.cards}>
      {[['Connects',stats.connects],['Roams',stats.roams],['Disconnects',stats.disconnects],['Other controller events',stats.other],['Device problems',stats.problems]].map(([l,v])=>
        <div className={s.card} key={String(l)}><span>{l}</span><strong>{v}</strong></div>)}
    </div>
    <div className={s.grid}>
      <section className={s.panel}>
        <div className={s.panelHead}><h2>Controller events by type</h2><span>click a bar to filter the feed</span></div>
        <div className={s.bars}>
          {bars.map(({name,count})=>
            <button type="button" key={name} className={`${s.barRow}${filter&&filter!==name?` ${s.dim}`:''}`} onClick={()=>setFilter(f=>f===name?null:name)}>
              <span className={s.label}>{name}</span>
              <span className={s.track}>
                <span className={s.fill} style={{flex:`0 1 calc(${Math.max(2,Math.round(count*88/maxBar))}% )`}}/>
                <span className={s.count}>{count}</span>
              </span>
            </button>)}
          {!bars.length&&<div className={s.empty}>{loading?'Loading…':'No controller events in this time range'}</div>}
        </div>
      </section>
      <section className={s.panel}>
        <div className={s.panelHead}><h2>Device syslog by device + severity</h2><span>benign chatter excluded</span></div>
        <table>
          <thead><tr>{['Device','Severity','Events','Last seen'].map(x=><th key={x}>{x}</th>)}</tr></thead>
          <tbody>
            {syslog.map((r,i)=><tr key={i}>
              <td>{r.device}</td>
              <td className={r.severity==='error'?s.sevError:r.severity==='warning'?s.sevWarning:s.sevInfo}>{r.severity}</td>
              <td>{r.events}</td>
              <td style={{textAlign:'right'}}>{when(r.lastSeen)}</td>
            </tr>)}
            {!syslog.length&&<tr><td colSpan={4} className={s.empty}>{loading?'Loading…':'No device syslog in this time range'}</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
    <section className={`${s.panel} ${s.feed}`}>
      <div className={s.panelHead}><h2>Controller event feed{filter?` — ${filter}`:''}</h2><span>newest first — click a client to drill in, a time to pin it</span></div>
      <table>
        <thead><tr>{['Time','Event','Client','AP','Detail'].map(x=><th key={x}>{x}</th>)}</tr></thead>
        <tbody>
          {feed.map((e,i)=><tr key={i} className={pinned===i?s.pinnedRow:''}>
            <td className={s.timeCell} onClick={()=>setPinned(p=>p===i?null:i)}>{e.time}</td>
            <td>{e.name}</td>
            <td className={s.link}><Link to={`/clients/${encodeURIComponent(e.client)}`}>{e.client}</Link></td>
            <td className={s.link}><Link to={`/aps/${encodeURIComponent(e.ap)}`}>{e.ap}</Link></td>
            <td>{e.detail}</td>
          </tr>)}
          {!feed.length&&<tr><td colSpan={5} className={s.empty}>{loading?'Loading…':filter?`No ${filter} events in this time range`:'No controller events in this time range'}</td></tr>}
        </tbody>
      </table>
    </section>
    <section className={`${s.panel} ${s.feed}`}>
      <div className={s.panelHead}><h2>Device syslog feed</h2><span>newest first, benign chatter excluded</span></div>
      <table>
        <thead><tr>{['Time','Severity','Device','Model','Message'].map(x=><th key={x}>{x}</th>)}</tr></thead>
        <tbody>
          {syslogFeed.map((r,i)=><tr key={i}>
            <td style={{whiteSpace:'nowrap'}}>{r.time}</td>
            <td>{r.severity==='error'?<span className={`${s.badge} ${s.badgeError}`}>ERROR</span>:r.severity==='warning'?<span className={`${s.badge} ${s.badgeWarning}`}>WARNING</span>:<span className={s.sevInfo}>{r.severity.toUpperCase()}</span>}</td>
            <td>{r.device}</td>
            <td>{r.model}</td>
            <td style={{whiteSpace:'normal'}}>{r.msg}</td>
          </tr>)}
          {!syslogFeed.length&&<tr><td colSpan={5} className={s.empty}>{loading?'Loading…':'No device syslog in this time range'}</td></tr>}
        </tbody>
      </table>
    </section>
    <p className={s.note}>Controller events come from the UniFi CEF stream; device syslog is grouped per device and severity with inform chatter excluded. Click a bar to filter the feed, a client to drill in, or a time to pin that row.</p>
  </div>;
}
