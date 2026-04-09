import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity, LayoutDashboard, History, Radio, Settings,
  Menu, X, Wifi, WifiOff,
  Globe, Plug, TrendingUp, Search, ChevronDown, Monitor,
  AlertTriangle, SlidersHorizontal,
} from 'lucide-react'

interface Props { wsConnected: boolean }

const navItems = [
  { to: '/',         label: 'Dashboard', icon: LayoutDashboard },
  { to: '/history',  label: 'History',   icon: History },
  { to: '/sources',  label: 'Sources',   icon: Radio },
  { to: '/settings', label: 'Settings',  icon: Settings },
]

const networkSubItems = [
  { to: '/network',             label: 'Overview',    icon: Globe },
  { to: '/network/ports',       label: 'Ports',       icon: Plug },
  { to: '/network/latency',     label: 'Latency',     icon: Activity },
  { to: '/network/traffic',     label: 'Traffic',     icon: TrendingUp },
  { to: '/network/investigate', label: 'Investigate', icon: Search },
  { to: '/network/devices',     label: 'Devices',     icon: Monitor },
  { to: '/network/incidents',   label: 'Incidents',   icon: AlertTriangle },
  { to: '/network/settings',    label: 'Settings',    icon: SlidersHorizontal },
]

export default function Header({ wsConnected }: Props) {
  const [time, setTime]           = useState('')
  const [menuOpen, setMenuOpen]   = useState(false)
  const [networkOpen, setNetworkOpen] = useState(false)
  const [openIncidents, setOpenIncidents] = useState(0)

  const networkRef = useRef<HTMLDivElement>(null)
  const location   = useLocation()
  const isNetworkActive = location.pathname.startsWith('/network')

  // Clock
  useEffect(() => {
    const tick = () => setTime(new Date().toUTCString().slice(17, 25) + ' UTC')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Fetch open incident count for badge — silent on failure (collector may not be running)
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/network/overview')
        if (res.ok) {
          const d = await res.json()
          setOpenIncidents(d.open_incidents ?? 0)
        }
      } catch { /* no collector data yet */ }
    }
    poll()
    const id = setInterval(poll, 60_000)
    return () => clearInterval(id)
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (networkRef.current && !networkRef.current.contains(e.target as Node)) {
        setNetworkOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close dropdown on navigation
  useEffect(() => { setNetworkOpen(false) }, [location.pathname])

  const badge = openIncidents > 0 && (
    <span style={{
      minWidth: 16, height: 16,
      background: 'var(--red)',
      borderRadius: 8,
      fontSize: 9, fontWeight: 700,
      color: 'var(--text-bright)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 3px',
      lineHeight: 1,
      flexShrink: 0,
    }}>
      {openIncidents > 99 ? '99+' : openIncidents}
    </span>
  )

  return (
    <>
      <header style={{
        height: 48,
        background: 'var(--sidebar)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 18px',
        flexShrink: 0,
        zIndex: 10,
        position: 'relative',
      }}>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 26, height: 26,
            background: 'linear-gradient(135deg, var(--accent-glow) 0%, var(--accent-dim) 100%)',
            border: '1px solid var(--blue-border)',
            borderRadius: 7,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Activity size={14} color="var(--accent)" />
          </div>
          <span style={{
            fontSize: 12, fontWeight: 700, letterSpacing: '0.1em',
            color: 'var(--text-head)', textTransform: 'uppercase',
          }}>
            ST&amp;R Alerts
          </span>
        </div>

        {/* Desktop nav — centred */}
        <nav style={{
          display: 'flex', gap: 2, alignItems: 'center',
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        }} className="header-desktop-nav">

          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 13px',
                borderRadius: 6,
                fontSize: 13, fontWeight: 500, letterSpacing: '0.02em',
                color:      isActive ? 'var(--text-head)' : 'var(--text-muted)',
                background: isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                border:     isActive ? '1px solid rgba(255,255,255,0.1)' : '1px solid transparent',
                textDecoration: 'none',
                transition: 'all 0.15s ease',
              })}
            >
              <Icon size={13} />
              {label}
            </NavLink>
          ))}

          {/* Network dropdown group */}
          <div ref={networkRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setNetworkOpen(v => !v)}
              aria-expanded={networkOpen}
              aria-haspopup="menu"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, fontWeight: 500,
                color:      isNetworkActive ? 'var(--text-head)' : 'var(--text-dim)',
                background: isNetworkActive ? 'var(--bg-raised)' : 'transparent',
                border:     isNetworkActive ? '1px solid var(--border-bright)' : '1px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Globe size={13} />
              Network
              {badge}
              <ChevronDown size={10} style={{
                transform: networkOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
                opacity: 0.6,
              }} />
            </button>

            {networkOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-bright)',
                  borderRadius: 'var(--radius)',
                  padding: 4,
                  minWidth: 164,
                  zIndex: 100,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
              >
                {networkSubItems.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/network'}
                    role="menuitem"
                    style={({ isActive }) => ({
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12, fontWeight: 500,
                      color:      isActive ? 'var(--text-head)' : 'var(--text-dim)',
                      background: isActive ? 'var(--bg-raised)' : 'transparent',
                      textDecoration: 'none',
                      transition: 'all 0.12s ease',
                      whiteSpace: 'nowrap',
                    })}
                  >
                    <Icon size={12} />
                    {label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="mono header-clock" style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>
            {time}
          </span>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '3px 9px',
            borderRadius: 20,
            background: wsConnected ? 'var(--green-dim)' : 'var(--red-dim)',
            border: `1px solid ${wsConnected ? 'var(--green-border)' : 'var(--red-border)'}`,
          }}>
            {wsConnected ? (
              <Wifi size={11} color="var(--green)" />
            ) : (
              <WifiOff size={11} color="var(--red)" />
            )}
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
              color: wsConnected ? 'var(--green)' : 'var(--red)',
              textTransform: 'uppercase',
            }}>
              {wsConnected ? 'Live' : 'Off'}
            </span>
          </div>

          {/* Mobile hamburger */}
          <button
            className="btn btn-ghost header-hamburger"
            style={{ padding: 4 }}
            onClick={() => setMenuOpen(v => !v)}
            aria-label="Toggle menu"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {menuOpen && (
        <div
          className="overlay"
          onClick={() => setMenuOpen(false)}
          style={{ zIndex: 20 }}
        >
          <nav
            className="slide-in-right"
            style={{
              position: 'absolute', top: 0, right: 0,
              width: 220, height: '100%',
              background: 'var(--sidebar)',
              borderLeft: '1px solid rgba(255,255,255,0.07)',
              padding: '60px 12px 24px',
              display: 'flex', flexDirection: 'column', gap: 4,
              overflowY: 'auto',
            }}
            onClick={e => e.stopPropagation()}
          >
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={() => setMenuOpen(false)}
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius)',
                  fontSize: 14, fontWeight: 500,
                  color:      isActive ? 'var(--text-head)' : 'var(--text-muted)',
                  background: isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                  textDecoration: 'none',
                  transition: 'all 0.15s ease',
                })}
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}

            {/* Network section */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              margin: '8px 14px 2px',
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                color: 'var(--text-dim)', textTransform: 'uppercase',
              }}>
                Network
              </span>
              {openIncidents > 0 && (
                <span style={{
                  background: 'var(--red)', color: '#fff',
                  fontSize: 9, fontWeight: 700,
                  padding: '1px 5px', borderRadius: 6,
                  lineHeight: 1.6,
                }}>
                  {openIncidents}
                </span>
              )}
            </div>

            {networkSubItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/network'}
                onClick={() => setMenuOpen(false)}
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px',
                  borderRadius: 'var(--radius)',
                  fontSize: 14, fontWeight: 500,
                  color:      isActive ? 'var(--text-head)' : 'var(--text-dim)',
                  background: isActive ? 'var(--bg-raised)' : 'transparent',
                  textDecoration: 'none',
                  transition: 'color 0.15s',
                })}
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}

            <div style={{ marginTop: 'auto', fontSize: 11, color: 'var(--text-dim)', padding: '0 14px' }}>
              {time}
            </div>
          </nav>
        </div>
      )}

      <style>{`
        .header-hamburger { display: none; }
        @media (max-width: 768px) {
          .header-desktop-nav { display: none !important; }
          .header-clock       { display: none !important; }
          .header-hamburger   { display: flex !important; }
        }
      `}</style>
    </>
  )
}
