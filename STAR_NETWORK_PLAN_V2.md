# STAR Network Monitor — План разработки v2
> Модуль сетевого мониторинга внутри существующего STAR проекта  
> Railway (backend + frontend) | Supabase (PostgreSQL) | GitHub | Коллектор: Docker (переносимый)

---

## Инфраструктура

```
GitHub repo
    ↓ auto-deploy
Railway (FastAPI + React)
    ↓ reads/writes
Supabase (PostgreSQL + TimescaleDB extension)
    ↑ pushes data
Коллектор (Docker Compose — любая машина внутри сети)
    ← pfSense NetFlow UDP
    ← UniFi API polling
    → fping ICMP targets
```

Коллектор — единственное что живёт внутри сети. Всё остальное в облаке как было.

---

## Архитектурное решение: коллектор переносимый

Вся конфигурация в одном `.env` файле. Коллектор можно запустить на:
- Твоём ноутбуке в офисе (для разработки и теста)
- Raspberry Pi 4 (постоянное решение, ~£55)
- VM на любом сервере внутри сети
- Любом Windows/Mac/Linux компе с Docker

Переезд с одной машины на другую = скопировать `.env` + `docker compose up`. Всё.

---

## Разработка дома vs в офисе

| Дома | В офисе |
|---|---|
| Пишешь код, Claude Code промпты | Запускаешь `docker compose up` |
| Моковые данные для UI | Реальные данные с pfSense и UniFi |
| Тестируешь API эндпоинты | Видишь живые порты, устройства, трафик |
| Пушишь в GitHub | Railway деплоит автоматически |

Дашборд всегда доступен на Railway. Просто когда коллектор не запущен — данные не текут.

---

## Фаза 0 — Подготовка Supabase (День 1, ~1 час)

### Цель
Включить TimescaleDB в Supabase, создать все таблицы.

### Промпт 1 — Supabase schema

```
Enable TimescaleDB extension and create network monitoring schema in our Supabase database.

Create a new migration file at /supabase/migrations/[timestamp]_network_schema.sql

First enable the extension:
CREATE EXTENSION IF NOT EXISTS timescaledb;

Then create these tables:

1. network_flows
   - time TIMESTAMPTZ NOT NULL
   - src_ip INET
   - dst_ip INET  
   - src_port INTEGER
   - dst_port INTEGER
   - protocol SMALLINT
   - bytes BIGINT
   - packets INTEGER
   - device_name TEXT (resolved from device_registry)
   - direction TEXT ('inbound'|'outbound'|'internal')

2. switch_port_metrics
   - time TIMESTAMPTZ NOT NULL
   - switch_id TEXT
   - switch_name TEXT
   - port_id TEXT
   - port_name TEXT
   - device_name TEXT
   - device_ip INET
   - rx_bytes BIGINT
   - tx_bytes BIGINT
   - rx_errors BIGINT
   - tx_errors BIGINT
   - rx_packets BIGINT
   - tx_packets BIGINT
   - poe_watts FLOAT
   - is_uplink BOOLEAN DEFAULT false

3. latency_metrics
   - time TIMESTAMPTZ NOT NULL
   - target_name TEXT
   - target_ip INET
   - target_type TEXT ('gateway'|'wan'|'dns'|'internal')
   - rtt_ms FLOAT
   - packet_loss_pct FLOAT

4. device_registry
   - ip INET PRIMARY KEY
   - mac TEXT
   - hostname TEXT
   - switch_id TEXT
   - port_id TEXT
   - last_seen TIMESTAMPTZ
   - first_seen TIMESTAMPTZ
   - is_online BOOLEAN DEFAULT false
   - device_type TEXT ('workstation'|'server'|'printer'|'ap'|'unknown')
   - notes TEXT

5. network_incidents
   - id UUID PRIMARY KEY DEFAULT gen_random_uuid()
   - started_at TIMESTAMPTZ NOT NULL DEFAULT now()
   - resolved_at TIMESTAMPTZ
   - severity TEXT ('low'|'medium'|'high'|'critical')
   - category TEXT ('wan_issue'|'interface_error'|'device_offline'|'internal_latency'|'traffic_anomaly'|'firewall_drop')
   - affected_ip INET
   - affected_switch TEXT
   - affected_port TEXT
   - title TEXT NOT NULL
   - description TEXT
   - evidence JSONB
   - root_cause TEXT
   - resolution_notes TEXT
   - auto_detected BOOLEAN DEFAULT true

6. collector_heartbeat
   - collector_id TEXT PRIMARY KEY
   - last_seen TIMESTAMPTZ
   - version TEXT
   - sources JSONB (which data sources are active)

Convert network_flows, switch_port_metrics, latency_metrics to TimescaleDB hypertables.

Add retention policies:
- network_flows: 7 days
- switch_port_metrics: 90 days  
- latency_metrics: 365 days

Add indexes:
- network_flows: src_ip, dst_ip, time DESC
- switch_port_metrics: (switch_id, port_id, time DESC)
- latency_metrics: (target_name, time DESC)
- device_registry: mac, hostname

After creating migration, also create /supabase/seed_network.sql with:
- 5 fake devices in device_registry
- 50 rows of fake switch_port_metrics (last 2 hours)
- 100 rows of fake latency_metrics (last 2 hours, targets: gateway/8.8.8.8/1.1.1.1)
- 200 rows of fake network_flows
So we can develop UI without the collector running.
```

### Что проверить после
Открой Supabase → Table Editor → видишь 6 новых таблиц.
Открой SQL Editor:
```sql
SELECT * FROM timescaledb_information.hypertables;
-- Должно показать 3 строки
SELECT COUNT(*) FROM switch_port_metrics;
-- Должно показать 50 (seed данные)
```

---

## Фаза 1 — Коллектор (Дни 2-4, ~5 часов)

### Цель
Docker Compose репозиторий который запускается одной командой в офисе.

### Промпт 2 — Docker Compose коллектор

```
Create a new directory /collector in our STAR monorepo (or as a separate folder).

This is a Docker Compose setup that collects network data and pushes to Supabase.
It runs on any machine inside the office network.

Create this structure:
collector/
├── docker-compose.yml
├── .env.example
├── README.md
├── goflow2/
│   └── config.yaml
├── telegraf/
│   └── telegraf.conf
├── services/
│   ├── fping_collector/
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── main.py
│   └── health_reporter/
│       ├── Dockerfile
│       ├── requirements.txt
│       └── main.py

Requirements:

1. goflow2 service
   - Docker image: netsampler/goflow2:latest
   - Listen on UDP 9995 for NetFlow v5/v9/IPFIX
   - Output: write to Supabase network_flows table via postgres driver
   - Map: src_addr→src_ip, dst_addr→dst_ip, src_port, dst_port, proto→protocol, bytes, packets

2. telegraf service
   - Docker image: telegraf:latest
   - inputs.unifi: poll UniFi Controller every 60s
     Collect: port stats (rx_bytes, tx_bytes, rx_errors, tx_errors, poe_watts)
     Collect: sta (connected clients: ip, mac, hostname, signal, ap)
   - outputs.postgresql: write to Supabase switch_port_metrics and device_registry
   - Also poll: inputs.ping for gateway and 8.8.8.8 every 30s
     Output to latency_metrics

3. fping_collector service (Python)
   - Read targets from env: GATEWAY_IP, ISP_GATEWAY_IP, plus all IPs from device_registry
   - Run fping every 10 seconds
   - Parse: rtt_ms, packet_loss_pct per target
   - Write to latency_metrics via supabase-py
   - Categorise targets: gateway→'gateway', 8.8.8.8→'wan', internal IPs→'internal'

4. health_reporter service (Python)
   - Every 60 seconds write to collector_heartbeat table:
     {collector_id: from env, last_seen: now(), sources: {goflow2: bool, telegraf: bool, fping: bool}}
   - Check each service is writing data (query last row timestamp)
   - If any source silent >5min: log warning

.env.example with all variables and comments:
SUPABASE_URL=https://xxxx.supabase.co         # Your Supabase project URL
SUPABASE_KEY=your_service_role_key             # Settings → API → service_role key (NOT anon key)
UNIFI_URL=https://192.168.1.1                  # Your UniFi Controller IP
UNIFI_PORT=8443                                # Default UniFi port
UNIFI_USER=star-monitor                        # Read-only account you create in UniFi
UNIFI_PASS=your_password
UNIFI_SITE=default                             # UniFi site name (usually 'default')
UNIFI_VERIFY_SSL=false                         # UniFi uses self-signed cert
GATEWAY_IP=192.168.1.1                         # Your pfSense LAN IP
ISP_GATEWAY_IP=                                # First hop from ISP (run: tracert 8.8.8.8)
NETFLOW_PORT=9995                              # Must match pfSense softflowd config
COLLECTOR_ID=office-main                       # Name for this collector instance

README.md must include:
- Prerequisites (Docker Desktop installed)
- Quick start: 3 commands to get running
- How to configure pfSense NetFlow (exact steps with menu paths)
- How to create UniFi read-only account (exact steps)
- How to find ISP gateway IP
- Troubleshooting: common errors and fixes
- How to move collector to another machine (copy .env, docker compose up)
```

### Промпт 3 — .env и проверка

```
In the collector README.md, add a verification section with these exact commands 
the user runs after docker compose up to confirm each service is working:

1. Check all containers running:
   docker compose ps
   (all should show 'running')

2. Check goflow2 receiving NetFlow:
   docker compose logs goflow2 --tail=20
   (should show flow records after enabling softflowd on pfSense)

3. Check telegraf polling UniFi:
   docker compose logs telegraf --tail=20
   (should show successful API responses)

4. Check data in Supabase (SQL to run in Supabase SQL editor):
   SELECT COUNT(*), MAX(time) FROM switch_port_metrics;
   SELECT COUNT(*), MAX(time) FROM latency_metrics;
   SELECT * FROM device_registry LIMIT 10;
   SELECT * FROM collector_heartbeat;

5. Check collector health endpoint:
   curl http://localhost:8080/health
   (returns JSON with status of each data source)
```

---

## Фаза 2 — Backend API (Дни 5-7, ~5 часов)

### Цель
Новые эндпоинты в существующем STAR FastAPI для всех сетевых данных.

### Промпт 4 — FastAPI роутер

```
Add a new network monitoring router to our existing STAR FastAPI application.

Create app/routers/network.py and register it at prefix /api/network.
Use our existing Supabase client and auth patterns from the rest of the app.

Implement these endpoints:

GET /api/network/overview
Returns:
{
  wan: {status: 'healthy'|'degraded'|'down', latency_ms: float, packet_loss_pct: float},
  internal: {status: 'healthy'|'degraded'|'down', active_devices: int, error_ports: int},
  collector: {online: bool, last_seen: datetime, sources: {...}},
  open_incidents: int,
  bytes_last_hour: int,
  health_score: int  // 0-100, calculated from all metrics
}
Query: latest latency_metrics for wan targets, COUNT online devices, COUNT ports with errors in last 5min

GET /api/network/latency?period=1h&targets=all
period options: 15m, 1h, 6h, 24h, 7d
Returns: {
  targets: ['gateway', '8.8.8.8', '1.1.1.1'],
  series: [{time, gateway_rtt, gateway_loss, wan_rtt, wan_loss, ...}]
}
Use TimescaleDB time_bucket() for aggregation (bucket size depends on period)

GET /api/network/ports?switch_id=optional&status=all|errors|high_traffic|offline
Returns array of port objects: {
  switch_id, switch_name, port_id, port_name,
  device_name, device_ip,
  rx_bytes_rate, tx_bytes_rate,  // bytes/sec last 5min
  rx_errors_1h, tx_errors_1h,
  status: 'healthy'|'warning'|'error'|'empty'|'uplink',
  last_error_time
}

GET /api/network/flows?period=1h&ip=optional&limit=50
Returns top flows by bytes: {
  src_ip, src_hostname, dst_ip, dst_hostname,
  protocol_name,  // 'HTTPS', 'DNS', 'SMB' etc from port number
  bytes, packets,
  direction: 'inbound'|'outbound'|'internal',
  percent_of_total
}

GET /api/network/device/{ip}
Returns full device profile: {
  ip, mac, hostname, switch_id, port_id, device_type, notes, is_online, last_seen,
  current_port_status: {...},
  flows_last_hour: [...],
  port_errors_24h: [...time series],
  latency_to_gateway_24h: [...time series],
  incidents: [...]
}

GET /api/network/investigate?ip=&start=ISO&end=ISO
Returns complete diagnostic: {
  device: {...},
  timeline: [{time, event_type, severity, description}],  // all events merged
  metrics: {
    port_rx_errors: int,
    port_tx_errors: int,
    avg_packet_loss_gateway_pct: float,
    avg_packet_loss_wan_pct: float,
    avg_rtt_gateway_ms: float,
    bytes_sent: int,
    bytes_received: int,
    top_destinations: [...]
  },
  hypothesis: {
    likely_cause: 'cable_or_nic'|'wan_issue'|'firewall_drop'|'server_side'|'wifi_signal'|'healthy'|'unknown',
    confidence: 'high'|'medium'|'low',
    evidence: [string],
    recommended_action: string
  }
}

Hypothesis logic (implement exactly):
- port rx_errors > 50 AND gateway loss > 2% → cable_or_nic, high confidence
- port rx_errors > 50 AND gateway loss < 1% → cable_or_nic, medium confidence  
- gateway loss < 1% AND wan loss > 5% → wan_issue, high confidence
- gateway loss > 5% AND wan loss > 5% → wan_issue, high (ISP/upstream)
- all loss < 1% AND all errors 0 AND Teams/Zoom flows present → server_side, medium
- device is wifi AND signal_strength < -75 → wifi_signal, high
- all metrics normal → healthy, high
- else → unknown, low

GET /api/network/incidents?status=open|resolved|all&limit=50
POST /api/network/incidents/{id}/resolve  body: {root_cause, resolution_notes}
GET /api/network/devices  // list all known devices from device_registry
PATCH /api/network/devices/{ip}  body: {notes, device_type}  // update device notes

All endpoints return 200 with data or appropriate error.
If no collector data exists, return empty arrays (not errors) so UI can show empty state gracefully.
```

### Промпт 5 — Alert worker

```
Add a background alert worker to STAR FastAPI that runs every 60 seconds.
Use APScheduler with asyncio or a simple asyncio task started in app startup.

Check these conditions and create incidents + send Telegram alerts:

1. WAN packet loss:
   Query: avg packet_loss_pct for target_type='wan' in last 3 minutes
   Threshold: > 5%
   Incident: severity=high, category=wan_issue
   Telegram: "🔴 WAN packet loss: {X}% — Internal network OK. Check ISP."
   Include link: {STAR_URL}/network/investigate

2. Interface errors:
   Query: SUM rx_errors for each port in last 5 minutes
   Threshold: > 50 errors
   Incident: severity=medium, category=interface_error, affected_port
   Telegram: "⚠️ Interface errors on {switch}/{port} ({device_name}). Possible cable or NIC issue."

3. Device offline:
   Query: devices where last_seen < now() - 5min AND is_online = true
   Update device_registry set is_online = false
   Incident: severity=low, category=device_offline
   Telegram: "📴 {hostname} ({ip}) went offline."

4. Internal latency spike:
   Query: avg rtt_ms for target_type='gateway' in last 3 minutes  
   Threshold: > 50ms
   Incident: severity=high, category=internal_latency
   Telegram: "🔴 Internal latency: {X}ms to gateway. Check core switch load."

5. Collector offline:
   Query: collector_heartbeat where last_seen < now() - 5min
   Telegram: "⚠️ STAR Collector went offline. No network data being collected."

6. Traffic anomaly:
   Query: bytes per device last 15min vs avg bytes same time last 7 days
   Threshold: current > 5x average
   Incident: severity=low, category=traffic_anomaly
   Telegram: "📊 Unusual traffic: {hostname} using {X}x normal data ({bytes} in 15min)."

Deduplication: before creating incident, check if open incident exists for same category+affected_ip.
If yes: skip (don't spam). If resolved > 30min ago: create new one.

Auto-resolve: on each check, if condition cleared → set resolved_at = now() on open incident.
Send Telegram: "✅ Resolved: {title}"

Use existing STAR Telegram bot token and chat ID from environment variables.
```

---

## Фаза 3 — Frontend (Дни 8-14, ~10 часов)

### Навигация

```
Промпт 6 — Добавить раздел Network в sidebar:

Add Network section to STAR sidebar navigation with these items:
- Overview  →  /network
- Ports      →  /network/ports
- Latency    →  /network/latency
- Traffic    →  /network/traffic
- Investigate →  /network/investigate

Add network icon (globe or wifi icon from existing icon set).
Show red badge on sidebar item if open_incidents > 0.
Add routes in React Router for all 5 pages.
Create placeholder components for each so navigation works immediately.
```

---

### Экран 1 — Overview

```
Промпт 7:

Create /src/pages/network/Overview.jsx for STAR dashboard.
Match existing STAR dark glassmorphism design language exactly.
Use same component patterns, colors, and spacing as existing pages.
Use recharts for charts (already installed in project).
Fetch data from GET /api/network/overview and GET /api/network/latency?period=30m

Layout:

Row 1 — Status cards (4 cards, full width):
Each card: icon + label + main value + sub-value + color indicator
  Card 1 "WAN": green/yellow/red dot + latency ms + packet loss %
  Card 2 "Internal Network": dot + active devices count + "X ports with errors"
  Card 3 "Gateway RTT": current ms value + sparkline (last 30 readings)
  Card 4 "Incidents": count of open incidents + severity of worst one

Row 2 — split 60/40:
  Left: Real-time latency chart (recharts LineChart)
    - Lines: Gateway (green), 8.8.8.8 (blue), 1.1.1.1 (purple)
    - X axis: last 30 minutes, auto-scrolls
    - Y axis: RTT ms, 0 to max+10%
    - Dashed horizontal line at 50ms labeled "Warning"
    - Dashed horizontal line at 150ms labeled "Critical"  
    - Tooltip: all targets at that time

  Right: Top devices by traffic (last 5 minutes)
    - List of 10 devices
    - Each: hostname + IP + bytes sent + bytes received + mini progress bar
    - Color: blue=normal, yellow=high (>80% of max), red=very high
    - Clicking device → /network/investigate?ip=X

Row 3 — split 50/50:
  Left: Recent incidents
    - Last 5 incidents: severity badge + title + time ago + open/resolved
    - "View all" link → /network/incidents
    - Empty state: "✅ No incidents in last 24h"

  Right: Health score
    - Large number 0-100
    - Arc gauge (SVG or recharts RadialBarChart)
    - Color: green 80-100, yellow 50-79, red 0-49
    - Breakdown: WAN stability / Port health / Device uptime (3 sub-scores)

Collector offline banner:
  If collector.online = false: show yellow banner at top:
  "⚠️ Collector offline — last data received X minutes ago. 
   Network data may be stale. Start the collector to resume monitoring."

Auto-refresh every 30 seconds. Show "Last updated X seconds ago" in top right.
Skeleton loading state for all sections.
```

---

### Экран 2 — Ports

```
Промпт 8:

Create /src/pages/network/Ports.jsx
Fetch from GET /api/network/ports

Header:
  - Switch selector dropdown (if multiple switches in data)
  - Search input: filter by device name or IP
  - Filter buttons: All | Errors | High Traffic | Empty

Visual switch diagram (main feature):
  - Grid of port rectangles representing physical switch
  - 24 ports per row (or 48 if needed, configurable)
  - Port colors:
    🟢 #22c55e  — healthy, device connected
    🟡 #eab308  — warning (errors or high traffic)
    🔴 #ef4444  — error (rx_errors > 0 in last 5min)
    ⚫ #374151  — empty (no device)
    🔵 #3b82f6  — uplink port
  - Port shows: port number label
  - Hover tooltip: device hostname, IP, current rx/tx rate, error count
  - Click port: opens Port Detail Panel

Port Detail Panel (slide-in from right, 380px wide):
  - Header: "Port {id} — {switch_name}"
  - Device card: hostname, IP, MAC, device type icon
  - Status badge: healthy/warning/error
  - Current rates: rx bytes/s, tx bytes/s (update every 10s)
  - Chart: rx/tx over last 1 hour (recharts AreaChart, two areas)
  - Error chart: rx_errors per 5min last 6h (bar chart, red bars)
  - "Investigate Device" button → /network/investigate?ip=X
  - Close button (X) or click outside

Below diagram: sortable table
Columns: Port | Device | IP | RX/s | TX/s | Errors (1h) | Status | Last Error
Default sort: errors descending
Clicking row highlights port in diagram and opens panel
Pagination: 25 rows per page
```

---

### Экран 3 — Latency

```
Промпт 9:

Create /src/pages/network/Latency.jsx
Fetch from GET /api/network/latency?period={period}

Header controls:
  Period buttons: 15min | 1h | 6h | 24h | 7d (default 1h)
  Target checkboxes: Gateway | ISP Gateway | 8.8.8.8 | 1.1.1.1

Main chart (recharts ComposedChart):
  - Lines: one per target, distinct colors
  - Area chart behind lines for packet loss % (right Y axis, 0-100%)
  - Left Y axis: RTT ms
  - Threshold lines: 50ms (yellow dashed), 150ms (red dashed)
  - Brush component at bottom for zooming
  - Tooltip: all values at hovered time

Stats cards below chart (one per target):
  - Target name + current status dot
  - Avg RTT | P95 RTT | Max RTT | Packet Loss avg | Uptime %
  - Color coding matches chart line color

Outage timeline:
  - Horizontal Gantt-style chart
  - One row per target
  - Colored segments: green=healthy, yellow=degraded (loss 2-10%), red=down (loss>10%)
  - Hover segment: start time, duration, worst packet loss

Interpretation panel (right side, 300px):
  Auto-generated plain-English summary:

  If everything healthy:
  "✅ All targets healthy
   Gateway: 2ms avg (excellent)
   WAN: 18ms avg (good)
   No packet loss detected in selected period."

  If issue detected:
  "⚠️ WAN degradation detected
   8.8.8.8 showed 8% packet loss 14:23–14:31 (8 minutes)
   Gateway latency was normal throughout → Internal network was fine
   Likely cause: ISP or upstream routing issue
   Recommendation: Check ISP status page or contact provider"

  Update interpretation when period changes.
```

---

### Экран 4 — Traffic

```
Промпт 10:

Create /src/pages/network/Traffic.jsx
Fetch from GET /api/network/flows?period={period}

Header: Period selector 15min | 1h | 6h | 24h + IP filter input

Section 1 "Top Talkers":
  Horizontal bar chart (recharts BarChart horizontal)
  Top 10 devices by total bytes (sent + received)
  Each bar: device hostname left label, bytes right label
  Two colours per bar: blue=sent, green=received
  Click bar → /network/investigate?ip=X

Section 2 "Protocol Breakdown" (side by side):
  Left: Donut chart — HTTPS / DNS / SMB / RDP / Teams / Other
  Right: Table — Protocol | Bytes | % of total | Devices using it
  Protocols detected by dst_port:
    443 → HTTPS, 53 → DNS, 445 → SMB, 3389 → RDP,
    3478/19302 → Teams/Zoom, 80 → HTTP, else → Other

Section 3 "Anomalies" (if any):
  Auto-detected flags shown as alert cards:
  - High traffic device: "{hostname} using {X}x more than usual"
  - Unusual port: "{hostname} connecting to port {port} (uncommon)"  
  - Large transfer: "{hostname} transferred {X}GB to {destination}"
  Each card: icon + description + bytes + time + "Investigate" button
  If no anomalies: "✅ No unusual traffic patterns detected"

Section 4 "Flow Table":
  Collapsible (collapsed by default)
  Columns: Time | Source | Destination | Protocol | Bytes | Packets | Direction
  Sortable, 50 rows per page
  Export CSV button
```

---

### Экран 5 — Investigate (главный экран)

```
Промпт 11:

Create /src/pages/network/Investigate.jsx — most important screen.
Fetch from GET /api/network/investigate?ip={ip}&start={start}&end={end}
And GET /api/network/devices for autocomplete.

Header search bar (prominent, centered when no search):
  - IP or hostname autocomplete input (from device_registry)
  - Date range picker: start + end datetime (default: last 2 hours)
  - "Analyze" button (primary, large)
  - Keyboard shortcut hint: "Press / to search"

Empty state (no search yet):
  Show "Common Scenarios" — 6 clickable cards in 2x3 grid:

  Card 1 "User can't be heard on call"
  Icon: 🎤  
  "Check port errors, gateway latency, and VoIP traffic during the call"
  [Start Investigation] → prompts for device IP, sets time range

  Card 2 "Internet slow for everyone"
  Icon: 🌐
  "Check WAN packet loss and top bandwidth consumers"
  [Open Traffic View] → /network/traffic

  Card 3 "Device keeps disconnecting"
  Icon: 🔌
  "Check port error history and device online/offline timeline"
  [Start Investigation] → prompts for device

  Card 4 "Can't reach internal server"
  Icon: 🖥️
  "Check latency to server IP and firewall drops"
  [Start Investigation] → prompts for server IP

  Card 5 "Network was slow this morning"
  Icon: 📈
  "Check latency history and incidents from that time"
  [Open Latency] → /network/latency

  Card 6 "New device not getting internet"
  Icon: ❓
  "Check if device appears in registry and has valid IP"
  [Check Devices] → /network/devices

When IP is searched and data loaded:

Panel 1 "Device" (top, full width):
  Hostname (large) | IP | MAC | Type icon
  Switch badge: "SW-01 / Port 12"
  Status: 🟢 Online / 🔴 Offline — Last seen: X minutes ago
  Notes field (editable inline, saves on blur via PATCH /api/network/devices/{ip})

Panel 2 "Diagnosis" (most prominent, colored border):
  If healthy: green border
  If issue: red/yellow border based on severity
  
  Large text: likely_cause in human readable:
    cable_or_nic → "Cable or NIC Issue"
    wan_issue → "WAN / ISP Issue"  
    firewall_drop → "Firewall Blocking Traffic"
    server_side → "Remote Server Issue"
    wifi_signal → "Weak WiFi Signal"
    healthy → "No Issues Detected"
    unknown → "Cause Unclear"
  
  Confidence badge: HIGH / MEDIUM / LOW
  
  Evidence list (bullet points from API):
  "• 847 RX errors on port 12 in this period"
  "• 3.2% packet loss to gateway (above 1% threshold)"
  "• WAN packet loss: 0% (rules out internet issue)"
  "• No errors on other ports of same switch"
  
  Recommended Action box (yellow/blue bg):
  "→ Check physical cable on SW-01/Port 12
     If cable OK, test NIC by connecting different cable or port"

Panel 3 "Timeline" (scrollable, newest first):
  Vertical timeline component
  Each event: colored dot + time + description
  🔴 14:23 — RX errors spike: 847 errors in 5 minutes (port 12)
  🟡 14:21 — Packet loss to gateway: 3.2%
  🟢 14:20 — Large flow started: Teams UDP → 52.114.x.x
  ⚫ 14:15 — Device came online (first seen in this period)
  Expandable: click event for full details

Panel 4 "Metrics" (2x2 grid of charts):
  Chart 1: Port errors over time (bar, red)
  Chart 2: Latency to gateway (line, green)
  Chart 3: Bytes sent/received (area, two colors)  
  Chart 4: Top 5 destinations (horizontal bars)
  All charts use same time range as investigation period

Panel 5 "Raw Flows" (collapsible table):
  Same as Traffic screen flow table but filtered to this IP
  Export CSV button

Panel 6 "Past Incidents" (bottom):
  "This device had X incidents in the last 30 days"
  List with date, category, root_cause, resolution
  If none: "No previous incidents for this device"
```

---

### Экран 6 — Devices list

```
Промпт 12:

Create /src/pages/network/Devices.jsx
Fetch from GET /api/network/devices

Simple but useful page:

Header: search input + filter: All | Online | Offline | Unknown type

Table (sortable):
Columns: Status dot | Hostname | IP | MAC | Switch/Port | Type | Last Seen | Notes
- Status dot: green=online, grey=offline
- Hostname clickable → /network/investigate?ip=X
- Type: icon + label (workstation/server/printer/AP/unknown)
- Notes: truncated, click to expand inline editor
- Last Seen: human readable "2 minutes ago" / "3 hours ago"

Click row: side panel with:
- Full device details
- Last 24h online/offline timeline (was it stable?)
- "Investigate" button
- Edit: device type dropdown, notes textarea
- "Forget device" button (removes from registry, with confirmation)

Empty state if no devices: 
"No devices discovered yet. Start the collector inside your network to begin."
```

---

### UX компоненты (применяются везде)

```
Промпт 13:

Create reusable components for the network module:

1. /src/components/network/HelpTooltip.jsx
   Props: metric (string key)
   Shows ? icon, hover reveals tooltip with:
   - What it means (plain English)
   - Normal range
   - What to do if abnormal
   
   Metric definitions to include:
   rtt_ms: "Round-trip time. Normal: <5ms internal, <50ms internet. High = congestion or routing issue."
   packet_loss: "Packets that never arrived. Normal: 0%. Above 1% = call quality issues. Above 5% = serious."
   rx_errors: "Receive errors on switch port. Normal: 0. High = bad cable, faulty NIC, or duplex mismatch."
   tx_bytes_rate: "Data being sent from this device right now."
   health_score: "Overall network health 0-100. Based on WAN stability, port errors, and device uptime."

2. /src/components/network/CollectorStatus.jsx
   Small component for sidebar or overview:
   Shows: green dot "Collector online" or yellow "Collector offline - Xmin ago"
   Click: shows modal with:
   - Each data source status (goflow2 / telegraf / fping)
   - Last data received per source
   - "How to start collector" instructions (expandable)

3. /src/components/network/SetupGuide.jsx
   Shown on Overview until dismissed (save dismissed state to localStorage)
   Step-by-step checklist:
   ✅/⏳ 1. Database connected (check via API)
   ✅/⏳ 2. Collector running (check collector_heartbeat)
   ✅/⏳ 3. NetFlow enabled on pfSense
   ✅/⏳ 4. UniFi API connected
   ✅/⏳ 5. First devices discovered
   Each incomplete step has [How to set up] button opening instruction modal
   
   pfSense NetFlow instructions modal:
   "1. Log in to pfSense → System → Package Manager → Available Packages
    2. Search for 'softflowd' → click Install
    3. Go to Services → softflowd
    4. Interface: LAN
    5. Host: [your collector IP]
    6. Port: 9995
    7. Version: NetFlow v9
    8. Click Save, then Start"
   
   UniFi API instructions modal:
   "1. Open UniFi Controller → Settings → Admins
    2. Click Add Admin
    3. Username: star-monitor
    4. Role: Read Only
    5. Save password to collector/.env as UNIFI_PASS"

4. /src/components/network/SeverityBadge.jsx
   Props: severity ('low'|'medium'|'high'|'critical')
   Colored pill badge

5. /src/components/network/StatusDot.jsx
   Props: status ('healthy'|'degraded'|'down'|'unknown'), animated (bool)
   Colored dot, animated variant pulses
```

---

## Фаза 4 — Финальные детали (Дни 15-17, ~3 часа)

```
Промпт 14:

Add finishing touches to STAR network module:

1. Keyboard navigation:
   Global shortcuts (use existing STAR shortcut pattern if any):
   G then O → /network (Overview)
   G then P → /network/ports
   G then L → /network/latency  
   G then T → /network/traffic
   G then I → /network/investigate
   / → focus search input on Investigate page

2. Export:
   Every data table has "Export CSV" button
   /network/investigate has "Export Report" button
   Report = printable HTML: device info + diagnosis + timeline + charts (use window.print())
   Add print stylesheet that hides navigation and shows data cleanly

3. Network settings page /network/settings:
   Alert thresholds (editable, saved to Supabase settings table):
   - WAN packet loss threshold % (default 5)
   - Internal latency threshold ms (default 50)
   - Port error count threshold (default 50)
   - Traffic anomaly multiplier (default 5x)
   - Business hours: start time, end time (for after-hours anomaly detection)
   
   Monitored targets:
   - Table of fping targets with name, IP, type
   - Add/remove targets
   - These sync to collector via Supabase (collector reads targets table)

4. Incident management page /network/incidents:
   Table: severity | title | started | duration | status | root_cause
   Filter: open | resolved | all
   Click incident: detail panel with full evidence, timeline, resolution form
   Resolve button: opens modal asking for root_cause and resolution_notes
   Stats: MTTR (mean time to resolve), incidents by category this month
```

---

## Порядок промптов — точная последовательность

```bash
# Фаза 0 — БД
claude  # вставить Промпт 1

# Фаза 1 — Коллектор
claude  # вставить Промпт 2
claude  # вставить Промпт 3

# Фаза 2 — Backend
claude  # вставить Промпт 4
claude  # вставить Промпт 5

# Фаза 3 — Frontend
claude  # вставить Промпт 6  (навигация)
claude  # вставить Промпт 7  (Overview)
claude  # вставить Промпт 8  (Ports)
claude  # вставить Промпт 9  (Latency)
claude  # вставить Промпт 10 (Traffic)
claude  # вставить Промпт 11 (Investigate)
claude  # вставить Промпт 12 (Devices)
claude  # вставить Промпт 13 (UX компоненты)

# Фаза 4 — Финал
claude  # вставить Промпт 14
```

---

## Когда приедешь в офис — чеклист

```
□ 1. Подключись к офисной сети

□ 2. Убедись что Docker Desktop запущен

□ 3. Перейди в папку коллектора:
      cd star-collector  (или где находится папка collector/)

□ 4. Создай .env из примера:
      cp .env.example .env
      Заполни: SUPABASE_URL, SUPABASE_KEY, UNIFI_URL, UNIFI_USER, UNIFI_PASS, GATEWAY_IP

□ 5. Запусти коллектор:
      docker compose up -d

□ 6. Проверь что всё запустилось:
      docker compose ps
      (все сервисы: running)

□ 7. Включи NetFlow на pfSense:
      Services → softflowd → Host: [IP твоего ноутбука] → Port: 9995 → Save → Start

□ 8. Подожди 2 минуты

□ 9. Открой STAR → Network → Overview
      Должны появиться первые данные

□ 10. Проверь в Supabase SQL Editor:
       SELECT COUNT(*), MAX(time) FROM switch_port_metrics;
       SELECT COUNT(*) FROM device_registry;
```

---

## Временная оценка

| Фаза | Время | Можно делать дома? |
|---|---|---|
| 0 — Supabase schema | 1 час | ✅ Да |
| 1 — Коллектор | 4 часа | ✅ Да (тест в офисе) |
| 2 — Backend API | 5 часов | ✅ Да |
| 3 — Frontend (6 экранов) | 10 часов | ✅ Да (seed данные) |
| 4 — Финал | 3 часа | ✅ Да |
| **Итого** | **~23 часа** | |

~3 недели при 1-2 часа в день вечером.

---

## Что получишь в итоге

- Живая карта портов свича с цветовым статусом и hover деталями
- Автодиагностика за 30 секунд: "Cable or NIC Issue — High Confidence"
- 6 guided сценариев для частых проблем
- Telegram алерты с контекстом и ссылкой на расследование
- Встроенные инструкции подключения прямо в UI
- Tooltip объяснения каждой метрики на plain English
- Полная история инцидентов с root cause
- Экспорт данных и отчётов
- Коллектор переезжает на Pi/VM одной командой
- Нулевое влияние на сеть — только passive/read-only
