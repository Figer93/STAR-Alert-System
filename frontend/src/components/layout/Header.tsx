import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { Activity, LayoutDashboard, History, Radio, Settings, Menu, X, Wifi, WifiOff } from 'lucide-react'

interface Props { wsConnected: boolean }

const navItems = [
  { to: '/',         label: 'Dashboard', icon: LayoutDashboard },
  { to: '/history',  label: 'History',   icon: History },
  { to: '/sources',  label: 'Sources',   icon: Radio },
  { to: '/settings', label: 'Settings',  icon: Settings },
]

export default function Header({ wsConnected }: Props) {
  const [time, setTime]         = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const tick = () => setTime(new Date().toUTCString().slice(17, 25) + ' UTC')
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

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
            background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(59,130,246,0.08) 100%)',
            border: '1px solid rgba(59,130,246,0.3)',
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
          display: 'flex', gap: 1,
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
            background: wsConnected ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${wsConnected ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
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
