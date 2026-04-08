import { useEffect, useState, useCallback } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, History, Radio, Settings,
  Network, GitBranch, Wifi, Activity,
  Search, Layers, AlertTriangle, Telescope,
  ChevronRight
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

// ── UTC Clock ─────────────────────────────────────────────────────────────────
function UTCClock() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setTime(
        `${String(now.getUTCHours()).padStart(2,'0')}:` +
        `${String(now.getUTCMinutes()).padStart(2,'0')}:` +
        `${String(now.getUTCSeconds()).padStart(2,'0')} UTC`
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="utc-clock">{time}</span>
}

// ── Page meta ─────────────────────────────────────────────────────────────────
const PAGE_META: Record<string, { title: string; crumbs: string[] }> = {
  '/':                  { title: 'Dashboard', crumbs: [] },
  '/history':           { title: 'Alert History', crumbs: ['Alerts'] },
  '/sources':           { title: 'Sources', crumbs: ['Alerts'] },
  '/settings':          { title: 'Settings', crumbs: [] },
  '/network':           { title: 'Overview', crumbs: ['Network'] },
  '/network/ports':     { title: 'Switch Ports', crumbs: ['Network'] },
  '/network/latency':   { title: 'Latency', crumbs: ['Network'] },
  '/network/traffic':   { title: 'Traffic', crumbs: ['Network'] },
  '/network/investigate': { title: 'Investigate', crumbs: ['Network'] },
  '/network/devices':   { title: 'Devices', crumbs: ['Network'] },
  '/network/incidents': { title: 'Incidents', crumbs: ['Network'] },
  '/network/settings':  { title: 'Settings', crumbs: ['Network'] },
}

// ── Sidebar items ─────────────────────────────────────────────────────────────
const TOP_NAV = [
  { to: '/',        icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/history', icon: History,         label: 'History' },
  { to: '/sources', icon: Radio,           label: 'Sources' },
]

const NETWORK_NAV = [
  { to: '/network',             icon: Network,       label: 'Overview' },
  { to: '/network/ports',       icon: GitBranch,     label: 'Ports' },
  { to: '/network/devices',     icon: Layers,        label: 'Devices' },
  { to: '/network/latency',     icon: Activity,      label: 'Latency' },
  { to: '/network/traffic',     icon: Wifi,          label: 'Traffic' },
  { to: '/network/incidents',   icon: AlertTriangle, label: 'Incidents' },
  { to: '/network/investigate', icon: Telescope,     label: 'Investigate' },
]

const BOTTOM_NAV = [
  { to: '/settings', icon: Settings, label: 'Settings' },
]

// ── Sidebar divider ───────────────────────────────────────────────────────────
function Divider() {
  return <div style={{ width: 28, height: 1, background: 'var(--border)', margin: '4px 0' }} />
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar() {
  return (
    <nav className="app-sidebar">
      {/* Logo mark */}
      <div style={{
        width: 32, height: 32,
        background: 'var(--accent)',
        borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 8,
        flexShrink: 0,
      }}>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>S</span>
      </div>

      {TOP_NAV.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          data-tooltip={item.label}
        >
          <item.icon size={17} />
        </NavLink>
      ))}

      <Divider />

      {NETWORK_NAV.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          data-tooltip={item.label}
        >
          <item.icon size={17} />
        </NavLink>
      ))}

      <div style={{ flex: 1 }} />

      {BOTTOM_NAV.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          data-tooltip={item.label}
        >
          <item.icon size={17} />
        </NavLink>
      ))}
    </nav>
  )
}

// ── Topbar ────────────────────────────────────────────────────────────────────
interface TopbarProps {
  wsConnected: boolean
  onSearchOpen: () => void
}

function Topbar({ wsConnected, onSearchOpen }: TopbarProps) {
  const location = useLocation()
  const meta = PAGE_META[location.pathname] ?? { title: location.pathname.split('/').pop() ?? 'Page', crumbs: [] }

  return (
    <header className="app-topbar">
      {/* Breadcrumb */}
      <div className="topbar-breadcrumb">
        {meta.crumbs.map((crumb, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{crumb}</span>
            <ChevronRight size={11} style={{ color: 'var(--text-dim)' }} />
          </span>
        ))}
        <span className="topbar-title">{meta.title}</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Search trigger */}
      <button className="search-trigger" onClick={onSearchOpen}>
        <Search size={13} />
        <span>Search alerts, devices…</span>
        <kbd>⌘K</kbd>
      </button>

      {/* LIVE badge */}
      <div className={`live-badge ${wsConnected ? 'connected' : ''}`}>
        <span
          className={wsConnected ? 'pulse' : ''}
          style={{
            width: 6, height: 6,
            borderRadius: '50%',
            background: wsConnected ? 'var(--green)' : 'var(--text-dim)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        {wsConnected ? 'LIVE' : 'OFFLINE'}
      </div>

      {/* Clock */}
      <UTCClock />
    </header>
  )
}

// ── Route transition wrapper ──────────────────────────────────────────────────
export function RouteMotion({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{ height: '100%' }}
    >
      {children}
    </motion.div>
  )
}

// ── App Shell ─────────────────────────────────────────────────────────────────
interface AppShellProps {
  wsConnected: boolean
  onSearchOpen: () => void
  children: React.ReactNode
}

export function AppShell({ wsConnected, onSearchOpen, children }: AppShellProps) {
  // Keyboard shortcut: Cmd/Ctrl+K to open search
  const handleKey = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      onSearchOpen()
    }
  }, [onSearchOpen])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar wsConnected={wsConnected} onSearchOpen={onSearchOpen} />
        <main className="app-content">
          {children}
        </main>
      </div>
    </div>
  )
}

export { AnimatePresence }
