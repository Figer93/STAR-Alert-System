# STAR — Project Specification v2
> ST&R Infrastructure Alert & Network Monitor Dashboard  
> **Author:** Aleksandr Migulia  
> **Version:** 2.0 — April 2026  
> **Supersedes:** STR_AlertDashboard_PRD.md v1.0

---

## Что изменилось с v1

| v1 | v2 |
|---|---|
| Local Windows machine | Railway (backend + frontend) |
| SQLite → PostgreSQL | Supabase (PostgreSQL + TimescaleDB) |
| Cursor | Claude Code CLI |
| `start.bat` | Railway auto-deploy from GitHub |
| PingPlotter adapter | Заменён нативным fping коллектором |
| Только alert dashboard | Alert dashboard + полный Network Monitor |
| Коллектор не описан | Docker Compose коллектор (переносимый) |

---

## 1. Обзор проекта

STAR — внутренний инструмент для единственного IT инженера ST&R Limited (FCA-regulated, ~130 пользователей, Chorley).

Два модуля в одном приложении:

**Модуль 1 — Alert Dashboard (реализован)**
Единая панель для всех инфраструктурных событий. Получает алерты от NinjaRMM, pfSense, и других источников. Нормализует, дедуплицирует, отправляет в Telegram, показывает на дашборде в реальном времени через WebSocket.

**Модуль 2 — Network Monitor (в разработке)**
Пассивный сбор сетевых метрик: состояние портов UniFi, NetFlow с pfSense, ICMP latency. Хранит историю, автоматически диагностирует причину проблем (кабель / NIC / WAN / сервер / WiFi), предоставляет интерактивный дашборд с 5 экранами.

---

## 2. Текущая инфраструктура

```
GitHub (source of truth)
    ↓ push → auto-deploy
Railway
    ├── FastAPI backend  (Python 3.11)
    └── React frontend   (Vite + Tailwind)
         ↓ reads/writes
Supabase (PostgreSQL + TimescaleDB)
    ↑ pushes network data
Docker Compose коллектор
(запускается на любой машине внутри офисной сети)
    ← pfSense NetFlow UDP:9995
    ← UniFi Controller API polling
    → fping ICMP мониторинг
```

### Принцип коллектора

Коллектор — это Docker Compose с тремя сервисами. Вся конфигурация в одном `.env` файле. Переезд с ноутбука на Raspberry Pi или VM = скопировать `.env` + `docker compose up`. Railway и Supabase не знают где физически крутится коллектор.

**Коллектор read-only** — не вмешивается в трафик, только читает метаданные с оборудования. Если коллектор упадёт — сеть продолжает работать, только данные не собираются.

---

## 3. Tech Stack

| Слой | Технология |
|---|---|
| Backend | Python 3.11 · FastAPI · SQLAlchemy 2.0 · Alembic |
| Database | Supabase PostgreSQL + TimescaleDB extension |
| Real-time | WebSockets (FastAPI built-in) |
| Frontend | React 18 · Vite · Tailwind CSS · Recharts |
| Notifications | python-telegram-bot |
| Scheduling | APScheduler (alert worker, background tasks) |
| Коллектор | Docker Compose: goflow2 + telegraf + fping (Python) |
| Деплой | Railway (auto-deploy from GitHub main branch) |
| Config | .env + Pydantic Settings |

---

## 4. Структура репозитория

```
star/
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── models.py                    # Alert, Source, Rule, NotificationLog
│   ├── schemas.py
│   ├── websocket_manager.py
│   ├── alert_engine.py
│   ├── rule_engine.py
│   ├── alert_worker.py              # APScheduler: network anomaly detection
│   ├── notifiers/
│   │   ├── base.py
│   │   ├── telegram_notifier.py
│   │   └── email_notifier.py
│   ├── adapters/
│   │   ├── base.py
│   │   ├── pfsense_adapter.py       # Syslog UDP listener
│   │   ├── ninjarmm_adapter.py      # Webhook receiver
│   │   └── unifi_adapter.py         # [Future] direct UniFi events
│   └── routers/
│       ├── alerts.py                # Существующий
│       ├── sources.py               # Существующий
│       ├── rules.py                 # Существующий
│       ├── stats.py                 # Существующий
│       ├── ingest.py                # Существующий
│       ├── ws.py                    # Существующий
│       └── network.py               # НОВЫЙ — весь Network Monitor API
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx        # Существующий
│   │   │   ├── AlertHistory.tsx     # Существующий
│   │   │   ├── Sources.tsx          # Существующий
│   │   │   ├── Settings.tsx         # Существующий
│   │   │   └── network/             # НОВЫЙ раздел
│   │   │       ├── Overview.jsx
│   │   │       ├── Ports.jsx
│   │   │       ├── Latency.jsx
│   │   │       ├── Traffic.jsx
│   │   │       ├── Investigate.jsx
│   │   │       └── Devices.jsx
│   │   └── components/
│   │       └── network/             # НОВЫЕ компоненты
│   │           ├── HelpTooltip.jsx
│   │           ├── CollectorStatus.jsx
│   │           ├── SetupGuide.jsx
│   │           ├── SeverityBadge.jsx
│   │           └── StatusDot.jsx
├── collector/                       # НОВАЯ папка
│   ├── docker-compose.yml
│   ├── .env.example
│   ├── README.md
│   ├── goflow2/config.yaml
│   ├── telegraf/telegraf.conf
│   └── services/
│       ├── fping_collector/
│       └── health_reporter/
├── supabase/
│   └── migrations/
│       ├── 001_alerts_schema.sql    # Существующий
│       └── 002_network_schema.sql   # НОВЫЙ
├── .env.example
├── requirements.txt
└── README.md
```

---

## 5. База данных

### Существующие таблицы (Модуль 1)

```python
# alerts — все инфраструктурные события
id, source_id, severity, title, message, raw_payload,
fingerprint, status, first_seen, last_seen, occurrence_count,
notified_telegram, notified_email, acknowledged_by,
acknowledged_at, resolved_at

# sources — источники алертов
id, name, slug, adapter, type, enabled, config,
last_seen, status, created_at

# rules — правила маршрутизации и подавления
id, name, source_slug, condition (JSON), severity_override,
notify_telegram, notify_email, cooldown_minutes, enabled

# notification_logs — история уведомлений
id, alert_id, channel, recipient, sent_at, success, error
```

### Новые таблицы (Модуль 2 — TimescaleDB гипертаблицы)

```sql
-- Все flow соединения с pfSense NetFlow
network_flows (
    time TIMESTAMPTZ NOT NULL,       -- гипертаблица по этому полю
    src_ip INET,
    dst_ip INET,
    src_port INTEGER,
    dst_port INTEGER,
    protocol SMALLINT,
    bytes BIGINT,
    packets INTEGER,
    device_name TEXT,                -- резолвится из device_registry
    direction TEXT                   -- 'inbound'|'outbound'|'internal'
)
Retention: 7 дней raw | TimescaleDB continuous aggregate по часам → 90 дней

-- Метрики портов UniFi (опрос каждые 60 сек)
switch_port_metrics (
    time TIMESTAMPTZ NOT NULL,
    switch_id TEXT,
    switch_name TEXT,
    port_id TEXT,
    port_name TEXT,
    device_name TEXT,
    device_ip INET,
    rx_bytes BIGINT,
    tx_bytes BIGINT,
    rx_errors BIGINT,
    tx_errors BIGINT,
    rx_packets BIGINT,
    tx_packets BIGINT,
    poe_watts FLOAT,
    is_uplink BOOLEAN DEFAULT false
)
Retention: 90 дней

-- ICMP latency (fping каждые 10 сек)
latency_metrics (
    time TIMESTAMPTZ NOT NULL,
    target_name TEXT,
    target_ip INET,
    target_type TEXT,                -- 'gateway'|'wan'|'dns'|'internal'
    rtt_ms FLOAT,
    packet_loss_pct FLOAT
)
Retention: 365 дней

-- Реестр устройств (обновляется коллектором)
device_registry (
    ip INET PRIMARY KEY,
    mac TEXT,
    hostname TEXT,
    switch_id TEXT,
    port_id TEXT,
    last_seen TIMESTAMPTZ,
    first_seen TIMESTAMPTZ,
    is_online BOOLEAN DEFAULT false,
    device_type TEXT,                -- 'workstation'|'server'|'printer'|'ap'|'unknown'
    notes TEXT                       -- заметки от инженера
)

-- Сетевые инциденты (создаются автоматически и вручную)
network_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    severity TEXT,                   -- 'low'|'medium'|'high'|'critical'
    category TEXT,                   -- 'wan_issue'|'interface_error'|'device_offline'|
                                     -- 'internal_latency'|'traffic_anomaly'|'firewall_drop'
    affected_ip INET,
    affected_switch TEXT,
    affected_port TEXT,
    title TEXT NOT NULL,
    description TEXT,
    evidence JSONB,                  -- массив строк с доказательствами
    root_cause TEXT,
    resolution_notes TEXT,
    auto_detected BOOLEAN DEFAULT true
)

-- Heartbeat коллектора
collector_heartbeat (
    collector_id TEXT PRIMARY KEY,
    last_seen TIMESTAMPTZ,
    version TEXT,
    sources JSONB                    -- {goflow2: bool, telegraf: bool, fping: bool}
)
```

---

## 6. API Endpoints

### Модуль 1 — Alerts (существующий)

| Method | Path | Description |
|---|---|---|
| GET | `/api/alerts` | Список алертов. Params: severity, source, status, limit, offset |
| GET | `/api/alerts/{id}` | Полный алерт с raw payload |
| PATCH | `/api/alerts/{id}/acknowledge` | Подтвердить алерт |
| PATCH | `/api/alerts/{id}/resolve` | Закрыть алерт |
| DELETE | `/api/alerts/{id}` | Удалить |
| GET | `/api/alerts/export?format=csv` | Экспорт |
| GET | `/api/sources` | Все источники с текущим статусом |
| PATCH | `/api/sources/{id}` | Включить/выключить, обновить конфиг |
| POST | `/api/ingest/ninjarmm` | NinjaRMM webhook |
| POST | `/api/ingest/pfsense` | pfSense syslog webhook |
| POST | `/api/ingest/{slug}` | Универсальный webhook |
| GET | `/api/stats/summary` | Counts: critical, warning, info, sources online |
| GET | `/api/stats/timeline?hours=24` | Алерты по часам для графика |
| WS | `/ws` | WebSocket: alert.new, alert.updated, source.status_change, stats.update |

### Модуль 2 — Network (новый, /api/network/*)

| Method | Path | Description |
|---|---|---|
| GET | `/api/network/overview` | WAN статус, устройства, collector, health score |
| GET | `/api/network/latency` | Time-series latency. Params: period, targets |
| GET | `/api/network/ports` | Все порты свичей с текущим статусом |
| GET | `/api/network/flows` | Топ flows по байтам. Params: period, ip, limit |
| GET | `/api/network/device/{ip}` | Полный профиль устройства |
| GET | `/api/network/investigate` | Диагностика. Params: ip, start, end |
| GET | `/api/network/incidents` | Сетевые инциденты. Params: status, limit |
| POST | `/api/network/incidents/{id}/resolve` | Закрыть с root_cause |
| GET | `/api/network/devices` | Все устройства из device_registry |
| PATCH | `/api/network/devices/{ip}` | Обновить notes, device_type |
| GET | `/api/network/settings` | Пороги алертов, цели мониторинга |
| PATCH | `/api/network/settings` | Обновить пороги |

---

## 7. Алгоритм автодиагностики (/api/network/investigate)

Для заданного IP и временного диапазона система собирает все доступные метрики и строит гипотезу:

```
Входные данные:
  - switch_port_metrics → rx_errors, tx_errors за период
  - latency_metrics → packet_loss к gateway и WAN за период
  - network_flows → топ destinations, объём трафика
  - device_registry → тип устройства (wifi / wired), switch, port
  - network_incidents → предыдущие инциденты для этого IP

Логика гипотезы (приоритет сверху вниз):
  1. rx_errors > 50 AND gateway_loss > 2%  → cable_or_nic     (high)
  2. rx_errors > 50 AND gateway_loss < 1%  → cable_or_nic     (medium)
  3. gateway_loss < 1% AND wan_loss > 5%   → wan_issue        (high)
  4. gateway_loss > 5% AND wan_loss > 5%   → wan_issue        (high, ISP/upstream)
  5. device is wifi AND signal < -75dBm    → wifi_signal      (high)
  6. pfSense drop logged for this IP       → firewall_drop    (high)
  7. all loss < 1% AND errors = 0 AND VoIP flows present → server_side (medium)
  8. all metrics normal                    → healthy          (high)
  9. else                                  → unknown          (low)

Выходные данные:
  {
    likely_cause: string,
    confidence: 'high'|'medium'|'low',
    evidence: [строки объясняющие почему],
    recommended_action: string
  }
```

---

## 8. Alert Worker (фоновые проверки)

Запускается каждые 60 секунд через APScheduler. Проверяет условия и создаёт инциденты + Telegram алерты.

| Условие | Порог (default) | Severity | Telegram |
|---|---|---|---|
| WAN packet loss | > 5%, 3 подряд | high | 🔴 WAN packet loss: X% |
| Interface errors | > 50 за 5 мин | medium | ⚠️ Errors on SW-01/Port 12 (DESKTOP-A4F) |
| Device offline | last_seen > 5 мин | low | 📴 DESKTOP-A4F went offline |
| Internal latency | RTT gateway > 50ms | high | 🔴 Internal latency: Xms to gateway |
| Collector offline | heartbeat > 5 мин | medium | ⚠️ Collector offline — no data |
| Traffic anomaly | > 5x 7-day avg | low | 📊 DESKTOP-A4F: 5x normal traffic |

**Дедупликация:** не создаёт новый инцидент если уже есть открытый для той же category+ip.  
**Авторезолв:** когда условие пропадает → resolved_at = now(), Telegram: "✅ Resolved: {title}"

---

## 9. Коллектор — сервисы

### goflow2 (NetFlow приёмник)
- Image: `netsampler/goflow2:latest`
- Слушает UDP 9995
- pfSense отправляет NetFlow v9 каждые 30 сек
- Пишет в `network_flows` через Postgres driver

### telegraf (UniFi поллинг)
- Image: `telegraf:latest`
- Опрашивает UniFi Controller API каждые 60 сек
- Собирает: port stats, connected clients (IP, MAC, signal)
- Пишет в `switch_port_metrics` и `device_registry`

### fping_collector (Python скрипт)
- Читает цели из `device_registry` + env переменных
- Запускает fping каждые 10 сек
- Парсит RTT и packet_loss
- Пишет в `latency_metrics`

### health_reporter (Python скрипт)
- Каждые 60 сек пишет в `collector_heartbeat`
- Проверяет что каждый сервис писал данные в последние 5 мин
- Если нет → логирует warning

---

## 10. Frontend — страницы

### Модуль 1 — Alert Dashboard (существующий)

- **Dashboard** — live alert feed, metric cards, source status, WebSocket
- **Alert History** — поиск, фильтры, CSV экспорт
- **Sources** — карточки источников, enable/disable, тест
- **Settings** — Telegram, SMTP, rule builder, maintenance mode

### Модуль 2 — Network Monitor (новый, /network/*)

- **Overview** — статус WAN/internal, latency chart 30мин, топ устройства, инциденты, health score
- **Ports** — визуальная карта портов свича, цвета по статусу, Port Detail Panel
- **Latency** — multi-line chart, packet loss area, outage timeline, plain-English интерпретация
- **Traffic** — топ talkers, protocol breakdown, flow anomalies, raw flows table
- **Investigate** — главный экран. Device card + Diagnosis panel + Timeline + 4 метрика графика + Raw flows
- **Devices** — таблица всех устройств, онлайн/офлайн, edit notes

### Навигация

```
Sidebar:
├── 🔔 Alerts         (существующий)
│   ├── Dashboard
│   ├── History
│   ├── Sources
│   └── Settings
└── 🌐 Network        (новый)
    ├── Overview      (badge: open incidents count)
    ├── Ports
    ├── Latency
    ├── Traffic
    ├── Investigate
    └── Devices
```

---

## 11. Интеграции

### Существующие

**NinjaRMM** (webhook)
- POST `/api/ingest/ninjarmm`
- Events: device offline, CPU/disk/RAM threshold, AV outdated, service stopped

**pfSense** (syslog UDP)
- Слушает UDP 514
- Events: firewall blocks, WAN up/down, VPN, DHCP, auth failures

### Новые (через коллектор)

**UniFi Controller** (API polling, read-only)
- Port metrics: rx/tx bytes, errors, PoE
- Client list: IP, MAC, hostname, signal strength, AP
- Требует: read-only аккаунт в UniFi Controller

**pfSense NetFlow** (UDP push от pfSense)
- Flow records: src/dst IP, port, protocol, bytes, packets
- Требует: softflowd пакет на pfSense, указать IP коллектора

**fping** (активный ICMP)
- Targets: gateway, ISP gateway, 8.8.8.8, 1.1.1.1, + все IP из device_registry
- Метрики: RTT ms, packet_loss %

### Запланированные адаптеры

- **DNS/DHCP** — NXDOMAIN спайки, scope exhaustion, неизвестные MAC
- **Active Directory** — lockouts, Kerberos failures, replication errors
- **Dialler** — SIP trunk, queue overflow, agent failures (dialer.starapps.co.uk)
- **CRM** — availability, sync failures

---

## 12. Уведомления

### Telegram формат (существующий + расширенный)

```
🔴 CRITICAL — NinjaRMM
SRV01 — CPU sustained above 80% for 15 min
🕐 14:22 | ST&R Dashboard → [Details]

⚠️ NETWORK — Interface Error
SW-01/Port 12 · DESKTOP-A4F (192.168.1.45)
847 RX errors in 5 minutes. Possible cable or NIC.
🕐 14:23 | ST&R Dashboard → [Investigate]

✅ RESOLVED — WAN packet loss
Duration: 8 minutes | Max loss: 8%
🕐 14:31 | ST&R Dashboard
```

Severity emoji: 🔴 Critical · 🟡 Warning · 🔵 Info · 🟢 Resolved · 📴 Offline · 📊 Anomaly

### Email
- Critical alerts only (по умолчанию)
- Alex + Campbell (из .env)

---

## 13. Severity Reference

| Severity | Цвет | Примеры | Действие |
|---|---|---|---|
| critical | 🔴 Red | WAN down, DC offline, CPU >90%, internal latency spike | Telegram сразу + Email |
| high | 🟠 Orange | Interface errors, WAN packet loss >5% | Telegram сразу |
| warning | 🟡 Amber | Packet loss >1%, disk >85%, device offline | Telegram (cooldown 15 мин) |
| info | 🔵 Blue | Single FW block, DHCP lease, traffic anomaly | Dashboard only |
| ok | 🟢 Green | Resolved | Telegram follow-up |

---

## 14. Deduplication Strategy (существующая)

Два алерта считаются дублями если:
- Одинаковые `source_id` + `event_type` + `fingerprint_key`
- `first_seen` в пределах dedup окна (default 30 мин, настраивается per rule)

При дубле: `occurrence_count++`, `last_seen = now()`, WebSocket `alert.updated`. Новое уведомление не отправляется (cooldown отдельно).

---

## 15. WebSocket события

```json
{ "event": "alert.new",            "payload": { /* Alert object */ } }
{ "event": "alert.updated",        "payload": { "id": 1, "status": "acknowledged" } }
{ "event": "source.status_change", "payload": { "source_id": 2, "status": "offline" } }
{ "event": "stats.update",         "payload": { "critical": 1, "warning": 3 } }
{ "event": "network.incident",     "payload": { /* NetworkIncident object */ } }
{ "event": "ping",                 "payload": {} }
```

---

## 16. Environment Variables

```env
# Application
APP_NAME=STAR Dashboard
APP_HOST=0.0.0.0
APP_PORT=8000
DEBUG=false
STAR_URL=https://your-app.railway.app   # для ссылок в Telegram

# Database
DATABASE_URL=postgresql://...           # Supabase connection string

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_IDS=111111111,222222222   # Alex, Campbell

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASSWORD=your_app_password
EMAIL_TO=alex@str-limited.com,campbell@str-limited.com

# pfSense syslog
PFSENSE_SYSLOG_PORT=514
PFSENSE_SYSLOG_ENABLED=true

# NinjaRMM
NINJARMM_WEBHOOK_SECRET=optional_secret

# Alert engine
DEFAULT_DEDUP_WINDOW_MINUTES=30
DEFAULT_COOLDOWN_MINUTES=15
CRITICAL_COOLDOWN_MINUTES=5

# Network alert thresholds (переопределяются через UI)
NETWORK_WAN_LOSS_THRESHOLD=5          # %
NETWORK_GATEWAY_RTT_THRESHOLD=50      # ms
NETWORK_PORT_ERRORS_THRESHOLD=50      # errors per 5 min
NETWORK_TRAFFIC_ANOMALY_MULTIPLIER=5  # x normal

# Frontend
VITE_API_URL=https://your-app.railway.app
VITE_WS_URL=wss://your-app.railway.app/ws
```

```env
# collector/.env (отдельный файл, только для коллектора)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=your_service_role_key     # НЕ anon key
UNIFI_URL=https://192.168.1.1
UNIFI_PORT=8443
UNIFI_USER=star-monitor
UNIFI_PASS=your_password
UNIFI_SITE=default
UNIFI_VERIFY_SSL=false
GATEWAY_IP=192.168.1.1
ISP_GATEWAY_IP=                        # первый хоп ISP (tracert 8.8.8.8)
NETFLOW_PORT=9995
COLLECTOR_ID=office-main
```

---

## 17. Фазы разработки

### ✅ Реализовано (Модуль 1)

- FastAPI backend с SQLAlchemy + Alembic
- Alert engine: normalize → classify → deduplicate → route
- WebSocket broadcaster (real-time dashboard updates)
- Telegram notifier
- NinjaRMM webhook adapter
- pfSense syslog adapter
- React dashboard: Alert feed, Sources, History, Settings
- Railway deployment + Supabase

### 🔄 В разработке (Модуль 2 — Network Monitor)

**Фаза 0 — Supabase schema** (~1 час)
- TimescaleDB extension
- 6 новых таблиц с retention policies
- Seed данные для разработки без коллектора

**Фаза 1 — Коллектор** (~5 часов)
- Docker Compose: goflow2 + telegraf + fping + health_reporter
- `.env.example` с комментариями
- README: quick start + инструкции подключения pfSense/UniFi

**Фаза 2 — Backend API** (~5 часов)
- `/api/network/*` роутер (14 эндпоинтов)
- Алгоритм автодиагностики в `/api/network/investigate`
- Alert worker: 6 типов проверок, дедупликация, авторезолв

**Фаза 3 — Frontend** (~10 часов)
- Навигация: Network раздел в sidebar
- 6 страниц: Overview, Ports, Latency, Traffic, Investigate, Devices
- 5 переиспользуемых компонентов: HelpTooltip, CollectorStatus, SetupGuide, SeverityBadge, StatusDot

**Фаза 4 — Polish** (~3 часа)
- Keyboard shortcuts
- CSV/PDF экспорт
- Network Settings страница
- Incident management страница

---

## 18. Принципы разработки (Claude Code CLI)

1. **Фаза за фазой** — тестировать каждую фазу перед следующей
2. **Seed данные** — Фаза 0 создаёт реалистичные данные, UI разрабатывается без коллектора
3. **Read-only коллектор** — никогда не давать коллектору write доступ к сетевому оборудованию
4. **Graceful empty states** — если коллектор не запущен, UI показывает пустые состояния, не ошибки
5. **Изоляция адаптеров** — краш адаптера не роняет core engine (try/except + log + continue)
6. **Всё через .env** — никаких hardcoded значений
7. **Fingerprint всё** — одно событие = один алерт, не 50 Telegram сообщений
8. **Логировать всё** — каждый ingested event, notification, error в лог файл

---

## 19. Чеклист при запуске в офисе

```
□ Docker Desktop запущен
□ cd collector/
□ cp .env.example .env && заполнить переменные
□ docker compose up -d
□ docker compose ps  (все running)
□ pfSense → Services → softflowd → Host: [IP ноутбука] → Port: 9995 → Start
□ Подождать 2 минуты
□ STAR → Network → Overview → проверить данные
□ Supabase SQL: SELECT COUNT(*) FROM switch_port_metrics;
```

---

*STAR PRD v2.0 — Aleksandr Migulia — April 2026*  
*Предыдущая версия: STR_AlertDashboard_PRD_v1.md (архив)*
