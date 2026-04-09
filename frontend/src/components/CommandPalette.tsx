import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import {
  Search, LayoutDashboard, History, Radio, Settings,
  Network, GitBranch, Wifi, Activity, Layers,
  AlertTriangle, Telescope, Clock, ArrowRight
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

const RECENT_KEY = 'star-cmd-recent'
const MAX_RECENT = 5

const NAV_ITEMS = [
  { id: 'nav-dash',        label: 'Dashboard',         icon: LayoutDashboard, to: '/'                    },
  { id: 'nav-history',     label: 'Alert History',     icon: History,         to: '/history'             },
  { id: 'nav-sources',     label: 'Sources',           icon: Radio,           to: '/sources'             },
  { id: 'nav-settings',    label: 'Settings',          icon: Settings,        to: '/settings'            },
  { id: 'nav-network',     label: 'Network Overview',  icon: Network,         to: '/network'             },
  { id: 'nav-ports',       label: 'Switch Ports',      icon: GitBranch,       to: '/network/ports'       },
  { id: 'nav-devices',     label: 'Devices',           icon: Layers,          to: '/network/devices'     },
  { id: 'nav-latency',     label: 'Latency',           icon: Activity,        to: '/network/latency'     },
  { id: 'nav-traffic',     label: 'Traffic',           icon: Wifi,            to: '/network/traffic'     },
  { id: 'nav-incidents',   label: 'Incidents',         icon: AlertTriangle,   to: '/network/incidents'   },
  { id: 'nav-investigate', label: 'Investigate',       icon: Telescope,       to: '/network/investigate' },
]

function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}
function saveRecent(id: string) {
  const prev = getRecent().filter(x => x !== id)
  localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...prev].slice(0, MAX_RECENT)))
}

interface Props {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const ipPattern = /^(\d{1,3}\.){1,3}\d{0,3}$/
  const isIpQuery = ipPattern.test(query.trim()) && query.trim().length > 0

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const execute = useCallback((id: string, to: string) => {
    saveRecent(id)
    navigate(to)
    onClose()
  }, [navigate, onClose])

  // Close on Escape (cmdk also handles this, belt-and-suspenders)
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const recent = getRecent()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmd-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
          onClick={e => { if (e.target === e.currentTarget) onClose() }}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <Command className="cmd-dialog" shouldFilter={!isIpQuery} loop>
              {/* Input */}
              <div className="cmd-input-wrap">
                <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <Command.Input
                  className="cmd-input"
                  placeholder="Search pages, alerts, IPs…"
                  value={query}
                  onValueChange={setQuery}
                  autoComplete="off"
                  spellCheck={false}
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 2px' }}
                  >
                    ×
                  </button>
                )}
              </div>

              {/* Results */}
              <Command.List className="cmd-list">
                <Command.Empty className="cmd-empty">No results for &ldquo;{query}&rdquo;</Command.Empty>

                {isIpQuery && (
                  <Command.Group className="cmd-group" heading={<span className="cmd-group-label">Actions</span>}>
                    <Command.Item
                      className="cmd-item"
                      value={`investigate ${query}`}
                      onSelect={() => execute(`investigate-${query}`, `/network/investigate?ip=${encodeURIComponent(query.trim())}`)}
                    >
                      <Telescope size={14} className="cmd-item-icon" />
                      <span style={{ flex: 1 }}>Investigate {query}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Open device investigation</span>
                      <ArrowRight size={12} style={{ color: 'var(--text-dim)' }} />
                    </Command.Item>
                  </Command.Group>
                )}

                <Command.Group className="cmd-group" heading={<span className="cmd-group-label">{query ? 'Pages' : 'Navigation'}</span>}>
                  {NAV_ITEMS.map(item => (
                    <Command.Item
                      key={item.id}
                      className="cmd-item"
                      value={item.label}
                      onSelect={() => execute(item.id, item.to)}
                    >
                      <item.icon size={14} className="cmd-item-icon" />
                      <span style={{ flex: 1 }}>{item.label}</span>
                      {!query && recent.includes(item.id) && (
                        <Clock size={11} style={{ color: 'var(--text-dim)' }} />
                      )}
                      <ArrowRight size={12} style={{ color: 'var(--text-dim)' }} />
                    </Command.Item>
                  ))}
                </Command.Group>
              </Command.List>

              {/* Footer */}
              <div className="cmd-footer">
                <span><kbd>↑↓</kbd> navigate</span>
                <span><kbd>↵</kbd> select</span>
                <span><kbd>esc</kbd> close</span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
