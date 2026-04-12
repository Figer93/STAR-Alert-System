# STAR Alert System — Fix Plan Progress

## Phase 0 — Collector Local Buffer ✅
- [x] **0A** — `collector/buffer.py` — SQLite buffer, write_local, flush_to_backend, 24h retention, 50k row cap
- [x] **0B** — Collector push flow: all services write via buffer, not Supabase directly
- [x] **0C** — Backfill on reconnect: gap logging, original timestamps preserved
- [x] **0D** — fping scope reduced to LAN only (10.2.1.253, 10.2.1.5, 10.2.1.3, 10.2.2.100)
- [x] Docker compose: `buffer_data` volume, `BACKEND_URL` env var, `buffer.py` bind mount
- [x] Backend: `POST /api/collector/metrics/latency|ports|devices|flows` + `/heartbeat`

## Phase 1 — Port Metrics Data Integrity ✅
- [x] **1A** — Migration `0012`: add `rx_errors_delta`, `tx_errors_delta`, `rx_bytes_delta`, `tx_bytes_delta`, `is_counter_reset` to `switch_port_metrics`
- [x] **1A** — Delta calculation in `unifi_poller`: prev readings tracked, counter reset detection, 10 GB sanity discard, clock-skew guard
- [x] **1A** — `collector.py` `/metrics/ports` INSERT includes 5 delta columns
- [x] **1B** — All 11 display queries in `network.py` use `_delta` columns (overview, get_ports, top_devices, investigate)

## Phase 2 — Incident Logic Overhaul ✅
- [x] **2A** — Migration `0013`: add `incident_scope` (global/device) + `affected_component` to `network_incidents`
- [x] **2B** — Global vs device incident rules: `_GLOBAL_ROOT_CAUSES`, `_get_open_global_incident` dedup, `incident_scope` on all `_create_incident` calls
- [x] **2C** — Packet loss threshold: >50% per-target for 3 consecutive cycles; `_check_wan_loss` rewritten with `_wan_loss_consecutive`/`_wan_loss_recover`
- [x] **2D** — Resolve endpoint exists (POST); `resolveIncident` added to `lib/api.ts`; Incidents.tsx uses `api.ts` instead of raw `fetch()`
- [x] **2E** — Auto-resolve global latency incidents after `_GLOBAL_RECOVER_THRESHOLD` (3) consecutive clean cycles; WAN outage resolves after 3 clean cycles per target; single Telegram on resolve

## Phase 3 — Timeline & Error History ⬜
- [ ] **3A** — Migration `0014`: create `port_error_events` table
- [ ] **3B** — Populate `port_error_events` from unifi_poller when rx/tx_errors_delta > 0
- [ ] **3C** — Populate `network_events` for timeline (port errors, device online/offline, latency spikes, incidents)
- [ ] **3D** — `last_error_at` per device — updated when errors detected, shown in Ports table

## Phase 4 — Investigation Page Accuracy ⬜
- [ ] **4A** — Bytes sent/received use delta columns in investigate endpoint
- [ ] **4B** — Remove per-device WAN/gateway loss; replace with global incident count for window
- [ ] **4C** — Diagnosis panel split: global outage banner (amber) + device-specific section
- [ ] **4D** — Past device incidents query (scope='device') + overlapping global incidents
- [ ] **4E** — Timeline events from `network_events` table

## Phase 5 — UI Data Confidence ⬜
- [ ] **5A** — Data freshness indicator: "Last updated Xs ago", amber/red banner if collector offline
- [ ] **5B** — Error count display: errors/hr from delta, tooltip with cumulative, color coding
- [ ] **5C** — Global outage banner on all network pages (dismissible per session)
- [ ] **5D** — Incident resolve button: outline style, confirmation, moves to Resolved tab
- [ ] **5E** — Investigation page: show "No data available" instead of 0 values

## Phase 6 — CLAUDE.md Update ⬜
- [ ] Add data integrity rules (always use _delta, timestamp rejection, counter reset)
- [ ] Add incident rules (global vs device scope, dedup, thresholds)
- [ ] Add collector architecture rules (LAN only, buffer-first, flush every 60s)
- [ ] Add UI rules (no per-device WAN diagnosis, freshness indicator, errors/hr)

---

## Execution Order
Phases must be executed sequentially. Each phase must deploy and verify before starting the next.

| Phase | Agent | Status |
|---|---|---|
| 0 — Collector buffer | infra | ✅ Done |
| 1 — Data integrity | backend | ✅ Done |
| 2 — Incident logic | backend | ✅ Done |
| 3 — Timeline/history | backend | ⬜ Pending |
| 4 — Investigation | backend + frontend | ⬜ Pending |
| 5 — UI confidence | frontend | ⬜ Pending |
| 6 — CLAUDE.md | any | ⬜ Pending |
