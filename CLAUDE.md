# STAR Alert System — Claude Context

## Project
IT infrastructure monitoring dashboard. Receives alerts from multiple sources and displays them in real time.

## Stack
- **Backend**: FastAPI (Python), SQLite (dev) / PostgreSQL (prod via Supabase), Alembic migrations, Railway deployment
- **Database**: Supabase-hosted PostgreSQL — connection via `DATABASE_URL` (asyncpg pooler URL). No Supabase client SDK; the backend talks directly to Postgres through SQLAlchemy.
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4, Vite, WebSocket real-time updates
- **Key libs**: framer-motion, recharts, @tanstack/react-virtual, sonner (toasts), lucide-react

## Sources
| Source | Method | Status |
|---|---|---|
| NinjaRMM | Webhook (POST /ingest/ninjarmm) | Active |
| UniFi Network | Polling (unifi_poller.py) | Active |
| pfSense | Syslog listener | Planned |
| PingPlotter | Webhook | Planned |

## Severity Colors (never change)
| Severity | Color | Hex | CSS var |
|---|---|---|---|
| CRITICAL | Red | `#ff4444` | `var(--red)` |
| WARNING | Amber | `#f59e0b` | `var(--amber)` |
| INFO | Blue | `#3b82f6` | `var(--blue)` |
| OK / RESOLVED | Green / muted | `#22c55e` | `var(--green)` |
| ACKED | Green-ish | `#22c55e` | `var(--green)` |

## UI Principles
- **Dark theme only** — base background `#080b12` (`--bg-base`), surfaces `#0d1117` (`--bg-surface`)
- **Stat cards**: colored top border (2px) matching severity, with glow box-shadow
- **Alert rows**: left border (3px) color = severity with glow, left `sev-bar-{severity}` class
- **Severity CSS classes**: `.sev-critical`, `.sev-bar-critical`, `.sev-bg-critical`, `.sev-dot-critical` (and same for warning, info, ok)
- **Animations**: framer-motion for enter/exit transitions; `.pulse` class for pulsing dots
- **Charts**: recharts for ActivityChart sparkline in right sidebar
- **Live badge**: pulsing green dot = WebSocket connected (`wsConnected` state)
- **Tables**: sortable columns, row hover states
- **Virtualization**: `@tanstack/react-virtual` used in AlertFeed when list > 50 rows
- **New features**: must match existing dark aesthetic; use CSS vars, not hardcoded colors

## Frontend Structure
```
frontend/src/
  components/
    alerts/       AlertDetail, AlertFilters
    dashboard/    AlertFeed, AlertItem, ActivityChart, MetricCard, SourceStatus
    adapters/     AdapterWizard
    layout/       Header
    ErrorBoundary, Skeleton
  hooks/          useAlerts, useWebSocket
  lib/            api.ts, notifications.ts
  pages/          Dashboard, AlertHistory, Sources, Settings
  types/          index.ts
  index.css       Design tokens + global styles
```

## Design Tokens (index.css)
All colors/spacing defined as CSS custom properties in `:root`. Always use `var(--...)` — never hardcode hex values in component styles.

## Deployment
- Railway: backend + frontend as separate services
- Backend entrypoint: `alembic upgrade head && uvicorn backend.main:app`
- Frontend: Nginx serving Vite build output
