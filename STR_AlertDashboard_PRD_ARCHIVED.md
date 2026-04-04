# ST&R Infrastructure Alert Dashboard — Project Specification

**Version:** 1.0  
**Author:** Aleksandr Migulia  
**Target environment:** Local Windows machine → optional VPS migration  
**Stack:** Python (FastAPI) · SQLite → PostgreSQL · React · WebSockets · Telegram Bot API  

---

## 1. Project Overview

A self-hosted, real-time infrastructure alerting and monitoring dashboard for ST&R Limited. The system ingests events from multiple sources (pfSense, NinjaRMM, PingPlotter), normalises them into a unified alert format, and delivers notifications via Telegram, Email, and a live web dashboard.

The architecture is **plugin-based** from day one. Every integration is a standalone adapter. Adding a new source (DNS server, DHCP, dialler, CRM) requires only writing a new adapter — zero changes to the core engine.

### Goals

- Single pane of glass for all infrastructure events
- Telegram alerts to Alex and Campbell within seconds of an incident
- Web dashboard always open in browser — no login required on LAN
- Zero vendor lock-in, runs on a single Windows machine with Python installed
- Extensible: new integrations added without touching core code

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    INGESTION LAYER                       │
│  pfSense     NinjaRMM    PingPlotter   [Future sources]  │
│  (syslog)    (webhook)   (webhook)     (webhook/poll)    │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  CORE ENGINE (FastAPI)                   │
│  • Alert normaliser      • Severity classifier           │
│  • Deduplication         • Suppression / cooldown        │
│  • Rule engine           • Alert history (SQLite)        │
└──────────┬─────────────────────────┬────────────────────┘
           │                         │
┌──────────▼──────────┐   ┌──────────▼──────────────────┐
│  NOTIFICATION LAYER │   │     WEBSOCKET BROADCASTER    │
│  • Telegram bot      │   │  Pushes live updates to      │
│  • Email (SMTP)      │   │  all connected browser tabs  │
│  • [Future: Teams]   │   └──────────────────────────────┘
└─────────────────────┘              │
                           ┌─────────▼──────────┐
                           │   REACT DASHBOARD   │
                           │   (Vite · Tailwind) │
                           └────────────────────┘
```

---

## 3. Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Backend | Python 3.11 · FastAPI | Async, fast, easy to extend |
| Database | SQLite (dev) / PostgreSQL (prod) | Single file for now, easy to migrate |
| ORM | SQLAlchemy 2.0 + Alembic | Migrations handled cleanly |
| Real-time | WebSockets (built into FastAPI) | No extra broker needed |
| Frontend | React 18 · Vite · Tailwind CSS | Fast builds, familiar |
| Notifications | python-telegram-bot · smtplib | Lightweight, no extra services |
| Scheduling | APScheduler | Polling-based adapters |
| Config | .env + Pydantic Settings | All secrets in one place |
| Logging | Python logging → rotating file | Audit trail for all events |

---

## 4. Repository Structure

```
str-alert-dashboard/
├── backend/
│   ├── main.py                    # FastAPI app entry point
│   ├── config.py                  # Pydantic settings from .env
│   ├── database.py                # SQLAlchemy setup
│   ├── models.py                  # DB models: Alert, Source, Rule, NotificationLog
│   ├── schemas.py                 # Pydantic schemas (request/response)
│   ├── websocket_manager.py       # Manages active WS connections
│   ├── alert_engine.py            # Normalise → classify → deduplicate → route
│   ├── rule_engine.py             # Evaluate user-defined alert rules
│   ├── notifiers/
│   │   ├── __init__.py
│   │   ├── base.py                # Abstract Notifier class
│   │   ├── telegram_notifier.py
│   │   ├── email_notifier.py
│   │   └── [future_teams.py]
│   ├── adapters/
│   │   ├── __init__.py
│   │   ├── base.py                # Abstract Adapter class
│   │   ├── pfsense_adapter.py     # Syslog UDP listener
│   │   ├── ninjarmm_adapter.py    # Webhook receiver
│   │   ├── pingplotter_adapter.py # Webhook receiver
│   │   ├── dns_adapter.py         # [Future] DNS/DHCP event adapter
│   │   ├── dialler_adapter.py     # [Future] Dialler system adapter
│   │   └── crm_adapter.py         # [Future] CRM event adapter
│   ├── routers/
│   │   ├── alerts.py              # GET /alerts, GET /alerts/{id}, DELETE
│   │   ├── sources.py             # GET /sources, PATCH /sources/{id}
│   │   ├── rules.py               # CRUD /rules
│   │   ├── stats.py               # GET /stats (metrics for dashboard)
│   │   ├── ingest.py              # POST /ingest/{source} (webhook entry points)
│   │   └── ws.py                  # WebSocket /ws
│   ├── migrations/                # Alembic migration files
│   └── tests/
│       ├── test_alert_engine.py
│       ├── test_adapters.py
│       └── test_notifiers.py
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts    # WS connection + reconnect logic
│   │   │   └── useAlerts.ts       # Alert state management
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx
│   │   │   │   └── Sidebar.tsx
│   │   │   ├── dashboard/
│   │   │   │   ├── MetricCard.tsx
│   │   │   │   ├── AlertFeed.tsx
│   │   │   │   ├── AlertItem.tsx
│   │   │   │   ├── SourceStatus.tsx
│   │   │   │   ├── NetworkHealth.tsx
│   │   │   │   └── ActivityChart.tsx
│   │   │   ├── alerts/
│   │   │   │   ├── AlertDetail.tsx
│   │   │   │   └── AlertFilters.tsx
│   │   │   └── settings/
│   │   │       ├── SourceSettings.tsx
│   │   │       ├── RuleBuilder.tsx
│   │   │       └── NotificationSettings.tsx
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── AlertHistory.tsx
│   │   │   ├── Sources.tsx
│   │   │   └── Settings.tsx
│   │   ├── types/
│   │   │   └── index.ts           # Alert, Source, Rule, Stat types
│   │   └── lib/
│   │       └── api.ts             # Axios instance + all API calls
├── .env.example
├── .env                           # Never commit — gitignored
├── requirements.txt
├── docker-compose.yml             # Optional: one-command startup
├── start.bat                      # Windows: starts backend + frontend
└── README.md
```

---

## 5. Database Models

### Alert

```python
class Alert(Base):
    __tablename__ = "alerts"
    
    id            = Column(Integer, primary_key=True)
    source_id     = Column(Integer, ForeignKey("sources.id"))
    severity      = Column(Enum("critical", "warning", "info", "ok"))
    title         = Column(String(255))
    message       = Column(Text)
    raw_payload   = Column(JSON)          # original event, unmodified
    fingerprint   = Column(String(64))    # SHA256 for deduplication
    status        = Column(Enum("active", "acknowledged", "resolved"), default="active")
    first_seen    = Column(DateTime, default=utcnow)
    last_seen     = Column(DateTime, default=utcnow)
    occurrence_count = Column(Integer, default=1)
    notified_telegram = Column(Boolean, default=False)
    notified_email    = Column(Boolean, default=False)
    acknowledged_by   = Column(String(100), nullable=True)
    acknowledged_at   = Column(DateTime, nullable=True)
    resolved_at       = Column(DateTime, nullable=True)
```

### Source

```python
class Source(Base):
    __tablename__ = "sources"
    
    id          = Column(Integer, primary_key=True)
    name        = Column(String(100))          # "pfSense", "NinjaRMM", "PingPlotter"
    slug        = Column(String(50), unique=True)  # "pfsense", "ninjarmm"
    adapter     = Column(String(100))          # adapter class name
    type        = Column(Enum("webhook", "syslog", "poll", "push"))
    enabled     = Column(Boolean, default=True)
    config      = Column(JSON)                 # adapter-specific config
    last_seen   = Column(DateTime, nullable=True)
    status      = Column(Enum("online", "offline", "unknown"), default="unknown")
    created_at  = Column(DateTime, default=utcnow)
```

### Rule

```python
class Rule(Base):
    __tablename__ = "rules"
    
    id           = Column(Integer, primary_key=True)
    name         = Column(String(255))
    source_slug  = Column(String(50), nullable=True)  # null = applies to all
    condition    = Column(JSON)   # {"field": "message", "operator": "contains", "value": "CPU"}
    severity_override = Column(Enum(...), nullable=True)
    notify_telegram = Column(Boolean, default=True)
    notify_email    = Column(Boolean, default=False)
    cooldown_minutes = Column(Integer, default=15)   # suppress repeat alerts
    enabled      = Column(Boolean, default=True)
```

### NotificationLog

```python
class NotificationLog(Base):
    __tablename__ = "notification_logs"
    
    id         = Column(Integer, primary_key=True)
    alert_id   = Column(Integer, ForeignKey("alerts.id"))
    channel    = Column(String(50))   # "telegram", "email"
    recipient  = Column(String(255))
    sent_at    = Column(DateTime, default=utcnow)
    success    = Column(Boolean)
    error      = Column(String(500), nullable=True)
```

---

## 6. API Endpoints

### Alerts

| Method | Path | Description |
|---|---|---|
| GET | `/api/alerts` | List alerts. Query params: `severity`, `source`, `status`, `limit`, `offset` |
| GET | `/api/alerts/{id}` | Get single alert with full raw payload |
| PATCH | `/api/alerts/{id}/acknowledge` | Mark as acknowledged |
| PATCH | `/api/alerts/{id}/resolve` | Mark as resolved |
| DELETE | `/api/alerts/{id}` | Delete alert |
| GET | `/api/alerts/export?format=csv` | Export alert history |

### Sources

| Method | Path | Description |
|---|---|---|
| GET | `/api/sources` | List all sources with current status |
| PATCH | `/api/sources/{id}` | Enable/disable, update config |
| GET | `/api/sources/{id}/test` | Send test alert from this source |

### Ingest (internal — called by adapters)

| Method | Path | Description |
|---|---|---|
| POST | `/api/ingest/ninjarmm` | NinjaRMM webhook receiver |
| POST | `/api/ingest/pingplotter` | PingPlotter webhook receiver |
| POST | `/api/ingest/{slug}` | Generic webhook for future sources |

### Stats

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats/summary` | Counts: critical, warning, info, sources online |
| GET | `/api/stats/timeline?hours=24` | Alert count by hour for chart |
| GET | `/api/stats/sources` | Per-source alert counts and last-seen |

### Rules

| Method | Path | Description |
|---|---|---|
| GET | `/api/rules` | List all rules |
| POST | `/api/rules` | Create rule |
| PATCH | `/api/rules/{id}` | Update rule |
| DELETE | `/api/rules/{id}` | Delete rule |

### WebSocket

| Path | Description |
|---|---|
| `WS /ws` | Client connects. Server pushes: `alert.new`, `alert.updated`, `source.status_change`, `stats.update` |

---

## 7. WebSocket Message Format

All WebSocket messages are JSON with this envelope:

```json
{
  "event": "alert.new",
  "timestamp": "2026-03-28T14:22:00Z",
  "payload": { /* event-specific data */ }
}
```

### Event types

| Event | When | Payload |
|---|---|---|
| `alert.new` | New alert ingested | Full alert object |
| `alert.updated` | Alert acknowledged/resolved | Alert id + new status |
| `source.status_change` | Source goes online/offline | Source id + new status |
| `stats.update` | Every 30s or on change | Summary counts |
| `ping` | Every 30s | `{}` — client responds `pong` |

---

## 8. Integrations (Current)

### 8.1 pfSense — Syslog Adapter

pfSense sends UDP syslog to a local port. The adapter listens on UDP 514 (or configurable) and parses messages.

**Setup in pfSense:** Status → System Logs → Settings → Enable Remote Logging → enter machine IP + port.

**What to capture:**

- Firewall block events (`filterlog`)
- WAN interface up/down
- DHCP lease events (if pfSense handles DHCP)
- VPN tunnel state changes
- Authentication failures
- High CPU/memory alerts from pfSense itself

**Adapter behaviour:**

```
UDP syslog message received
→ parse facility + severity + hostname + message
→ classify: firewall_block | interface_event | auth_failure | dhcp | vpn | system
→ map to internal severity: critical / warning / info
→ deduplicate by fingerprint (source + event_type + target_ip within 5 min window)
→ emit to alert_engine
```

**Example mappings:**

| pfSense event | Internal severity |
|---|---|
| WAN interface down | critical |
| >50 blocked IPs/min from same subnet | critical |
| VPN tunnel down | critical |
| Auth failure repeated (>5 in 1 min) | warning |
| Single firewall block | info (suppressed by default) |
| DHCP lease issued | info |

### 8.2 NinjaRMM — Webhook Adapter

NinjaRMM supports outbound webhooks for alert conditions. Configure in NinjaRMM: Administration → Notifications → Webhook → point to `http://localhost:8000/api/ingest/ninjarmm`.

**What to capture:**

- Device offline
- Disk space > threshold (configurable, default 85%)
- CPU sustained > threshold (configurable, default 80% for 10 min)
- RAM usage > threshold (default 90%)
- Antivirus out of date / disabled
- Windows Update failures
- Service stopped (configurable list)
- Patch compliance failures
- Script execution failures

**Webhook payload (NinjaRMM format):**

```json
{
  "eventType": "DEVICE_OFFLINE",
  "deviceId": 12345,
  "deviceName": "PC-ACCOUNTS",
  "organizationName": "ST&R Limited",
  "timestamp": "2026-03-28T14:00:00Z",
  "details": { ... }
}
```

**Adapter behaviour:**

```
POST /api/ingest/ninjarmm received
→ validate payload structure
→ map eventType to internal alert fields
→ extract device name, org, details
→ assign severity based on eventType
→ emit to alert_engine
```

### 8.3 PingPlotter — Webhook Adapter

PingPlotter Pro supports alert webhooks. Configure target URL as `http://localhost:8000/api/ingest/pingplotter`.

**What to capture:**

- Packet loss above threshold (default: >1% sustained 5 min)
- Latency spike above threshold (default: >100ms to gateway, >200ms to 8.8.8.8)
- Target unreachable
- Route change detected

**Adapter behaviour:**

```
POST /api/ingest/pingplotter received
→ parse target IP, packet loss %, average latency, hop data
→ classify: packet_loss | latency_spike | unreachable | route_change
→ severity: unreachable=critical, packet_loss>5%=critical, >1%=warning, latency=warning/info
→ deduplicate: same target within cooldown window
→ emit to alert_engine
```

---

## 9. Alert Engine (Core)

This is the central processor all adapters emit to.

```python
async def process_alert(raw: RawAlert) -> Alert:
    # 1. Normalise into standard Alert shape
    alert = normalise(raw)
    
    # 2. Run rule engine — may override severity or suppress
    alert = await rule_engine.evaluate(alert)
    if alert.suppressed:
        return
    
    # 3. Deduplicate — fingerprint = sha256(source+type+key_fields)
    existing = await db.get_by_fingerprint(alert.fingerprint, within_minutes=30)
    if existing:
        existing.occurrence_count += 1
        existing.last_seen = utcnow()
        await db.save(existing)
        await ws_manager.broadcast(AlertUpdatedEvent(existing))
        return existing
    
    # 4. Persist
    await db.save(alert)
    
    # 5. Broadcast to dashboard via WebSocket
    await ws_manager.broadcast(AlertNewEvent(alert))
    
    # 6. Notify
    await notification_router.dispatch(alert)
    
    return alert
```

---

## 10. Notification Layer

### Telegram

- Bot created via BotFather
- Two recipients: Alex chat_id + Campbell chat_id (both configurable in .env)
- Format:

```
🔴 CRITICAL — NinjaRMM
SRV01 — CPU sustained above 80% for 15 min

🕐 14:22:00 UTC  |  ST&R Dashboard
```

- Severity emoji: 🔴 Critical · 🟡 Warning · 🔵 Info · 🟢 Resolved
- On resolution: sends follow-up "✅ RESOLVED — SRV01 CPU back to normal"
- Cooldown per alert type: configurable per rule (default 15 min)

### Email

- SMTP (Gmail app password or any SMTP)
- Critical alerts only by default (configurable per rule)
- HTML email with alert details
- Recipient list configurable in .env

---

## 11. Frontend — Dashboard UI

### Design System

- **Theme:** Dark and light mode support via CSS variables
- **Font:** System monospace for metrics, sans-serif for UI text
- **Palette:** Minimal — black/white/gray base, semantic colours only (red=critical, amber=warning, blue=info, green=ok/resolved)
- **Layout:** Fixed sidebar (sources + stats) + main content area
- **Density:** Compact — maximum information density without clutter
- **No decorative elements** — every pixel carries information

### Pages

#### Dashboard (default)

- Top bar: system name · live indicator · clock · connection status
- Metric row: Critical count · Warning count · Sources online · Uptime today
- Main: Alert feed (filterable, paginated)
- Right sidebar: Source status list · Network health bars · Notification toggles
- Alert feed auto-updates via WebSocket — no manual refresh needed

#### Alert History

- Full searchable table of all historical alerts
- Filters: date range · severity · source · status
- Click row → alert detail modal (full raw payload visible)
- Export to CSV

#### Sources

- Card per source: name · type · status · last seen · alert count today
- Toggle enable/disable
- View recent alerts from this source
- Test button: sends synthetic test alert

#### Settings

- Notification configuration: Telegram token, chat IDs, SMTP settings
- Rule builder: create/edit/delete suppression and routing rules
- Alert thresholds: per-source default thresholds
- Maintenance mode: suppress all notifications for N minutes

### Alert Feed Item

```
┌─ [RED BAR] ──────────────────────────────────────────┐
│  NINJARMM                              [CRITICAL]     │
│  SRV01 — CPU sustained above 80% for 15 min          │
│  2 min ago · 3 occurrences                            │
│                              [Acknowledge] [Details]  │
└───────────────────────────────────────────────────────┘
```

- Left coloured bar = severity indicator
- Badge top-right = severity label
- Occurrence count shown if > 1
- Acknowledge button → marks alert, removes from "active" count
- Details → slide-over panel with full raw payload

---

## 12. Rule Engine

Rules allow custom alert routing and suppression without code changes.

### Rule structure

```json
{
  "name": "Suppress single firewall blocks",
  "source": "pfsense",
  "condition": {
    "field": "event_type",
    "operator": "equals",
    "value": "firewall_block"
  },
  "action": "suppress",
  "cooldown_minutes": 0
}
```

```json
{
  "name": "Critical: WAN down → email Alex immediately",
  "source": "pfsense",
  "condition": {
    "field": "event_type",
    "operator": "equals",
    "value": "interface_down"
  },
  "severity_override": "critical",
  "notify_telegram": true,
  "notify_email": true,
  "cooldown_minutes": 60
}
```

### Supported operators

`equals` · `not_equals` · `contains` · `not_contains` · `greater_than` · `less_than` · `matches_regex`

### Supported actions

`suppress` · `notify` · `severity_override` · `route_to_telegram_only` · `route_to_email_only`

---

## 13. Future Integration — Extension Guide

Every new integration = one new adapter file. No changes to core.

### How to add a new source

1. Create `backend/adapters/my_source_adapter.py`
2. Inherit from `BaseAdapter`
3. Implement `parse(raw_payload) -> RawAlert`
4. Register in `backend/adapters/__init__.py`
5. Add source record to DB via admin UI or seed script
6. Done

### Planned future adapters

#### DNS / DHCP Server Monitoring

```
Events to capture:
- DNS resolution failures (NXDOMAIN spikes)
- DNS query volume spikes (potential exfil/attack)
- DHCP scope exhaustion (>90% of pool leased)
- DHCP lease for unknown MAC address
- DNS server unreachable

Integration method: syslog (Windows DNS) or API polling
```

#### Dialler System

```
Events to capture:
- Dialler service down / unreachable
- Call queue overflow
- Agent login failures
- Recording service failure
- SIP trunk registration failure
- Concurrent call limit reached

Integration method: webhook from dialler or API polling
Dialler-specific fields: queue_name, agent_id, trunk_id, call_count
```

#### CRM System

```
Events to capture:
- CRM service unavailable
- Database connection failures
- Sync job failures
- API rate limit breached
- Scheduled report failures

Integration method: webhook or health endpoint polling
```

#### Windows DNS / Active Directory

```
Events to capture:
- AD replication failures
- Kerberos authentication failures (spike)
- Account lockouts
- Group Policy update failures
- Domain controller unreachable

Integration method: Windows Event Log forwarding via NinjaRMM script or direct WMI polling
```

#### Network Switch Monitoring (UniFi)

```
Events to capture:
- Switch/AP offline
- Port flapping
- PoE budget exceeded
- VLAN misconfiguration detected
- Uplink failure

Integration method: UniFi Controller API polling or webhook
Config: controller_url, api_key
```

---

## 14. Configuration (.env)

```env
# Application
APP_NAME=ST&R Alert Dashboard
APP_HOST=0.0.0.0
APP_PORT=8000
DEBUG=false

# Database
DATABASE_URL=sqlite:///./alerts.db
# For PostgreSQL: postgresql://user:pass@localhost/str_alerts

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_IDS=111111111,222222222   # Alex,Campbell

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASSWORD=your_app_password
EMAIL_FROM=alerts@str-limited.com
EMAIL_TO=alex@str-limited.com,campbell@str-limited.com

# pfSense syslog
PFSENSE_SYSLOG_PORT=514
PFSENSE_SYSLOG_ENABLED=true

# NinjaRMM
NINJARMM_WEBHOOK_SECRET=optional_secret_for_validation

# PingPlotter
PINGPLOTTER_WEBHOOK_SECRET=optional_secret

# Alert engine
DEFAULT_DEDUP_WINDOW_MINUTES=30
DEFAULT_COOLDOWN_MINUTES=15
CRITICAL_COOLDOWN_MINUTES=5

# Frontend
VITE_API_URL=http://localhost:8000
VITE_WS_URL=ws://localhost:8000/ws
```

---

## 15. Build Phases

### Phase 1 — Core engine + API (no integrations yet)

**Goal:** Backend running, DB seeded, REST API working, WebSocket broadcasting mock alerts.

Tasks:
- FastAPI project scaffold with all routers registered
- SQLAlchemy models + Alembic migrations
- Alert engine skeleton (accepts RawAlert, persists, broadcasts)
- WebSocket manager
- Mock data seeder (5 realistic alerts across 3 sources)
- `GET /api/alerts` + `GET /api/stats/summary` working

**Done when:** `curl http://localhost:8000/api/alerts` returns seeded alerts.

---

### Phase 2 — React Dashboard

**Goal:** Live dashboard connected to backend, WebSocket working.

Tasks:
- Vite + React + Tailwind setup
- Dashboard page with MetricCard, AlertFeed, SourceStatus components
- `useWebSocket` hook — connects, auto-reconnects on drop
- `useAlerts` hook — initial HTTP fetch + WS live updates merged
- Alert filtering (severity, source)
- Acknowledge action (PATCH + optimistic UI update)
- ActivityChart (alert count last 24h via `/api/stats/timeline`)
- Settings page skeleton

**Done when:** Dashboard shows live alerts, new alerts appear without refresh, acknowledge works.

---

### Phase 3 — Telegram + Email Notifications

**Goal:** Alerts reach Telegram and Email.

Tasks:
- Telegram notifier: bot setup, message formatting, severity emojis
- Email notifier: SMTP, HTML template, critical-only default
- NotificationLog model + persistence
- Resolution follow-up messages ("✅ RESOLVED")
- Cooldown enforcement per rule
- Test notification button in Settings UI

**Done when:** Post a test alert → Telegram message arrives within 3 seconds.

---

### Phase 4 — pfSense Syslog Adapter

**Goal:** Real pfSense events flowing in.

Tasks:
- UDP syslog listener (asyncio datagram protocol)
- pfSense log format parser (filterlog, dhcpd, openvpn, php messages)
- Event classifier → internal alert type mapping
- Severity mapping table
- Single-block deduplication (same source IP blocked 10x in 1 min → 1 alert)
- Source record auto-created in DB

**Done when:** Block a device in pfSense → alert appears on dashboard within 5 seconds.

---

### Phase 5 — NinjaRMM Webhook Adapter

**Goal:** NinjaRMM device alerts flowing in.

Tasks:
- POST `/api/ingest/ninjarmm` endpoint
- Payload validation + signature verification (if secret configured)
- eventType → alert type mapping
- Device metadata extraction (name, org, details)
- Source status heartbeat (NinjaRMM pings = source is online)

**Done when:** Take a test device offline in NinjaRMM → alert on dashboard + Telegram.

---

### Phase 6 — PingPlotter Webhook Adapter

**Goal:** Network quality alerts flowing in.

Tasks:
- POST `/api/ingest/pingplotter` endpoint
- Parse target, packet_loss, latency, hop_count from payload
- Threshold evaluation (configurable per target)
- Alert on threshold breach, resolve when back to normal

**Done when:** Simulate packet loss in PingPlotter → alert fires → clears when resolved.

---

### Phase 7 — Rule Engine UI + Polish

**Goal:** Alex and Campbell can configure alert rules without touching code.

Tasks:
- Rule Builder UI in Settings page
- Create / edit / delete rules with condition builder
- Per-source threshold overrides
- Maintenance mode (suppress all for N min)
- Alert History page with search + CSV export
- Sources page with per-source stats
- Dark/light mode toggle

**Done when:** Create a rule to suppress single firewall blocks → pfSense info alerts stop appearing.

---

### Phase 8 — Hardening + Production Prep

**Goal:** Stable enough to leave running 24/7.

Tasks:
- Structured logging (JSON) to rotating log files
- Health endpoint: `GET /health` → `{status: ok, db: ok, sources_online: 3}`
- Automatic source offline detection (no heartbeat in N minutes → source=offline alert)
- DB backup script (SQLite → dated copy daily)
- `start.bat` for Windows one-click startup
- `docker-compose.yml` for optional containerised deployment
- README with full setup guide

---

## 16. Alert Severity Reference

| Severity | Colour | Example | Default actions |
|---|---|---|---|
| critical | Red 🔴 | WAN down, device offline, CPU >90% | Telegram immediately · Email · Dashboard |
| warning | Amber 🟡 | Packet loss >1%, disk >85%, AV outdated | Telegram (with cooldown) · Dashboard |
| info | Blue 🔵 | Single FW block, DHCP lease, service restart | Dashboard only |
| ok / resolved | Green 🟢 | Alert condition cleared | Telegram follow-up · Dashboard update |

---

## 17. Deduplication Strategy

Two alerts are considered duplicates if:
- Same `source_id`
- Same `event_type`
- Same `fingerprint_key` (source-specific: IP address, device name, target host, etc.)
- `first_seen` is within the dedup window (default 30 min, configurable per rule)

On duplicate: increment `occurrence_count`, update `last_seen`, push `alert.updated` WS event. Do NOT send another notification (cooldown applies separately).

---

## 18. Windows Startup (start.bat)

```bat
@echo off
cd /d %~dp0

echo Starting ST^&R Alert Dashboard...

start "Backend" cmd /k "cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

timeout /t 3 /nobreak >nul

start "Frontend" cmd /k "cd frontend && npm run dev"

timeout /t 3 /nobreak >nul

start "" "http://localhost:5173"

echo Dashboard started. Close the terminal windows to stop.
```

---

## 19. Cursor Instructions

When building this project in Cursor, follow these principles:

1. **Build phase by phase** — complete and test each phase before starting the next
2. **Never skip the base classes** — `BaseAdapter` and `BaseNotifier` must exist before any implementation
3. **Test with mock data first** — Phase 1 must work with seeded data before any real integrations
4. **Keep adapters isolated** — an adapter crash must never take down the core engine (wrap in try/except, log, continue)
5. **All config via .env** — no hardcoded values anywhere
6. **WebSocket first** — the dashboard should update in real time; polling is not acceptable
7. **Fingerprint everything** — deduplication is critical; a WAN-down event should never fire 50 Telegram messages
8. **Log everything** — every ingested event, every notification sent, every error must be in the log file

### Suggested first prompt to Cursor

> "Build Phase 1 of the ST&R Alert Dashboard as specified in the PRD. Create the FastAPI backend with SQLAlchemy models, Alembic migrations, all router files (alerts, sources, stats, ingest, ws), the alert engine, websocket manager, and a seed script with 6 realistic mock alerts across 3 sources (pfSense, NinjaRMM, PingPlotter). Use SQLite. Do not implement any adapters yet — just the core engine that accepts a RawAlert dict and processes it. Start uvicorn on port 8000."

---

*Document version 1.0 — Aleksandr Migulia — March 2026*
