# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

STAR Alert System — an infrastructure monitoring dashboard for ST&R Limited. Module 1 (Alert Dashboard) is live on Railway. Module 2 (Network Monitor) is in planning/early development.

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
| pfSense | Syslog listener | Active |
| PingPlotter | Webhook | Planned |

## Common Commands

### Backend

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally (SQLite)
DATABASE_URL=sqlite+aiosqlite:///./alerts.db uvicorn backend.main:app --reload

# Run Alembic migrations against production DB
alembic upgrade head

# Create a new migration
alembic revision --autogenerate -m "description"
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Dev server at http://localhost:5173
npm run build      # Production build
npm run lint       # ESLint
```

### Docker (local full-stack)

```bash
docker-compose up --build
# Backend: http://localhost:8000
# Frontend: http://localhost:5173 (proxied via nginx)
```

## Architecture

```
GitHub (main) → Railway auto-deploy
├── Backend service:  FastAPI + Python 3.12 (Dockerfile.backend)
└── Frontend service: Vite build → Nginx (Dockerfile.frontend)
                      nginx.conf uses envsubst for BACKEND_HOST at container start

Database: Supabase PostgreSQL (asyncpg)
External sources: NinjaRMM webhooks, pfSense UDP syslog, PingPlotter webhooks
```

**WebSocket flow:** Frontend (`App.tsx`) opens a single WS connection to `/ws`. The backend `websocket_manager.py` broadcasts to all connected clients on: `alert.new`, `alert.updated`, `source.status_change`, `stats.update`.

**Alert pipeline:** Ingest router → `alert_engine.py` (normalize → classify → deduplicate via fingerprint → route via rules) → `rule_engine.py` → notifiers (Telegram, Email) → WebSocket broadcast.

**Background tasks** (started in `main.py` lifespan):
- Every 30s: broadcast stats to all WS clients
- Every 60s: check for sources with no heartbeat >5 min, auto-create "source offline" critical alert
- Every 60s: run network health checks (WAN loss, port errors, device offline, latency, traffic anomaly)

## Key Files

| File | Purpose |
|------|---------|
| `backend/main.py` | FastAPI app, lifespan, middleware, router registration |
| `backend/config.py` | All env vars via Pydantic `Settings` |
| `backend/database.py` | SQLAlchemy async engine + session factory |
| `backend/models.py` | ORM: `Source`, `Alert`, `Rule`, `NotificationLog` |
| `backend/alert_engine.py` | Core alert processing pipeline |
| `backend/network_monitor.py` | Network health check background worker |
| `backend/adapters/` | One file per integration source; isolated — crashes don't affect core |
| `backend/routers/ws.py` | WebSocket endpoint |
| `backend/routers/network.py` | Network Monitor API endpoints |
| `frontend/src/App.tsx` | Router setup + WebSocket connection lifecycle |
| `railway.toml` | Railway service config (start commands, health checks) |
| `frontend/nginx.conf` | Nginx reverse proxy; `$BACKEND_HOST` substituted at runtime via envsubst |

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
  pages/
    Dashboard, AlertHistory, Sources, Settings
    network/      Overview, Ports, Latency, Traffic, Investigate
  types/          index.ts
  index.css       Design tokens + global styles
```

## Design Tokens (index.css)

All colors/spacing defined as CSS custom properties in `:root`. Always use `var(--...)` — never hardcode hex values in component styles.

## Environment Variables

Copy `.env.example` to `.env`. Key vars:

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | `sqlite+aiosqlite:///./alerts.db` (dev) or `postgresql+asyncpg://...` (prod) |
| `TELEGRAM_BOT_TOKEN` | Required for notifications |
| `TELEGRAM_CHAT_IDS` | Comma-separated chat IDs |
| `NINJARMM_WEBHOOK_SECRET` | Validates incoming NinjaRMM payloads |
| `PFSENSE_SYSLOG_PORT` | UDP port (default 514) |
| `VITE_API_URL` | Set at frontend build time |
| `BACKEND_HOST` | Used by nginx envsubst at container startup |
| `STAR_URL` | Optional — appended to Telegram alerts as a deep-link |

## Database

- SQLAlchemy 2.0 async with `asyncpg` driver in production, `aiosqlite` in dev
- Alembic manages schema migrations; migration files in `migrations/versions/`
- **Do not run `alembic upgrade head` in Railway startCommand** — asyncpg+PgBouncer hangs (run migrations manually or via a one-off job)

## Deployment

- Push to `main` → Railway auto-deploys both services
- Backend health check: `GET /health` (returns DB connectivity status)
- Frontend nginx proxies `/api/` and `/ws` to the backend service using `$BACKEND_HOST`
- The nginx `proxy_set_header Host` must use `$BACKEND_HOST` (the backend service hostname), not the frontend hostname

## Module 2 – Network Monitor (upcoming)

See `STAR_NETWORK_PLAN_V2.md` and `STAR_PRD_v2.md` for the full spec. Involves:
- On-premise Docker Compose collector (goflow2 + telegraf + fping)
- TimescaleDB extension on Supabase
- New `/api/network/*` routes
- Six new frontend screens under a Network Monitor section

## Code Style

- Python: async/await everywhere, no sync DB calls
- Frontend: React functional components, no class components
- No em dashes in any output
- British English in all user-facing text

## Important Constraints

- Do NOT run `alembic upgrade head` automatically
- Do NOT hardcode any IPs, tokens, or credentials
- Do NOT modify existing alert pipeline when adding network module
- New network tables go in a separate migration file (002_network_schema.sql)
- Collector lives in /collector directory, completely separate from backend

## Current State — Module 1

- Alert dashboard is LIVE on Railway, working in production
- Do not refactor or reorganise existing backend/frontend files
- Only ADD new files/routes, do not modify working code unless explicitly asked
