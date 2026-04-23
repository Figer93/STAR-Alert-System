# STAR Alert System — Progress Log

## Last Session (23 April 2026) — Packet loss incidents + latency correlation analysis

**What was changed:**
- `backend/network_monitor.py`: Added `_check_packet_loss` function and registered it in `_CHECKS` (runs after `_check_wan_loss`)
  - Covers ALL latency targets (LAN and WAN), not just external IPs
  - No consecutive-cycle guard — creates a `packet_loss` incident on the first 5-minute window showing >10% average loss
  - Severity: loss >50% → high, 10–50% → medium
  - Auto-resolves when target drops below 10%
  - Deduplicates via `_get_open_incident` + `_recently_resolved` (30-min re-open guard)
- `frontend/src/pages/network/Latency.tsx`: Enhanced ANALYSIS panel with LAN/WAN correlation badges
  - Added `correlation` field to `Interpretation` interface
  - `interpret()` now accepts `targetTypes: Record<string, string>` from API response
  - Replaces the old `isGateway` regex heuristic with proper `target_types` classification
  - Shows one of four correlation badges depending on which targets are affected:
    - Amber "Isolated — only {target} affected" (single target)
    - Amber "LAN Issue — loss isolated to internal network"
    - Red "WAN Issue — external connectivity affected"
    - Red "Full Outage — all targets affected"
  - Badge is rendered between the headline and bullet lines in the Analysis panel

**Why it was changed:**
- `_check_wan_loss` only fires on external/WAN targets after 3 consecutive cycles → LAN targets (e.g. 10.2.1.253 pfSense gateway) showing >50% loss never created an incident
- The latency timeline showed outage segments (e.g. "DOWN — 10.2.1.253, Worst loss: 55.3%") that had no corresponding incident in the incidents list
- The ANALYSIS panel used `isGateway` regex (matched "gateway"/"gw" in target name) rather than the real `target_types` from the API, giving incorrect LAN/WAN classification

**Files modified:**
- `backend/network_monitor.py`
- `frontend/src/pages/network/Latency.tsx`

**Known issues introduced:**
- WAN targets showing loss will now generate both a `packet_loss` incident (immediate) AND a `wan_issue` incident (after 3 cycles). These are separate categories and serve different purposes; no dedup conflict.

**Migration required (0028) — applied 2026-04-23:**
- `migrations/versions/0028_add_packet_loss_category.py` — adds `packet_loss` to `incident_category_enum`
- Without this migration, `_check_packet_loss` silently fails (enum validation error caught by `_exec`)
- Applied to production; alembic_version is now `0028`

**Deployment notes (2026-04-23):**
- Git-triggered Railway build (`5cec2c3d`) got stuck in a RAILPACK Metal builder loop (Railway platform issue)
- Resolved by running `railway up` directly (`mcp__railway__deploy`) → deployment `01188bb2` succeeded
- Startup log confirmed: "8 checks registered" (was 7 — confirms `_check_packet_loss` is live)

**What to do next:**
- Monitor next real packet loss event — should now appear in GET /api/network/incidents with category=packet_loss
- Verify correlation badges appear correctly in the Latency ANALYSIS panel during loss events

---

## Last Session (22 April 2026) — AD Monitor country/foreign-signin fix

**What was changed:**
- Renamed `sign_in_country` API field → `profile_country` (DB column unchanged, mapped in router)
- Set `is_foreign_signin = False` unconditionally in `ad_monitor.py` with comment pointing to the real implementation path (`/auditLogs/signIns`)
- Removed false-positive foreign sign-in detection that read the user profile `country` attribute
- Updated AD Monitor table column label from "Country" to "Profile Country"
- "Foreign Sign-ins" summary card now always shows 0 (data-correct, not suppressed)

**Why it was changed:**
- `sign_in_country` was populated from the Azure AD profile `country` field, which is a free-text directory attribute unrelated to sign-in location
- 3 users (2017 accounts, expired passwords, no recent logins) had garbage in their `country` field ("Skype", "Clive.Hawes") — these were flagged as foreign sign-ins
- These are not a security risk; the dirty data is a legacy data-entry error
- Real geographic sign-in detection requires querying `/auditLogs/signIns` (needs `AuditLog.Read.All` + separate paginated endpoint), which is not implemented

**Files modified:**
- `backend/services/ad_monitor.py` — profile_country local var, is_foreign_signin = False
- `backend/routers/ad.py` — Pydantic field rename, router mapping
- `frontend/src/lib/api.ts` — AdUserRow interface field rename
- `frontend/src/pages/network/ADMonitor.tsx` — column header + field reference

**Known issues introduced:**
- None

**What to do next:**
- Deploy and verify "Foreign Sign-ins" card shows 0 and "Foreign" tab shows empty
- Optionally: implement real foreign sign-in via `/auditLogs/signIns` if needed

---

## Last Session (22 April 2026)

**What was changed:**
- Added `DEBUG` log to `ninja_sync.py` to print first raw patch record from NinjaRMM API
- Fixed `repr(Exception)` → `repr(exc)` in `last_reboot` error handler (pre-existing bug)
- Investigated why `patches_failed`/`patches_pending` show 0 for all 14 devices in DB

**Why it was changed:**
- Patch compliance summary cards show 0 despite rows existing in `device_patch_status`
- Root cause not yet confirmed — debug log added to inspect raw NinjaRMM API response

**Findings:**
- Patch data source: `GET /v2/queries/os-patches` (paginated cursor, 1000 rows/page)
- Each record = one patch on one device; aggregated in Python by `deviceId`
- `patches_approved` counts status `APPROVED` or `INSTALLED`; `PENDING*` → pending; `FAILED` → failed; `NOT_APPROVED` silently dropped
- `reboot_required` comes from `devices-detailed` endpoint, not the patches endpoint
- Summary stats are frontend `reduce()` over the row array — no separate DB aggregate query
- Field names match exactly between API, Pydantic model, and frontend TypeScript interface

**Files modified:**
- `backend/services/ninja_sync.py` — debug log + repr fix (commit `1ae4cec`)

**Known issues introduced:**
- None — log line only, no logic changed

**What to do next:**
- Check Railway logs after deploy for `NinjaRMM: first raw patch record sample:` line
- Confirm what `status` values NinjaRMM is actually returning (may not match expected enum)
- Confirm `deviceId` field is present in patch records (fallback: `device_id`)
- Remove debug log once root cause confirmed

---

## Pending Issues

| Severity | Issue | File(s) | Notes |
|----------|-------|---------|-------|
| Low | `health_reporter` reports `telegraf` as SILENT | collector/services/health_reporter/main.py | Cosmetic — telegraf is disabled |
| Low | `network.py` docstring says "TimescaleDB" | backend/routers/network.py | Stale comment — no functional impact |
| Medium | NetFlow/Traffic page shows no data | N/A | goflow2 disabled, needs pfSense config |
| Low | Migration 0025 not committed | migrations/versions/0025_*.py | Check if already applied to Railway |

---

## Recent Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 22 Apr 2026 | Configuration overhaul | Context loss between sessions was causing repeated mistakes |
| 21 Apr 2026 | Alembic stamped 0015→0025 | Manual DB objects now under migration control |
| 21 Apr 2026 | latency_metrics retention = 7 days | Single cleanup job in network_monitor, removed conflict with main.py |
| 20 Apr 2026 | goflow2 + telegraf disabled | Crash loops, not configured — fping_collector supersedes telegraf |
| 20 Apr 2026 | Polling intervals 10s→60s | Reduced API load, frontend feels less janky |
| 20 Apr 2026 | Port metrics batched (260→1 POST) | Eliminated 260 individual POSTs per cycle |
| 19 Apr 2026 | SFP+ section added to Ports page | 10G ports need visual distinction from 1G |
| 19 Apr 2026 | Auth middleware added | verify_api_key + verify_collector_key on all routes |
| 19 Apr 2026 | TimescaleDB confirmed NOT installed | time_bucket() forbidden — use date_trunc() |
| 18 Apr 2026 | Dark theme only | No light theme support, CSS vars only |

---

## Fix Plan Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Collector Local Buffer | Done |
| 1 | Port Metrics Data Integrity | Done |
| 2 | Incident Logic Overhaul | Done |
| 3 | Timeline & Error History | Pending |
| 4 | Investigation Page Accuracy | Pending |
| 5 | UI Data Confidence | Pending |
| 6 | CLAUDE.md Update | Partially done (merged with this overhaul) |
