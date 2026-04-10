# STAR Alert System — Master Context

## Project Overview
Internal IT infrastructure monitoring platform for ST&R Limited (~130 users, FCA-regulated).
Two modules: Module 1 (Alert Dashboard) — live in production. Module 2 (Network Monitor) — early development.

## Stack
- Backend: FastAPI · Python 3.11 · SQLAlchemy 2.0 async (asyncpg prod / aiosqlite dev) · Alembic migrations
- Frontend: React 19 · TypeScript · Tailwind v4 · Vite
- Database: Supabase PostgreSQL (no Supabase client SDK — raw SQLAlchemy only)
- Deploy: Railway (push to main → auto-deploy backend + frontend as separate services)
- Notifications: Telegram + Email
- Real-time: WebSocket (single connection per client at /ws)

## Alert Pipeline
Ingest router → alert_engine.py → rule_engine.py → notifiers → WebSocket broadcast
Events: alert.new · alert.updated · source.status_change · stats.update

## Background Tasks (main.py lifespan)
- Stats broadcast: every 30s
- Source offline check: every 60s
- Network health checks: every 60s

## Critical Rules — Never Break These
- NEVER run `alembic upgrade head` in Railway startCommand (asyncpg + PgBouncer hangs — run migrations manually)
- NEVER use Supabase client SDK — SQLAlchemy only
- NEVER hardcode hex colors — use CSS vars: var(--red), var(--amber), var(--blue), var(--green)
- NEVER change WebSocket event names (frontend depends on exact strings)
- NEVER change existing API response shapes (breaking change for frontend)
- Dark theme only — no light mode

## DB Models (ORM — models.py)
Source, Alert, Rule, NotificationLog
Network Monitor tables: see migrations/versions/ for current schema

## Adapters (backend/adapters/)
ninjarmm_adapter.py · pfsense_adapter.py · pingplotter_adapter.py · syslog_listener.py · unifi_adapter.py

## Collector (on-premise, collector/)
Docker Compose: goflow2 (NetFlow UDP:9995) + telegraf + fping Python service
Pushes data to backend API — does NOT connect to Supabase directly

## Frontend Structure
- Pages: Dashboard, AlertHistory, Sources, Settings + network/ (Overview, Devices, Incidents, Investigate, Latency, Ports, Traffic, NetworkSettings)
- Key hooks: useAlerts.ts · useWebSocket.ts
- API calls: lib/api.ts only — never fetch() directly in components

## Module 2 Status
Network Monitor routers exist (routers/network.py), collector exists, pages scaffolded.
Still in early development — treat as work in progress.
