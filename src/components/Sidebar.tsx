import { NavLink } from 'react-router-dom';
import { useState } from 'react';
import s from './Sidebar.module.css';

interface NavItem {
  label: string;
  to: string;
  end?: boolean;
  icon: React.ReactNode;
}

const ICON_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const items: NavItem[] = [
  {
    label: 'Overview', to: '/', end: true,
    icon: <svg {...ICON_PROPS}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>,
  },
  {
    label: 'Access Points', to: '/access-points',
    icon: <svg {...ICON_PROPS}><path d="M5 14.5a10 10 0 0 1 14 0" /><path d="M8 17.5a6 6 0 0 1 8 0" /><path d="M11 20.5a2 2 0 0 1 2 0" /><path d="M12 4v5" /><circle cx="12" cy="4" r="1" /></svg>,
  },
  {
    label: 'Switches', to: '/switches',
    icon: <svg {...ICON_PROPS}><rect x="3" y="8" width="18" height="8" rx="1" /><path d="M7 11v2M10 11v2M14 11v2M17 11v2" /></svg>,
  },
  { label: 'Gateway', to: '/gateway', icon: <svg {...ICON_PROPS}><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" /></svg> },
  { label: 'Clients', to: '/clients', icon: <svg {...ICON_PROPS}><circle cx="9" cy="8" r="3" /><path d="M3 20c.4-3.3 2.4-5 6-5s5.6 1.7 6 5M16 5a3 3 0 0 1 0 6M17 15c2.3.4 3.6 2 4 5" /></svg> },
  { label: 'Map', to: '/map', icon: <svg {...ICON_PROPS}><circle cx="12" cy="5" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="m11 7-5 9m7-9 5 9M7 18h10" /></svg> },
  { label: 'Events', to: '/events', icon: <svg {...ICON_PROPS}><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="2" cy="6" r=".5" fill="currentColor" /><circle cx="2" cy="12" r=".5" fill="currentColor" /><circle cx="2" cy="18" r=".5" fill="currentColor" /></svg> },
  { label: 'Investigate', to: '/investigate', icon: <svg {...ICON_PROPS}><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M10 7v6M7 10h6" /></svg> },
];

const settingsItem: NavItem = {
  label: 'Configuration', to: '/settings',
  icon: <svg {...ICON_PROPS}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};

function SidebarItem({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `${s.item} ${isActive ? s.itemActive : ''}`}
      title={collapsed ? item.label : undefined}
    >
      <span className={s.itemIcon}>{item.icon}</span>
      {!collapsed && <span className={s.itemLabel}>{item.label}</span>}
    </NavLink>
  );
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <nav className={`${s.sidebar} ${collapsed ? s.sidebarCollapsed : ''}`}>
      <div className={s.section}>
        {items.map((item) => (
          <SidebarItem key={item.to} item={item} collapsed={collapsed} />
        ))}
      </div>

      <div className={s.spacer} />

      <div className={s.divider} />
      <div className={s.section}>
        <SidebarItem item={settingsItem} collapsed={collapsed} />
      </div>

      <button
        className={s.collapseBtn}
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg className={`${s.collapseIcon} ${collapsed ? s.collapseIconFlipped : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </svg>
        {!collapsed && 'Collapse'}
      </button>
    </nav>
  );
}
