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
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        flexShrink: 0,
        zIndex: 10,
        position: 'relative',
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28,
            background: 'var(--accent-dim)',
            border: '1px solid rgba(59,130,246,0.25)',
            borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Activity size={15} color="var(--accent)" />
          </div>
          <span style={{
            fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
            color: 'var(--text-head)', textTransform: 'uppercase',
          }}>
            ST&amp;R Alerts
          </span>
        </div>

        {/* Desktop nav — centred */}
        <nav style={{
          display: 'flex', gap: 2,
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        }} className="header-desktop-nav">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, fontWeight: 500,
                color:      isActive ? 'var(--text-head)' : 'var(--text-dim)',
                background: isActive ? 'var(--bg-raised)' : 'transparent',
                border:     isActive ? '1px solid var(--border-bright)' : '1px solid transparent',
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {wsConnected ? (
              <Wifi size={13} color="var(--green)" style={{ filter: 'drop-shadow(0 0 4px var(--green))' }} />
            ) : (
              <WifiOff size={13} color="var(--red)" />
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
              background: 'var(--bg-surface)',
              borderLeft: '1px solid var(--border)',
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
