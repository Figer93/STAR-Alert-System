import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, LayoutDashboard, History, Radio, Settings,
  Network, GitBranch, Wifi, Activity, Layers,
  AlertTriangle, Telescope, Clock, ArrowRight
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

const RECENT_KEY = 'star-cmd-recent'
const MAX_RECENT = 5

interface NavItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  action: 'navigate'
  to: string
  group: 'navigation'
}

interface SearchItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  action: 'investigate'
  to: string
  group: 'actions'
}

type CmdItem = NavItem | SearchItem

const NAV_ITEMS: CmdItem[] = [
  { id: 'nav-dash',       label: 'Dashboard',         icon: LayoutDashboard, action: 'navigate', to: '/',                    group: 'navigation' },
  { id: 'nav-history',    label: 'Alert History',     icon: History,         action: 'navigate', to: '/history',             group: 'navigation' },
  { id: 'nav-sources',    label: 'Sources',           icon: Radio,           action: 'navigate', to: '/sources',             group: 'navigation' },
  { id: 'nav-settings',   label: 'Settings',          icon: Settings,        action: 'navigate', to: '/settings',            group: 'navigation' },
  { id: 'nav-network',    label: 'Network Overview',  icon: Network,         action: 'navigate', to: '/network',             group: 'navigation' },
  { id: 'nav-ports',      label: 'Switch Ports',      icon: GitBranch,       action: 'navigate', to: '/network/ports',       group: 'navigation' },
  { id: 'nav-devices',    label: 'Devices',           icon: Layers,          action: 'navigate', to: '/network/devices',     group: 'navigation' },
  { id: 'nav-latency',    label: 'Latency',           icon: Activity,        action: 'navigate', to: '/network/latency',     group: 'navigation' },
  { id: 'nav-traffic',    label: 'Traffic',           icon: Wifi,            action: 'navigate', to: '/network/traffic',     group: 'navigation' },
  { id: 'nav-incidents',  label: 'Incidents',         icon: AlertTriangle,   action: 'navigate', to: '/network/incidents',   group: 'navigation' },
  { id: 'nav-investigate',label: 'Investigate',       icon: Telescope,       action: 'navigate', to: '/network/investigate', group: 'navigation' },
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
  const navigate  = useNavigate()
  const [query, setQuery]   = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef  = useRef<HTMLInputElement>(null)
  const listRef   = useRef<HTMLDivElement>(null)

  // IP / hostname detect in query
  const ipPattern = /^(\d{1,3}\.){1,3}\d{0,3}$/
  const isIpQuery = ipPattern.test(query.trim()) && query.trim().length > 0

  const allItems: CmdItem[] = [
    ...NAV_ITEMS,
    ...(isIpQuery ? [{
      id: `investigate-${query}`,
      label: `Investigate ${query}`,
      description: 'Open device investigation',
      icon: Telescope,
      action: 'investigate' as const,
      to: `/network/investigate?ip=${encodeURIComponent(query.trim())}`,
      group: 'actions' as const,
    }] : []),
  ]

  const filtered = query.trim()
    ? allItems.filter(item =>
        item.label.toLowerCase().includes(query.toLowerCase()) ||
        item.description?.toLowerCase().includes(query.toLowerCase())
      )
    : allItems.filter(item => {
        const recent = getRecent()
        return recent.includes(item.id) || item.group === 'navigation'
      }).slice(0, 8)

  // Group results
  const navGroup     = filtered.filter(i => i.group === 'navigation')
  const actionsGroup = filtered.filter(i => i.group === 'actions')

  const flatList = [...actionsGroup, ...navGroup]

  const execute = useCallback((item: CmdItem) => {
    saveRecent(item.id)
    navigate(item.to)
    onClose()
  }, [navigate, onClose])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 10)
      setQuery('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => { setCursor(0) }, [query])

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, flatList.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      const item = flatList[cursor]
      if (item) execute(item)
    }
  }, [open, flatList, cursor, execute, onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // Scroll cursor into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

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
            className="cmd-dialog"
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            {/* Input */}
            <div className="cmd-input-wrap">
              <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input
                ref={inputRef}
                className="cmd-input"
                placeholder="Search pages, alerts, IPs…"
                value={query}
                onChange={e => setQuery(e.target.value)}
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
            <div className="cmd-list" ref={listRef}>
              {flatList.length === 0 && (
                <div className="cmd-empty">No results for "{query}"</div>
              )}

              {actionsGroup.length > 0 && (
                <>
                  <div className="cmd-group-label">Actions</div>
                  {actionsGroup.map((item, i) => (
                    <div
                      key={item.id}
                      data-idx={i}
                      className={`cmd-item ${cursor === i ? 'selected' : ''}`}
                      onClick={() => execute(item)}
                      onMouseEnter={() => setCursor(i)}
                    >
                      <item.icon size={14} className="cmd-item-icon" />
                      <span style={{ flex: 1 }}>{item.label}</span>
                      {item.description && (
                        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{item.description}</span>
                      )}
                      <ArrowRight size={12} style={{ color: 'var(--text-dim)' }} />
                    </div>
                  ))}
                </>
              )}

              {navGroup.length > 0 && (
                <>
                  <div className="cmd-group-label">
                    {query ? 'Pages' : 'Navigation'}
                  </div>
                  {navGroup.map((item, i) => {
                    const idx = actionsGroup.length + i
                    const recent = !query && getRecent().includes(item.id)
                    return (
                      <div
                        key={item.id}
                        data-idx={idx}
                        className={`cmd-item ${cursor === idx ? 'selected' : ''}`}
                        onClick={() => execute(item)}
                        onMouseEnter={() => setCursor(idx)}
                      >
                        <item.icon size={14} className="cmd-item-icon" />
                        <span style={{ flex: 1 }}>{item.label}</span>
                        {recent && (
                          <Clock size={11} style={{ color: 'var(--text-dim)' }} />
                        )}
                        <ArrowRight size={12} style={{ color: 'var(--text-dim)' }} />
                      </div>
                    )
                  })}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="cmd-footer">
              <span><kbd>↑↓</kbd> navigate</span>
              <span><kbd>↵</kbd> select</span>
              <span><kbd>esc</kbd> close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
