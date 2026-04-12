# STAR Alert System — Architectural Reference

## Monitoring Scope (read before any change)

Monitoring responsibilities are split by network location:

**COLLECTOR** (on-premise, office LAN) — monitors only what it can
always see regardless of internet state:
  - UniFi switch ports (errors, traffic, status)
  - LAN devices: 10.2.1.253, 10.2.1.5, 10.2.1.3, 10.2.2.100
  - pfSense LAN interface
  - NetFlow data

**RAILWAY BACKEND** — monitors only external reachability:
  - 1.1.1.1, 8.8.8.8 (external DNS)
  - 164.39.40.113 (WAN1 gateway)
  - 109.111.195.221 (WAN2 gateway)

During internet outage:
  - Railway detects WAN loss → creates ONE global incident
  - Collector buffers LAN data locally (SQLite) → backfills
    to Supabase when internet restores
  - Device investigation never shows WAN diagnosis — that is
    always a global incident

---

## Hard Constraints (NEVER violate)

- NEVER run `alembic upgrade head` in Railway startCommand
- NEVER use Supabase client SDK — SQLAlchemy/asyncpg only
- NEVER hardcode hex colors — CSS vars only
- NEVER change WebSocket event names
- NEVER change existing API response shapes (add fields, never remove)
- Dark theme only
- API calls via `lib/api.ts` only — never `fetch()` in components

---

## Data Integrity Rules

### Port metrics
- ALWAYS use `_delta` columns for display — NEVER raw cumulative `rx_errors` / `rx_bytes`
- Columns: `rx_errors_delta`, `tx_errors_delta`, `rx_bytes_delta`, `tx_bytes_delta`, `is_counter_reset`
- Counter reset: if `delta < 0`, set `delta=0` and `is_counter_reset=TRUE`, log event
- Sanity cap: if `rx_bytes_delta > 10_000_000_000` in one 60s cycle, discard row as invalid
- Timestamp validation: reject any metric row where `|time - NOW()| > 300s`, return HTTP 400

### Error display
- Always show errors as `/hr` (SUM of delta column over last 1h)
- Color: 0 = dim, 1–10 = amber, >10 = red
- Tooltip: `"N errors in last hour · Last error: [datetime]"`
- Never show raw cumulative counter values in the UI

---

## Incident Rules

### Scope assignment
- `WAN_ISP`, `WAN_LINE`, `WAN1_DOWN`, `WAN2_DOWN`, `FULL_OUTAGE`, `ALL_INTERNAL`
  → always `incident_scope='global'`
- `PFSENSE`, `DC_PRIMARY`, `DC_SECONDARY`, `VLAN2_DC`
  → `incident_scope='device'`, always set `affected_ip`

### Deduplication
- Before creating any incident: check for existing open incident with same `root_cause`
- If one exists: update `affected_targets`, do NOT insert a duplicate row
- Global incidents: one open row per `root_cause` at all times

### Thresholds
- Outage / WAN incident: `>50%` packet loss for **3 consecutive cycles** on 2+ external targets
- Single packet loss or <3 consecutive cycles: log only, no incident, no alert
- Auto-resolve global: all affected targets must recover for **3 consecutive cycles`**
  → then set `resolved_at=NOW()` and send one Telegram "resolved" message

---

## Collector Architecture

### Buffer flow
1. Every collector service calls `buffer.write_local(endpoint, payload)` first
2. `buffer.flush_to_backend()` runs every 60s — POSTs buffered rows to Railway backend
3. On success: delete rows from SQLite; on failure: increment `attempts`, retry next cycle
4. Backfill: timestamps are the original collection time, not the send time
5. Max retention: 24 hours; max size: 50,000 rows (drop oldest if exceeded)

### Backend receiver
- `POST /api/collector/metrics` — receives bulk payload from collector
- `POST /api/collector/heartbeat` — liveness signal, updates `collector_heartbeat`
- Backend writes all received data to Supabase via SQLAlchemy

### fping targets
- Collector pings LAN only: `10.2.1.253`, `10.2.1.5`, `10.2.1.3`, `10.2.2.100`
- Railway backend pings WAN only: `1.1.1.1`, `8.8.8.8`, `164.39.40.113`, `109.111.195.221`
- Never overlap — adding a WAN target to the collector is wrong

---

## UI Rules

### Global incidents
- Never show a per-device WAN/ISP diagnosis — WAN issues are always global incidents
- `NetworkStatusBanners` (in AppShell) shows a red banner on all `/network/*` pages
  when any `incident_scope='global'` incident is open
- Banners are dismissible per session (sessionStorage)

### Data freshness
- Poll `collector_heartbeat.last_seen` via `/api/network/overview`
- > 5 min stale → amber banner: "Collector offline — data may be stale"
- > 15 min stale → red banner (same text, red colour)
- Overview page collector banner also upgrades to red at >15 min

### Investigation page
- Bytes / traffic: always from `rx_bytes_delta` / `tx_bytes_delta` sums
- Gateway/WAN loss: not shown per-device; replaced by global incident timeline
- No data state: show "No data available for this device in selected window"
  when bytes=0 and timeline is empty — never show "0 B sent / 0 B received" as real data

### api.ts
- All network API functions live in `frontend/src/lib/api.ts`
- Components import from `api.ts`; they never call `fetch()` or `axios` directly
- Exported functions for network module: `getNetworkOverview`, `getNetworkIncidents`,
  `getOpenNetworkIncidents`, `resolveIncident`, and others — see api.ts for full list

---

## Database Schema (key tables)

| Table | Purpose |
|---|---|
| `switch_port_metrics` | Per-port readings with `_delta` columns (TimescaleDB hypertable) |
| `latency_metrics` | Ping results per target (TimescaleDB hypertable) |
| `network_flows` | NetFlow records (TimescaleDB hypertable) |
| `device_registry` | Known devices with `last_error_at`, `last_error_desc` |
| `network_incidents` | Incidents with `incident_scope`, `affected_component` |
| `port_error_events` | One row per error event (for history / timeline) |
| `network_events` | Timeline feed (offline, online, latency spike, incident) |
| `collector_heartbeat` | Liveness signal from on-premise collector |

Migrations: `migrations/versions/` — Alembic, applied manually (never in startCommand).
