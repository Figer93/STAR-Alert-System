"""
backend/network_monitor.py

Background worker: checks six network conditions every 60 seconds and
creates/resolves network_incidents + sends Telegram alerts.

Checks:
  1. WAN packet loss         — avg > 5 % in last 3 min
  2. Interface errors        — port RX errors > 50 in last 5 min
  3. Device offline          — is_online=true but last_seen > 5 min ago
  4. Internal latency spike  — avg gateway RTT > 50 ms in last 3 min
  5. Collector offline       — heartbeat stale > 5 min (in-memory dedup)
  6. Traffic anomaly         — device using > 5× its 7-day avg in last 15 min

Deduplication:
  - Open incident exists for (category, affected entity) → skip creation.
  - Incident resolved within last 30 min → skip re-creation.
  - Condition clears while incident is open → auto-resolve + Telegram ✅.

All DB work uses raw text() SQL (network tables have no SQLAlchemy ORM models).
On SQLite (dev) the tables do not exist; every check is skipped gracefully.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

_IS_POSTGRES = "postgresql" in settings.DATABASE_URL
_RESOLVE_WINDOW_MINUTES = 30          # don't re-open an incident resolved < 30 min ago
_COLLECTOR_STALE_MINUTES = 5
_DEVICE_STALE_MINUTES = 5
_WAN_LOSS_THRESHOLD = 5.0             # % — legacy single-reading threshold (kept for reference)
_WAN_LOSS_PCT_THRESHOLD = 50.0        # % — per-target threshold for consecutive-cycle check
_WAN_LOSS_CONSECUTIVE_THRESHOLD = 3   # consecutive 60-s cycles before a WAN incident opens
_GLOBAL_RECOVER_THRESHOLD = 3         # consecutive recovery cycles before a global incident closes
_LATENCY_THRESHOLD_MS = 50.0          # ms
_PORT_ERROR_THRESHOLD = 50            # RX errors per 5-min window (raw fallback)
_PORT_ERROR_RATE_LOW  = 0.001         # % — below this is background noise
_PORT_ERROR_RATE_MED  = 0.1           # % — above this is medium/high confidence issue
_PORT_MIN_BYTES       = 1_048_576     # 1 MB min traffic for rate-based threshold
_TRAFFIC_ANOMALY_MULTIPLIER = 5.0     # × historical average
_TRAFFIC_HISTORY_MIN_AVG_BYTES = 102_400  # 100 KB — ignore very-low-traffic devices

# ── Latency polling targets ───────────────────────────────────────────────────
# Named constants for static internal/DNS IPs.  Changing an IP here propagates
# to _LATENCY_TARGET_ROLES, _INTERNAL_IPS, _EXTERNAL_DNS, and root-cause logic.
_IP_LAN_GW       = "10.2.1.253"   # pfSense (LAN gateway)
_IP_DC_PRIMARY   = "10.2.1.5"     # Primary DC (VLAN 1)
_IP_DC_SECONDARY = "10.2.1.3"     # Secondary DC (VLAN 1)
_IP_VLAN2_DC     = "10.2.2.100"   # DC (VLAN 2)
_IP_DNS_CF       = "1.1.1.1"      # Cloudflare DNS
_IP_DNS_GOOGLE   = "8.8.8.8"      # Google DNS

# Static IP → role label.  WAN gateway IPs from settings are merged in at runtime
# inside _check_internal_latency so all configured targets are polled together.
_LATENCY_TARGET_ROLES: dict[str, str] = {
    _IP_LAN_GW:       "pfSense (LAN gateway)",
    _IP_DC_PRIMARY:   "Primary DC (VLAN 1)",
    _IP_DC_SECONDARY: "Secondary DC (VLAN 1)",
    _IP_VLAN2_DC:     "DC (VLAN 2)",
    _IP_DNS_CF:       "Cloudflare DNS",
    _IP_DNS_GOOGLE:   "Google DNS",
}
_INTERNAL_IPS = frozenset({_IP_LAN_GW, _IP_DC_PRIMARY, _IP_DC_SECONDARY, _IP_VLAN2_DC})
_EXTERNAL_DNS  = frozenset({_IP_DNS_CF, _IP_DNS_GOOGLE})

# Root causes that represent a network-wide outage (incident_scope='global').
# Device-specific root causes (PFSENSE, DC_PRIMARY, DC_SECONDARY, VLAN2_DC, UNKNOWN)
# are incident_scope='device' and are scoped to a single IP.
_GLOBAL_ROOT_CAUSES = frozenset({"WAN_ISP", "WAN_LINE", "WAN1_DOWN", "WAN2_DOWN", "FULL_OUTAGE", "ALL_INTERNAL"})

# Map device-scoped root causes to their primary IP for affected_ip on the incident.
_ROOT_CAUSE_IP: dict[str, str] = {
    "PFSENSE":      _IP_LAN_GW,
    "DC_PRIMARY":   _IP_DC_PRIMARY,
    "DC_SECONDARY": _IP_DC_SECONDARY,
    "VLAN2_DC":     _IP_VLAN2_DC,
}

_LATENCY_CONSECUTIVE_THRESHOLD = 3    # alert after N consecutive readings above threshold
_LATENCY_COOLDOWN_MINUTES       = 10  # suppress re-alert for N min after a target recovers

_ROOT_CAUSE_LABELS: dict[str, str] = {
    "WAN1_DOWN":     "WAN1 Outage (Primary ISP)",
    "WAN2_DOWN":     "WAN2 Outage (Secondary ISP)",
    "WAN_ISP":       "WAN / ISP Outage (both uplinks)",
    "WAN_LINE":      "WAN Line Fault (physical CPE-to-pfSense)",
    "PFSENSE":       "pfSense Overload / LAN Interface",
    "DC_PRIMARY":    "Primary DC Overload / NIC Issue",
    "DC_SECONDARY":  "Secondary DC Overload / NIC Issue",
    "VLAN2_DC":      "VLAN 2 Routing or DC Issue",
    "ALL_INTERNAL":  "Core Switch Failure / Broadcast Storm",
    "FULL_OUTAGE":   "Full Network Outage (pfSense down)",
    "UNKNOWN":       "Mixed / Unknown Root Cause",
}

# Module-level state for collector liveness (no DB row involved)
_collector_online_state: Optional[bool] = None

# Per-target latency tracking (consecutive count + post-resolve cooldown)
_latency_consecutive:         dict[str, int]      = {}  # ip → consecutive above-threshold readings
_latency_recover_consecutive: dict[str, int]      = {}  # ip → consecutive below-threshold readings
_latency_cooldown:            dict[str, datetime] = {}  # ip → cooldown-expiry timestamp
_global_latency_recover_consecutive: int          = 0   # consecutive cycles where alerting is empty (global incident auto-resolve)

# Per-target WAN packet-loss tracking (consecutive-cycle pattern mirrors latency)
_wan_loss_consecutive: dict[str, int] = {}  # ip → consecutive cycles >50% loss
_wan_loss_recover:     dict[str, int] = {}  # ip → consecutive cycles ≤50% loss

# Startup grace period: skip writing WAN probe results for the first N cycles
# so that process-start latency / route-table convergence doesn't create
# spurious 100%-loss rows that immediately trigger false-positive incidents.
_WAN_PROBE_GRACE_CYCLES = 2
_wan_probe_cycle:        int = 0   # incremented at the top of each probe call

# ── Telegram rate limiting ────────────────────────────────────────────────────
# Per-device cooldown: at most 1 new-incident alert per (category, entity) per hour.
# Hourly cap: at most 10 total new-incident alerts per hour across all categories.
# Resolution / collector-transition messages are EXEMPT and always sent immediately.

_tg_sent_keys:  dict[str, datetime] = {}   # dedup_key → last sent timestamp
_tg_hour_log:   list[datetime]      = []   # timestamps of sent new-incident alerts
_tg_suppressed: int                 = 0    # suppressed count since last successful send

_TELEGRAM_DEVICE_COOLDOWN_S = 3_600   # 1 hour between alerts for the same entity
_TELEGRAM_HOURLY_CAP        = 10      # max new-incident alerts per hour globally


# ── Telegram helpers ──────────────────────────────────────────────────────────

async def _send_telegram(message: str) -> None:
    """
    Send a plain-text Telegram message to all configured chat IDs.
    No rate limiting — used for resolutions and status transitions.
    """
    if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
        logger.debug("Telegram not configured — skipping network alert")
        return
    try:
        import telegram
        bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
        for chat_id in settings.telegram_chat_id_list:
            await bot.send_message(chat_id=chat_id, text=message)
    except Exception as exc:
        logger.error("Network monitor Telegram send failed: %s", exc)


async def _rate_limited_telegram(message: str, dedup_key: str) -> None:
    """
    Rate-limited Telegram send for NEW incident alerts.

    Rules (all applied before sending):
    1. Per-entity cooldown: if the same dedup_key was sent within the last hour, suppress.
    2. Hourly cap: if >= 10 new-incident alerts have been sent in the last 60 minutes,
       suppress and count. The suppressed count is prepended to the next message that
       actually gets through.

    dedup_key should be "{category}:{affected_ip}" or "{category}" for network-wide alerts.
    """
    global _tg_suppressed, _tg_hour_log, _tg_sent_keys

    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=1)

    # Purge stale entries from the hourly window
    _tg_hour_log = [t for t in _tg_hour_log if t > cutoff]

    # 1. Per-entity cooldown
    last_sent = _tg_sent_keys.get(dedup_key)
    if last_sent and (now - last_sent).total_seconds() < _TELEGRAM_DEVICE_COOLDOWN_S:
        _tg_suppressed += 1
        logger.debug("Telegram suppressed (device cooldown) key=%s total_suppressed=%d",
                     dedup_key, _tg_suppressed)
        return

    # 2. Hourly cap
    if len(_tg_hour_log) >= _TELEGRAM_HOURLY_CAP:
        _tg_suppressed += 1
        logger.debug("Telegram suppressed (hourly cap) total_suppressed=%d", _tg_suppressed)
        return

    # Prepend suppressed summary if any were held back
    full_message = message
    if _tg_suppressed > 0:
        full_message = (
            f"ℹ️ {_tg_suppressed} alert(s) suppressed in the last hour.\n\n{message}"
        )
        _tg_suppressed = 0

    await _send_telegram(full_message)
    _tg_hour_log.append(now)
    _tg_sent_keys[dedup_key] = now


def _investigate_link(ip: Optional[str] = None) -> str:
    """Return the full investigate URL if STAR_URL is configured, else empty string."""
    base = settings.STAR_URL.rstrip("/")
    if not base:
        return ""
    qs = f"?ip={ip}" if ip else ""
    return f"{base}/network/investigate{qs}"


def _fmt_bytes(n: int) -> str:
    if n >= 1_073_741_824:
        return f"{n / 1_073_741_824:.1f} GB"
    if n >= 1_048_576:
        return f"{n / 1_048_576:.1f} MB"
    return f"{n / 1024:.0f} KB"


# ── Raw SQL helpers ───────────────────────────────────────────────────────────

async def _exec(
    db: AsyncSession, sql: str, params: dict | None = None
) -> list[dict]:
    """Execute SQL, return list of row dicts. Returns [] on any error."""
    try:
        result = await db.execute(text(sql), params or {})
        return [dict(row._mapping) for row in result]
    except Exception as exc:
        logger.debug("Network monitor query failed: %s", exc)
        await db.rollback()
        return []


async def _exec_one(
    db: AsyncSession, sql: str, params: dict | None = None
) -> dict | None:
    rows = await _exec(db, sql, params)
    return rows[0] if rows else None


# ── Network event helper ──────────────────────────────────────────────────────

async def _write_event(
    db: AsyncSession,
    event_type: str,
    *,
    device_ip: Optional[str] = None,
    target_ip: Optional[str] = None,
    incident_id: Optional[str] = None,
    description: str = "",
    metadata: dict | None = None,
) -> None:
    """
    Insert a row into network_events (timeline).

    Best-effort: errors are logged but never re-raised so callers are not
    interrupted by a failed event write.

    event_type values (canonical):
      port_error, device_offline, device_online, latency_spike,
      incident_created, incident_resolved
    """
    try:
        await db.execute(text("""
            INSERT INTO network_events
                (event_type, device_ip, target_ip, incident_id,
                 description, metadata)
            VALUES
                (:event_type,
                 CAST(NULLIF(:device_ip, '') AS INET),
                 CAST(NULLIF(:target_ip, '') AS INET),
                 CAST(:incident_id AS UUID),
                 :description,
                 CAST(:metadata AS jsonb))
        """), {
            "event_type":  event_type,
            "device_ip":   device_ip,
            "target_ip":   target_ip,
            "incident_id": incident_id,
            "description": description,
            "metadata":    json.dumps(metadata) if metadata else None,
        })
        # Caller is responsible for db.commit()
    except Exception as exc:
        logger.error("network_events write failed (event_type=%s): %s", event_type, exc)


# ── Incident management ───────────────────────────────────────────────────────

async def _get_open_incident(
    db: AsyncSession,
    category: str,
    *,
    affected_ip: Optional[str] = None,
    affected_switch: Optional[str] = None,
    affected_port: Optional[str] = None,
) -> dict | None:
    """
    Find the most recent open incident matching the given criteria.

    When affected_ip is None and affected_switch is also None, adds
    'affected_ip IS NULL' so that "whole-network" incidents (WAN loss,
    internal latency) don't accidentally match device-specific ones.
    """
    conditions = ["resolved_at IS NULL", "category = :category"]
    params: dict[str, Any] = {"category": category}

    if affected_ip is not None:
        conditions.append("affected_ip::text = :affected_ip")
        params["affected_ip"] = affected_ip
    elif affected_switch is None:
        # Network-wide check — only match incidents with no specific IP
        conditions.append("affected_ip IS NULL")

    if affected_switch is not None:
        conditions.append("affected_switch = :affected_switch")
        params["affected_switch"] = affected_switch

    if affected_port is not None:
        conditions.append("affected_port = :affected_port")
        params["affected_port"] = affected_port

    where = " AND ".join(conditions)
    return await _exec_one(db,
        f"SELECT id::text AS id, title, severity, started_at, incident_scope "
        f"FROM network_incidents WHERE {where} "
        f"ORDER BY started_at DESC LIMIT 1",
        params)


async def _recently_resolved(
    db: AsyncSession,
    category: str,
    *,
    affected_ip: Optional[str] = None,
    affected_switch: Optional[str] = None,
    affected_port: Optional[str] = None,
) -> bool:
    """Return True if a matching incident was resolved within the last 30 minutes."""
    conditions = [
        "resolved_at IS NOT NULL",
        "category = :category",
        f"resolved_at > NOW() - INTERVAL '{_RESOLVE_WINDOW_MINUTES} minutes'",
    ]
    params: dict[str, Any] = {"category": category}

    if affected_ip is not None:
        conditions.append("affected_ip::text = :affected_ip")
        params["affected_ip"] = affected_ip
    elif affected_switch is None:
        conditions.append("affected_ip IS NULL")

    if affected_switch is not None:
        conditions.append("affected_switch = :affected_switch")
        params["affected_switch"] = affected_switch

    if affected_port is not None:
        conditions.append("affected_port = :affected_port")
        params["affected_port"] = affected_port

    where = " AND ".join(conditions)
    rows = await _exec(db,
        f"SELECT id FROM network_incidents WHERE {where} LIMIT 1",
        params)
    return bool(rows)


async def _create_incident(
    db: AsyncSession,
    *,
    severity: str,
    category: str,
    title: str,
    description: str,
    affected_ip: Optional[str] = None,
    affected_switch: Optional[str] = None,
    affected_port: Optional[str] = None,
    evidence: Optional[dict] = None,
    root_cause: Optional[str] = None,
    incident_scope: str = "device",
    affected_component: Optional[str] = None,
) -> Optional[str]:
    """
    Insert a new network_incident row and commit.
    Returns the generated UUID as a string, or None on error.

    incident_scope:    'global' for WAN/ISP/FULL_OUTAGE; 'device' for single-device incidents.
    affected_component: Human-readable component (e.g. 'WAN1', 'DC_PRIMARY') stored for UI display.
    NULL/INET casting is handled by conditional SQL fragments so that
    asyncpg never receives a typed None where a cast is specified.
    """
    ip_sql = "CAST(:affected_ip AS INET)" if affected_ip else "NULL"
    ev_sql = "CAST(:evidence AS JSONB)"   if evidence   else "NULL"
    ac_sql = ":affected_component"        if affected_component else "NULL"

    params: dict[str, Any] = {
        "severity":          severity,
        "category":          category,
        "title":             title,
        "description":       description,
        "affected_switch":   affected_switch,
        "affected_port":     affected_port,
        "root_cause":        root_cause,
        "incident_scope":    incident_scope,
    }
    if affected_ip:
        params["affected_ip"] = affected_ip
    if evidence:
        params["evidence"] = json.dumps(evidence)
    if affected_component:
        params["affected_component"] = affected_component

    rows = await _exec(db, f"""
        INSERT INTO network_incidents (
            severity, category, title, description,
            affected_ip, affected_switch, affected_port,
            evidence, root_cause, auto_detected,
            incident_scope, affected_component
        ) VALUES (
            :severity, :category, :title, :description,
            {ip_sql}, :affected_switch, :affected_port,
            {ev_sql}, :root_cause, true,
            :incident_scope, {ac_sql}
        )
        RETURNING id::text AS id
    """, params)

    incident_id = rows[0]["id"] if rows else None
    if incident_id:
        await _write_event(
            db,
            "incident_created",
            device_ip=affected_ip,
            incident_id=incident_id,
            description=title,
            metadata={
                "severity":    severity,
                "category":    category,
                "root_cause":  root_cause,
                "scope":       incident_scope,
            },
        )

    await db.commit()
    return incident_id


async def _resolve_incident(db: AsyncSession, incident_id: str) -> None:
    """Set resolved_at = NOW() on a single incident and commit."""
    # Fetch title/category before updating so we can write a descriptive event
    inc = await _exec_one(db,
        "SELECT title, category, affected_ip::text AS affected_ip "
        "FROM network_incidents WHERE id = :id::uuid",
        {"id": incident_id})
    await _exec(db,
        "UPDATE network_incidents SET resolved_at = NOW() WHERE id = :id::uuid",
        {"id": incident_id})
    if inc:
        await _write_event(
            db,
            "incident_resolved",
            device_ip=inc.get("affected_ip"),
            incident_id=incident_id,
            description=f"Resolved: {inc.get('title', '')}",
            metadata={"category": inc.get("category")},
        )
    await db.commit()


async def _resolve_incidents_batch(db: AsyncSession, incident_ids: list[str]) -> None:
    """
    Resolve multiple incidents in a single UPDATE ... WHERE id = ANY(:ids::uuid[]).

    Uses a typed ARRAY bindparam so asyncpg receives a properly typed uuid[]
    without needing to embed values in the SQL string.
    Falls back to individual resolves if the array approach fails (e.g. on SQLite).
    """
    if not incident_ids:
        return
    from sqlalchemy import bindparam
    from sqlalchemy.dialects.postgresql import ARRAY, UUID as PGUUID

    # Fetch incident details before resolving so we can write events
    inc_rows = await _exec(db,
        "SELECT id::text AS id, title, category, "
        "affected_ip::text AS affected_ip "
        "FROM network_incidents WHERE id = ANY(:ids::uuid[])",
        {"ids": incident_ids})
    inc_by_id = {r["id"]: r for r in inc_rows}

    try:
        stmt = text(
            "UPDATE network_incidents SET resolved_at = NOW() WHERE id = ANY(:ids)"
        ).bindparams(bindparam("ids", type_=ARRAY(PGUUID(as_uuid=False))))
        await db.execute(stmt, {"ids": incident_ids})
        for incident_id in incident_ids:
            inc = inc_by_id.get(incident_id, {})
            await _write_event(
                db,
                "incident_resolved",
                device_ip=inc.get("affected_ip"),
                incident_id=incident_id,
                description=f"Resolved: {inc.get('title', '')}",
                metadata={"category": inc.get("category")},
            )
        await db.commit()
    except Exception:
        logger.exception("Batch incident resolve failed — falling back to individual resolves")
        await db.rollback()
        for incident_id in incident_ids:
            await _resolve_incident(db, incident_id)


async def _get_open_global_incident(
    db: AsyncSession, root_cause: str
) -> dict | None:
    """
    Return the most recent open global incident with the given root_cause.
    Used to deduplicate global incidents — ONE open incident per root_cause.
    """
    return await _exec_one(db, """
        SELECT id::text AS id, title, severity, started_at, evidence
        FROM network_incidents
        WHERE resolved_at IS NULL
          AND incident_scope = 'global'
          AND root_cause = :root_cause
        ORDER BY started_at DESC LIMIT 1
    """, {"root_cause": root_cause})


async def _update_global_incident_targets(
    db: AsyncSession, incident_id: str, affected_ips: list[str]
) -> None:
    """Update the evidence.affected_ips list on an existing global incident."""
    await _exec(db, """
        UPDATE network_incidents
        SET evidence = jsonb_set(
            COALESCE(evidence, '{}'::jsonb),
            '{affected_ips}',
            :targets::jsonb
        )
        WHERE id = :id::uuid
    """, {"id": incident_id, "targets": json.dumps(sorted(affected_ips))})
    await db.commit()


# ── WAN reachability helpers ───────────────────────────────────────────────────

async def _tcp_connect_rtt(ip: str) -> dict:
    """
    Measure reachability and RTT for a single IP using TCP connect.

    Tries port 80 first (more likely to be open or at least refused on routers),
    then port 443 as a fallback.  No raw sockets — works without CAP_NET_RAW.

    Reachability rules:
      ConnectionRefusedError (TCP RST) on any port
          → reachable, rtt = SYN→RST time, packet_loss = 0 %
            A router/firewall that sends RST is provably up.

      asyncio.TimeoutError on a port
          → no response within 2 s; try the next port.
            If BOTH ports time out → 100 % packet loss, rtt = None.

      OSError (ENETUNREACH, EHOSTUNREACH, etc.)
          → local routing failure; try next port.
            Both failing this way also → 100 % packet loss.
    """
    for port in (80, 443):
        t0 = asyncio.get_event_loop().time()
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port),
                timeout=2.0,
            )
            rtt_ms = (asyncio.get_event_loop().time() - t0) * 1000
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), timeout=1.0)
            except Exception:
                pass
            return {"rtt_ms": round(rtt_ms, 2), "packet_loss_pct": 0.0}
        except ConnectionRefusedError:
            # RST received — host is up, just no service on this port
            rtt_ms = (asyncio.get_event_loop().time() - t0) * 1000
            return {"rtt_ms": round(rtt_ms, 2), "packet_loss_pct": 0.0}
        except asyncio.TimeoutError:
            continue  # no response — try the other port
        except OSError:
            continue  # routing/network error — try the other port
    return {"rtt_ms": None, "packet_loss_pct": 100.0}


async def _ping_and_store_wan_targets(db: AsyncSession) -> None:
    """
    Step 0 (runs before all checks): probe WAN gateways and external DNS via
    TCP connect, write results to latency_metrics with the correct target_type.

    Uses asyncio.open_connection() on port 443/80 — no raw sockets, no fping,
    no CAP_NET_RAW capability required.

    This feeds _check_wan_loss and _check_internal_latency — without this
    function those checks would always find an empty latency_metrics for
    WAN/external IPs.

    target_type mapping:
      WAN1_GATEWAY_IP / WAN2_GATEWAY_IP → 'wan'
      1.1.1.1 / 8.8.8.8                → 'dns'
    """
    wan1       = settings.WAN1_GATEWAY_IP.strip()
    wan2       = settings.WAN2_GATEWAY_IP.strip()
    wan_legacy = settings.WAN_GATEWAY_IP.strip()

    ip_type: dict[str, str] = {}   # ip → target_type enum value
    ip_name: dict[str, str] = {}   # ip → human-readable target_name

    if wan1:
        ip_type[wan1] = "wan"
        ip_name[wan1] = f"WAN1 Gateway ({wan1})"
    if wan2:
        ip_type[wan2] = "wan"
        ip_name[wan2] = f"WAN2 Gateway ({wan2})"
    if wan_legacy and not wan1 and not wan2:
        ip_type[wan_legacy] = "wan"
        ip_name[wan_legacy] = f"WAN Gateway ({wan_legacy})"
    ip_type[_IP_DNS_CF]     = "dns"
    ip_name[_IP_DNS_CF]     = "Cloudflare DNS (1.1.1.1)"
    ip_type[_IP_DNS_GOOGLE] = "dns"
    ip_name[_IP_DNS_GOOGLE] = "Google DNS (8.8.8.8)"

    all_ips = list(ip_type.keys())
    if not all_ips:
        return

    global _wan_probe_cycle
    _wan_probe_cycle += 1
    if _wan_probe_cycle <= _WAN_PROBE_GRACE_CYCLES:
        logger.info(
            "WAN probe grace period: skipping cycle %d/%d to avoid "
            "startup false-positives",
            _wan_probe_cycle, _WAN_PROBE_GRACE_CYCLES,
        )
        return

    # Probe all targets concurrently — each takes up to ~4 s (2×2 s port timeouts)
    probe_results: list[dict] = await asyncio.gather(
        *[_tcp_connect_rtt(ip) for ip in all_ips],
        return_exceptions=False,
    )
    results: dict[str, dict] = dict(zip(all_ips, probe_results))

    now = datetime.now(timezone.utc)
    stored = 0
    for ip in all_ips:
        stats = results[ip]
        try:
            await db.execute(text("""
                INSERT INTO latency_metrics
                    (time, target_name, target_ip, target_type, rtt_ms, packet_loss_pct)
                VALUES
                    (:time, :name, CAST(:ip AS INET), :ttype, :rtt_ms, :loss)
            """), {
                "time":  now,
                "name":  ip_name[ip],
                "ip":    ip,
                "ttype": ip_type[ip],
                "rtt_ms": stats["rtt_ms"],
                "loss":  stats["packet_loss_pct"],
            })
            stored += 1
        except Exception as exc:
            logger.error("Failed to store WAN probe result for %s: %s", ip, exc)
            await db.rollback()
    await db.commit()
    logger.info(
        "WAN probe cycle complete: %d/%d targets stored "
        "(loss=[%s])",
        stored, len(all_ips),
        ", ".join(
            f"{ip}:{results[ip]['packet_loss_pct']:.0f}%"
            for ip in all_ips
        ),
    )


# ── Individual checks ─────────────────────────────────────────────────────────

async def _check_wan_loss(db: AsyncSession) -> None:
    """
    Check 1: Per-target WAN packet loss with consecutive-cycle guard.

    An incident opens only after _WAN_LOSS_CONSECUTIVE_THRESHOLD (3) consecutive
    60-second cycles where a target's packet_loss_pct exceeds _WAN_LOSS_PCT_THRESHOLD
    (50%).  A single stray packet loss is logged but creates no incident.

    Auto-resolve requires _GLOBAL_RECOVER_THRESHOLD (3) consecutive clean cycles
    across all affected targets.

    The incident is scoped 'global' with a root_cause classified from the set of
    currently-down external targets (same logic as _check_internal_latency).
    """
    global _wan_loss_consecutive, _wan_loss_recover

    wan1 = settings.WAN1_GATEWAY_IP.strip()
    wan2 = settings.WAN2_GATEWAY_IP.strip()
    wan_legacy = settings.WAN_GATEWAY_IP.strip()

    # External targets the Railway backend is responsible for monitoring.
    external_ips = list(dict.fromkeys(filter(None, [
        wan1, wan2,
        wan_legacy if wan_legacy and not wan1 and not wan2 else None,
        _IP_DNS_CF, _IP_DNS_GOOGLE,
    ])))
    if not external_ips:
        return

    # Query per-target avg packet loss for the most recent 2-minute window.
    rows = await _exec(db, """
        SELECT target_ip::text AS ip, AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE time > NOW() - INTERVAL '2 minutes'
          AND packet_loss_pct IS NOT NULL
        GROUP BY target_ip
        HAVING target_ip::text = ANY(:ips)
    """, {"ips": external_ips})

    loss_by_ip: dict[str, float] = {
        r["ip"]: float(r["avg_loss"])
        for r in rows
        if r["ip"] is not None and r["avg_loss"] is not None
    }

    if not loss_by_ip:
        return  # No WAN latency data yet — collector not pinging external targets

    # Update consecutive counts; build the set of confirmed-down IPs.
    confirmed_down: set[str] = set()
    for ip in external_ips:
        loss = loss_by_ip.get(ip)
        if loss is not None and loss > _WAN_LOSS_PCT_THRESHOLD:
            _wan_loss_consecutive[ip] = _wan_loss_consecutive.get(ip, 0) + 1
            _wan_loss_recover[ip] = 0
            cycle = _wan_loss_consecutive[ip]
            if cycle >= _WAN_LOSS_CONSECUTIVE_THRESHOLD:
                confirmed_down.add(ip)
            else:
                logger.debug(
                    "WAN packet loss on %s: %.1f%% (cycle %d/%d — not yet incident)",
                    ip, loss, cycle, _WAN_LOSS_CONSECUTIVE_THRESHOLD,
                )
        else:
            _wan_loss_consecutive[ip] = 0
            _wan_loss_recover[ip] = _wan_loss_recover.get(ip, 0) + 1

    if confirmed_down:
        root_cause = _classify_root_cause(confirmed_down)
        rc_label   = _ROOT_CAUSE_LABELS.get(root_cause, root_cause)

        # Dedup: one open global incident per root_cause.
        open_inc = await _get_open_global_incident(db, root_cause)
        if open_inc:
            # Update evidence with the current affected IPs list.
            await _update_global_incident_targets(
                db, open_inc["id"], list(confirmed_down)
            )
            return

        # Also check for any open wan_issue global incident (root_cause may have changed).
        any_open = await _exec_one(db, """
            SELECT id::text AS id FROM network_incidents
            WHERE resolved_at IS NULL AND category = 'wan_issue' AND incident_scope = 'global'
            ORDER BY started_at DESC LIMIT 1
        """)
        if any_open:
            return  # Existing incident; don't create a second one

        if await _recently_resolved(db, "wan_issue"):
            return

        affected_list = sorted(confirmed_down)
        await _create_incident(
            db,
            severity="high",
            category="wan_issue",
            title=f"WAN outage [{root_cause}]: {', '.join(affected_list)}",
            description=(
                f"Root cause: {rc_label}. "
                f"Targets with >{_WAN_LOSS_PCT_THRESHOLD:.0f}% packet loss "
                f"for {_WAN_LOSS_CONSECUTIVE_THRESHOLD} consecutive cycles: "
                f"{', '.join(affected_list)}."
            ),
            evidence={"affected_ips": affected_list, "root_cause": root_cause},
            root_cause=root_cause,
            incident_scope="global",
            affected_component=root_cause,
        )
        link = _investigate_link()
        msg  = f"🔴 WAN outage [{root_cause}]: {rc_label}. Affected: {', '.join(affected_list)}"
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(msg, dedup_key=f"wan_issue:{root_cause}")
        logger.warning("WAN outage incident opened [%s]: %s", root_cause, ", ".join(affected_list))

    else:
        # Auto-resolve: all external IPs we have data for have been clean for N cycles.
        open_inc = await _exec_one(db, """
            SELECT id::text AS id, title FROM network_incidents
            WHERE resolved_at IS NULL AND category = 'wan_issue' AND incident_scope = 'global'
            ORDER BY started_at DESC LIMIT 1
        """)
        if not open_inc:
            return

        known_ips = [ip for ip in external_ips if ip in loss_by_ip]
        all_recovered = known_ips and all(
            _wan_loss_recover.get(ip, 0) >= _GLOBAL_RECOVER_THRESHOLD
            for ip in known_ips
        )
        if all_recovered:
            await _resolve_incident(db, open_inc["id"])
            await _send_telegram(f"✅ Resolved: {open_inc['title']}")
            logger.info("WAN outage resolved")


async def _check_interface_errors(db: AsyncSession) -> None:
    """
    Check 2: Ports with significant RX errors in the last 5 minutes.

    Primary threshold: error_rate = (rx_errors / rx_bytes) * 100 > 0.1%
    with at least 1 MB of traffic in the window (avoids false positives
    on idle ports where a handful of errors creates an inflated rate).

    Fallback (for ports with very low traffic): raw rx_errors > 50,
    matching the original behaviour.
    """
    error_ports = await _exec(db, """
        SELECT switch_id, switch_name, port_id, port_name, device_name,
               device_ip::text AS device_ip,
               SUM(rx_errors)  AS total_rx_errors,
               SUM(rx_bytes)   AS total_rx_bytes,
               CASE
                   WHEN SUM(rx_bytes) > :min_bytes AND SUM(rx_bytes) > 0
                   THEN (SUM(rx_errors)::float / SUM(rx_bytes)) * 100
                   ELSE NULL
               END AS error_rate_pct
        FROM switch_port_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
        GROUP BY switch_id, switch_name, port_id, port_name, device_name, device_ip
        HAVING
            (SUM(rx_bytes) > :min_bytes AND SUM(rx_bytes) > 0
             AND (SUM(rx_errors)::float / SUM(rx_bytes)) * 100 > :rate_threshold)
            OR
            (SUM(rx_bytes) <= :min_bytes AND SUM(rx_errors) > :raw_threshold)
    """, {
        "min_bytes":     _PORT_MIN_BYTES,
        "rate_threshold": _PORT_ERROR_RATE_MED,
        "raw_threshold":  _PORT_ERROR_THRESHOLD,
    })

    erroring_keys = {(r["switch_id"], r["port_id"]) for r in error_ports}

    # Auto-resolve ports that are no longer erroring — batch all resolves into one UPDATE
    open_incs = await _exec(db, """
        SELECT id::text AS id, title, affected_switch, affected_port
        FROM network_incidents
        WHERE category = 'interface_error' AND resolved_at IS NULL
    """)
    to_resolve = [
        inc for inc in open_incs
        if (inc.get("affected_switch"), inc.get("affected_port")) not in erroring_keys
    ]
    if to_resolve:
        await _resolve_incidents_batch(db, [inc["id"] for inc in to_resolve])
        for inc in to_resolve:
            await _send_telegram(f"✅ Resolved: {inc['title']}")
            logger.info("Interface error resolved: %s / %s",
                        inc.get("affected_switch"), inc.get("affected_port"))

    # Open new incidents for newly erroring ports
    for row in error_ports:
        switch_id   = row["switch_id"]
        port_id     = row["port_id"]
        switch_name = row.get("switch_name") or switch_id
        device_name = row.get("device_name") or "unknown device"
        rx_errors   = int(row["total_rx_errors"])

        if await _get_open_incident(db, "interface_error",
                                    affected_switch=switch_id, affected_port=port_id):
            continue
        if await _recently_resolved(db, "interface_error",
                                    affected_switch=switch_id, affected_port=port_id):
            continue

        device_ip    = row.get("device_ip") or None
        hostname     = device_name  # device_name from switch_port_metrics
        error_rate   = row.get("error_rate_pct")
        rx_bytes_val = int(row.get("total_rx_bytes") or 0)

        evidence_dict: dict = {
            "rx_errors":    rx_errors,
            "device_name":  hostname,
            "likely_cause": "cable_or_nic",
        }
        if error_rate is not None:
            evidence_dict["error_rate_pct"] = round(float(error_rate), 6)
            evidence_dict["rx_bytes"] = rx_bytes_val

        if error_rate is not None:
            rate_str = f"{float(error_rate):.4f}% error rate"
            desc_detail = f"error rate {float(error_rate):.4f}%"
        else:
            rate_str = f"{rx_errors:,} RX errors (low-traffic port)"
            desc_detail = f"{rx_errors:,} RX errors"

        await _create_incident(
            db,
            severity="medium",
            category="interface_error",
            title=f"Interface errors on {switch_name} / {port_id} ({hostname})",
            description=(
                f"Port {port_id} on {switch_name} reported {desc_detail} "
                f"in the last 5 minutes. Likely a cable or NIC fault."
            ),
            affected_ip=device_ip,
            affected_switch=switch_id,
            affected_port=port_id,
            evidence=evidence_dict,
        )
        link = _investigate_link(device_ip)
        msg = (
            f"⚠️ Cable or NIC issue: {hostname} on Port {port_id}. "
            f"{rate_str}. "
            f"Inspect cable at switch {switch_name} / Port {port_id}."
        )
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(
            msg, dedup_key=f"interface_error:{device_ip or switch_id+':'+str(port_id)}"
        )
        logger.warning("Interface error incident opened: %s / %s", switch_id, port_id)


_ALERTABLE_DEVICE_TYPES = {"server", "ap"}   # always create incident + telegram


async def _check_devices_offline(db: AsyncSession) -> None:
    """
    Check 3: Devices still marked is_online=true whose last_seen is stale.

    ALL stale devices are marked is_online=false in device_registry.
    Only devices matching these criteria generate an incident and Telegram alert:
      - device_type IN ('server', 'ap')   — critical infrastructure
      - is_critical = true                — manually flagged by operators

    Workstations, laptops, phones, and unknown devices are silently updated.
    """
    stale = await _exec(db, f"""
        SELECT ip::text AS ip, hostname, last_seen,
               device_type,
               COALESCE(is_critical, false) AS is_critical
        FROM device_registry
        WHERE is_online = true
          AND last_seen < NOW() - INTERVAL '{_DEVICE_STALE_MINUTES} minutes'
    """)

    for device in stale:
        ip          = device["ip"]
        hostname    = device.get("hostname") or ip
        device_type = device.get("device_type") or "unknown"
        is_critical = bool(device.get("is_critical"))

        # Always mark offline
        await _exec(db,
            "UPDATE device_registry SET is_online = false WHERE ip::text = :ip",
            {"ip": ip})
        await _write_event(
            db,
            "device_offline",
            device_ip=ip,
            description=f"{hostname} ({ip}) went offline",
            metadata={"device_type": device_type, "hostname": hostname},
        )
        await db.commit()

        # Only alert for critical infrastructure and manually flagged devices
        if device_type not in _ALERTABLE_DEVICE_TYPES and not is_critical:
            logger.debug("Device offline (no alert — type=%s): %s (%s)",
                         device_type, hostname, ip)
            continue

        # Dedup by root_cause — one open DEVICE_OFFLINE incident per IP.
        # Mirrors the global WAN incident dedup pattern.  If an open incident
        # already exists, update its evidence timestamp and skip creation so we
        # don't generate a new row every 60-second cycle while the device stays
        # offline.
        open_device_inc = await _exec_one(db, """
            SELECT id::text AS id FROM network_incidents
            WHERE resolved_at IS NULL
              AND root_cause = 'DEVICE_OFFLINE'
              AND affected_ip::text = :ip
            LIMIT 1
        """, {"ip": ip})
        if open_device_inc:
            await _exec(db, """
                UPDATE network_incidents
                SET evidence = jsonb_set(
                    COALESCE(evidence, '{}'::jsonb),
                    '{last_offline_seen_at}',
                    to_jsonb(NOW()::text)
                )
                WHERE id = :id::uuid
            """, {"id": open_device_inc["id"]})
            await db.commit()
            continue

        # Fallback dedup for legacy incidents created before root_cause was added.
        if await _get_open_incident(db, "device_offline", affected_ip=ip):
            continue
        if await _recently_resolved(db, "device_offline", affected_ip=ip):
            continue

        last_seen_val = device.get("last_seen")
        last_seen_str = (
            last_seen_val.isoformat()
            if isinstance(last_seen_val, datetime)
            else str(last_seen_val)
        )
        await _create_incident(
            db,
            severity="high" if device_type == "server" else "medium",
            category="device_offline",
            title=f"{hostname} ({ip}) went offline",
            description=(
                f"{hostname} [{device_type}] at {ip} has not been seen for over "
                f"{_DEVICE_STALE_MINUTES} minutes. Last seen: {last_seen_str}."
            ),
            affected_ip=ip,
            root_cause="DEVICE_OFFLINE",
            incident_scope="device",
            evidence={"last_seen": last_seen_str, "device_type": device_type},
        )
        link = _investigate_link(ip)
        msg = f"📴 {hostname} ({ip}) [{device_type}] went offline."
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(msg, dedup_key=f"device_offline:{ip}")
        logger.warning("Device offline (alert sent): %s (%s) [%s]", hostname, ip, device_type)

    # Auto-resolve incidents for devices that have come back online.
    # Fetch ALL currently fresh-online IPs in one query, then check membership
    # in Python — avoids one DB roundtrip per open incident.
    open_incs = await _exec(db, """
        SELECT id::text AS id, title, affected_ip::text AS affected_ip
        FROM network_incidents
        WHERE category = 'device_offline' AND resolved_at IS NULL
    """)
    if open_incs:
        fresh_rows = await _exec(db,
            f"SELECT ip::text AS ip FROM device_registry "
            f"WHERE is_online = true "
            f"AND last_seen > NOW() - INTERVAL '{_DEVICE_STALE_MINUTES} minutes'")
        fresh_online_ips: set[str] = {r["ip"] for r in fresh_rows}

        to_resolve = [
            inc for inc in open_incs
            if inc.get("affected_ip") and inc["affected_ip"] in fresh_online_ips
        ]
        if to_resolve:
            await _resolve_incidents_batch(db, [inc["id"] for inc in to_resolve])
            for inc in to_resolve:
                came_online_ip = inc["affected_ip"]
                await _write_event(
                    db,
                    "device_online",
                    device_ip=came_online_ip,
                    description=f"Device came back online: {came_online_ip}",
                )
                await _send_telegram(f"✅ Resolved: {inc['title']}")
                logger.info("Device came back online: %s", came_online_ip)
            await db.commit()


def _classify_root_cause(affected: set[str]) -> str:
    """Map the set of latency-spiking IPs to a root-cause label."""
    wan1          = settings.WAN1_GATEWAY_IP.strip()
    wan2          = settings.WAN2_GATEWAY_IP.strip()
    wan_legacy    = settings.WAN_GATEWAY_IP.strip()

    wan1_hit      = bool(wan1 and wan1 in affected)
    wan2_hit      = bool(wan2 and wan2 in affected)
    wan_legacy_hit = bool(wan_legacy and wan_legacy in affected and wan_legacy not in (wan1, wan2))
    any_wan_hit   = wan1_hit or wan2_hit or wan_legacy_hit

    all_wan_ips   = {ip for ip in (wan1, wan2, wan_legacy) if ip}
    internals_hit = _INTERNAL_IPS & affected
    dns_hit       = _EXTERNAL_DNS & affected
    all_external  = _EXTERNAL_DNS | all_wan_ips

    # FULL_OUTAGE — all known targets spike simultaneously
    if (_INTERNAL_IPS <= affected) and (not all_external or all_external <= affected):
        return "FULL_OUTAGE"

    # Dual-WAN site: distinguish per-uplink failures
    if wan1 and wan2:
        # WAN_ISP — both uplinks + all external DNS spike, internals OK
        if wan1_hit and wan2_hit and dns_hit == _EXTERNAL_DNS and not internals_hit:
            return "WAN_ISP"
        # WAN1_DOWN — primary uplink + all DNS spike, WAN2 not affected, internals OK
        if wan1_hit and not wan2_hit and dns_hit == _EXTERNAL_DNS and not internals_hit:
            return "WAN1_DOWN"
        # WAN2_DOWN — secondary uplink spikes, WAN1 not affected, internals OK
        if wan2_hit and not wan1_hit and not internals_hit:
            return "WAN2_DOWN"
    else:
        # Single-WAN (legacy WAN_GATEWAY_IP): WAN gateway + all DNS spike, internals OK
        if dns_hit == _EXTERNAL_DNS and any_wan_hit and not internals_hit:
            return "WAN_ISP"

    # WAN_LINE — a WAN gateway spikes but external DNS OK and internals OK
    # (physical fault between CPE and pfSense, not ISP-side)
    if any_wan_hit and not dns_hit and not internals_hit:
        return "WAN_LINE"

    # ALL_INTERNAL — all four internal IPs spike, no external
    if _INTERNAL_IPS <= affected and not dns_hit and not any_wan_hit:
        return "ALL_INTERNAL"

    # PFSENSE — only LAN gateway spikes
    if affected == {_IP_LAN_GW}:
        return "PFSENSE"

    # DC_PRIMARY — primary DC spikes; LAN gateway + secondary DC not affected
    if (
        _IP_DC_PRIMARY in affected
        and _IP_LAN_GW not in affected
        and _IP_DC_SECONDARY not in affected
        and not dns_hit and not any_wan_hit
    ):
        return "DC_PRIMARY"

    # DC_SECONDARY — secondary DC alone
    if affected == {_IP_DC_SECONDARY}:
        return "DC_SECONDARY"

    # VLAN2_DC — VLAN 2 DC spikes; VLAN 1 targets OK
    if (
        _IP_VLAN2_DC in affected
        and not ({_IP_LAN_GW, _IP_DC_PRIMARY, _IP_DC_SECONDARY} & affected)
        and not dns_hit and not any_wan_hit
    ):
        return "VLAN2_DC"

    return "UNKNOWN"


async def _check_internal_latency(db: AsyncSession) -> None:
    """
    Check 4: Per-target latency spike detection with consecutive-count guard.

    Polls all static latency targets merged with configured WAN gateway IPs.
    An alert fires only after _LATENCY_CONSECUTIVE_THRESHOLD (3) consecutive
    60-second readings above _LATENCY_THRESHOLD_MS (50 ms) for a given target.
    After a target recovers, a _LATENCY_COOLDOWN_MINUTES (10 min) cooldown
    prevents re-alerting immediately on the next transient spike.
    Root cause is classified from the set of currently alerting IPs.
    """
    now = datetime.now(timezone.utc)

    # Merge static targets with configured WAN gateways
    targets: dict[str, str] = dict(_LATENCY_TARGET_ROLES)
    wan1 = settings.WAN1_GATEWAY_IP.strip()
    wan2 = settings.WAN2_GATEWAY_IP.strip()
    if wan1:
        targets[wan1] = "WAN1 Gateway (Primary ISP)"
    if wan2:
        targets[wan2] = "WAN2 Gateway (Secondary ISP)"
    # Legacy single-WAN env var — add only if neither WAN1 nor WAN2 is set
    wan_legacy = settings.WAN_GATEWAY_IP.strip()
    if wan_legacy and not wan1 and not wan2:
        targets[wan_legacy] = "WAN Gateway (ISP)"

    # Query avg RTT per target IP over the last 3 minutes
    rows = await _exec(db, """
        SELECT target_ip::text AS ip, AVG(rtt_ms) AS avg_rtt
        FROM latency_metrics
        WHERE time > NOW() - INTERVAL '3 minutes'
          AND rtt_ms IS NOT NULL
        GROUP BY target_ip
    """)
    rtt_by_ip: dict[str, float] = {
        r["ip"]: float(r["avg_rtt"])
        for r in rows
        if r["ip"] is not None and r["avg_rtt"] is not None
    }

    # Update per-target consecutive counts; collect currently alerting IPs
    alerting: dict[str, float] = {}   # ip → avg_rtt (met threshold for N consecutive reads)
    for ip in targets:
        rtt = rtt_by_ip.get(ip)
        if rtt is not None and rtt > _LATENCY_THRESHOLD_MS:
            _latency_consecutive[ip] = _latency_consecutive.get(ip, 0) + 1
            _latency_recover_consecutive[ip] = 0
            if _latency_consecutive[ip] >= _LATENCY_CONSECUTIVE_THRESHOLD:
                cooldown_until = _latency_cooldown.get(ip)
                if cooldown_until is None or now >= cooldown_until:
                    alerting[ip] = rtt
        else:
            prev_count = _latency_consecutive.get(ip, 0)
            _latency_consecutive[ip] = 0
            _latency_recover_consecutive[ip] = _latency_recover_consecutive.get(ip, 0) + 1
            if prev_count >= _LATENCY_CONSECUTIVE_THRESHOLD:
                # Was alerting — start post-resolve cooldown
                _latency_cooldown[ip] = now + timedelta(minutes=_LATENCY_COOLDOWN_MINUTES)

    open_inc = await _get_open_incident(db, "internal_latency")
    if open_inc is None:
        # Fallback: find any open internal_latency incident regardless of affected_ip.
        # _get_open_incident adds "affected_ip IS NULL" for network-wide categories,
        # which silently misses legacy incidents created with affected_ip set (e.g.
        # incidents opened before the multi-target refactor that stored the gateway IP).
        open_inc = await _exec_one(db, """
            SELECT id::text AS id, title, severity, started_at,
                   incident_scope
            FROM network_incidents
            WHERE resolved_at IS NULL AND category = 'internal_latency'
            ORDER BY started_at DESC LIMIT 1
        """)

    global _global_latency_recover_consecutive

    if alerting:
        _global_latency_recover_consecutive = 0  # reset recovery counter whenever something is still alerting

        root_cause = _classify_root_cause(set(alerting))
        rc_label   = _ROOT_CAUSE_LABELS.get(root_cause, root_cause)
        is_global  = root_cause in _GLOBAL_ROOT_CAUSES

        if is_global:
            # Global incidents: dedup by root_cause across all categories.
            global_inc = await _get_open_global_incident(db, root_cause)
            if global_inc:
                await _update_global_incident_targets(
                    db, global_inc["id"], list(alerting.keys())
                )
                return
            # Also check the old-style open_inc (same category, any scope).
            if open_inc:
                return

            if await _recently_resolved(db, "internal_latency"):
                return

            max_consec   = max(_latency_consecutive.get(ip, 0) for ip in alerting)
            affected_ip  = None  # global incidents have no single affected_ip
        else:
            # Device-scoped incident: use the IP of the affected device.
            affected_ip = _ROOT_CAUSE_IP.get(root_cause)
            if open_inc:
                return  # Already tracking this device incident

            if await _recently_resolved(db, "internal_latency", affected_ip=affected_ip):
                return

            max_consec = max(_latency_consecutive.get(ip, 0) for ip in alerting)

        await _create_incident(
            db,
            severity="high",
            category="internal_latency",
            title=f"Latency spike [{root_cause}]: {', '.join(sorted(alerting))}",
            description=(
                f"Root cause: {rc_label}. "
                f"Targets: {', '.join(f'{ip} ({targets[ip]})' for ip in sorted(alerting))}. "
                f"Peak RTT: {max(alerting.values()):.1f} ms. "
                f"Consecutive readings: {max_consec}."
            ),
            affected_ip=affected_ip,
            evidence={
                "root_cause":   root_cause,
                "targets":      {ip: round(rtt, 2) for ip, rtt in alerting.items()},
                "threshold_ms": _LATENCY_THRESHOLD_MS,
                "consecutive":  max_consec,
            },
            root_cause=root_cause,
            incident_scope="global" if is_global else "device",
            affected_component=root_cause,
        )

        # Timeline event for each spiking target
        for spike_ip, spike_rtt in alerting.items():
            await _write_event(
                db,
                "latency_spike",
                target_ip=spike_ip,
                device_ip=affected_ip,
                description=(
                    f"Latency spike on {spike_ip} ({targets.get(spike_ip, '')}): "
                    f"{spike_rtt:.1f} ms (threshold {_LATENCY_THRESHOLD_MS:.0f} ms)"
                ),
                metadata={
                    "target_ip":    spike_ip,
                    "rtt_ms":       round(spike_rtt, 2),
                    "root_cause":   root_cause,
                    "consecutive":  _latency_consecutive.get(spike_ip, 0),
                },
            )
        await db.commit()

        tg_lines = [f"🔴 ALERT — {rc_label}", "Targets affected:"]
        for ip, rtt in sorted(alerting.items()):
            tg_lines.append(
                f"  Latency: {ip} ({targets[ip]}) = {rtt:.1f} ms"
                f"  [threshold: {_LATENCY_THRESHOLD_MS:.0f} ms]"
            )
        tg_lines.append(f"Consecutive readings: {max_consec}")
        tg_lines.append(f"Time: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")

        link = _investigate_link(affected_ip)
        msg  = "\n".join(tg_lines)
        if link:
            msg += f"\n{link}"

        dedup_key = f"internal_latency:{root_cause}" if is_global else f"internal_latency:{affected_ip or root_cause}"
        await _rate_limited_telegram(msg, dedup_key=dedup_key)
        logger.warning(
            "Latency spike incident opened [%s, scope=%s]: %s",
            root_cause,
            "global" if is_global else "device",
            ", ".join(f"{ip}={rtt:.1f}ms" for ip, rtt in sorted(alerting.items())),
        )

    elif open_inc:
        # Determine if the open incident is global.
        open_scope = open_inc.get("incident_scope", "device") if isinstance(open_inc, dict) else "device"
        # If we can't read incident_scope from the dict (legacy row), treat as device.
        is_open_global = (open_scope == "global")

        if is_open_global:
            # Global incidents require _GLOBAL_RECOVER_THRESHOLD consecutive clean cycles
            # before auto-resolving, to avoid flapping on brief recoveries.
            _global_latency_recover_consecutive += 1
            if _global_latency_recover_consecutive < _GLOBAL_RECOVER_THRESHOLD:
                logger.debug(
                    "Global latency incident recovery cycle %d/%d — not yet resolving",
                    _global_latency_recover_consecutive, _GLOBAL_RECOVER_THRESHOLD,
                )
                return

        _global_latency_recover_consecutive = 0
        await _resolve_incident(db, open_inc["id"])

        # Suppress the resolve Telegram if:
        #   (a) the last alert was sent within the cooldown window, AND
        #   (b) fewer than 2 consecutive below-threshold readings have been
        #       recorded — i.e., this may be a brief dip, not a true recovery.
        prev_alert_time = _tg_sent_keys.get("internal_latency")
        within_cooldown = (
            prev_alert_time is not None
            and (now - prev_alert_time).total_seconds() < _LATENCY_COOLDOWN_MINUTES * 60
        )
        min_recover = min(
            (_latency_recover_consecutive.get(ip, 0) for ip in targets),
            default=2,
        )
        if within_cooldown or min_recover < 2:
            logger.info(
                "Internal latency spike resolved — Telegram suppressed "
                "(within cooldown, recover_count=%d)", min_recover,
            )
        else:
            await _send_telegram(f"✅ Resolved: {open_inc['title']}")
            logger.info("Internal latency spike resolved")


async def _check_collector_offline(db: AsyncSession) -> None:
    """
    Check 5: Collector heartbeat stale.
    Uses module-level state so Telegram is sent only on transitions,
    never once per cycle.  No incident row is created (collector availability
    is tracked separately from network infrastructure incidents).
    """
    global _collector_online_state

    row = await _exec_one(db,
        "SELECT last_seen FROM collector_heartbeat ORDER BY last_seen DESC LIMIT 1")

    if row and isinstance(row.get("last_seen"), datetime):
        cutoff    = datetime.now(timezone.utc) - timedelta(minutes=_COLLECTOR_STALE_MINUTES)
        is_online = row["last_seen"] > cutoff
    else:
        is_online = False

    if _collector_online_state is None:
        # First run — record state without alerting
        _collector_online_state = is_online
        return

    if not is_online and _collector_online_state:
        _collector_online_state = False
        await _send_telegram(
            "⚠️ STAR Collector went offline. No network data being collected."
        )
        logger.warning("Collector went offline")

    elif is_online and not _collector_online_state:
        _collector_online_state = True
        await _send_telegram("✅ STAR Collector is back online.")
        logger.info("Collector came back online")


async def _check_traffic_anomaly(db: AsyncSession) -> None:
    """
    Check 6: Device sent > 5× its 7-day per-15-min average in the last 15 minutes.
    Devices with very low historical average (< 100 KB per 15 min) are excluded
    to avoid false positives from devices that rarely transmit.
    """
    anomalies = await _exec(db, f"""
        WITH current_usage AS (
            SELECT src_ip::text AS ip,
                   SUM(bytes)   AS current_bytes
            FROM network_flows
            WHERE time > NOW() - INTERVAL '15 minutes'
            GROUP BY src_ip
        ),
        historical_avg AS (
            -- Average bytes per 15-minute window over the past 7 days
            SELECT src_ip::text AS ip,
                   SUM(bytes) / (7.0 * 24 * 4) AS avg_bytes
            FROM network_flows
            WHERE time >= NOW() - INTERVAL '7 days'
              AND time  < NOW() - INTERVAL '15 minutes'
            GROUP BY src_ip
            HAVING SUM(bytes) / (7.0 * 24 * 4) > {_TRAFFIC_HISTORY_MIN_AVG_BYTES}
        )
        SELECT c.ip,
               c.current_bytes,
               h.avg_bytes,
               ROUND((c.current_bytes::numeric / h.avg_bytes), 1) AS ratio,
               dr.hostname
        FROM current_usage c
        JOIN historical_avg h ON c.ip = h.ip
        LEFT JOIN device_registry dr ON c.ip = dr.ip::text
        WHERE c.current_bytes > h.avg_bytes * {_TRAFFIC_ANOMALY_MULTIPLIER}
        ORDER BY ratio DESC
        LIMIT 10
    """)

    anomalous_ips = {r["ip"] for r in anomalies}

    # Auto-resolve cleared anomalies
    open_incs = await _exec(db, """
        SELECT id::text AS id, title, affected_ip::text AS affected_ip
        FROM network_incidents
        WHERE category = 'traffic_anomaly' AND resolved_at IS NULL
    """)
    to_resolve = [
        inc for inc in open_incs
        if inc.get("affected_ip") not in anomalous_ips
    ]
    if to_resolve:
        await _resolve_incidents_batch(db, [inc["id"] for inc in to_resolve])
        for inc in to_resolve:
            await _send_telegram(f"✅ Resolved: {inc['title']}")
            logger.info("Traffic anomaly resolved for %s", inc.get("affected_ip"))

    # Create new incidents
    for row in anomalies:
        ip       = row["ip"]
        hostname = row.get("hostname") or ip
        ratio    = float(row["ratio"])
        current  = int(row["current_bytes"])

        if await _get_open_incident(db, "traffic_anomaly", affected_ip=ip):
            continue
        if await _recently_resolved(db, "traffic_anomaly", affected_ip=ip):
            continue

        await _create_incident(
            db,
            severity="low",
            category="traffic_anomaly",
            title=f"Traffic anomaly: {hostname} using {ratio:.1f}× normal",
            description=(
                f"{hostname} ({ip}) sent {_fmt_bytes(current)} in the last 15 minutes, "
                f"which is {ratio:.1f}× its 7-day average."
            ),
            affected_ip=ip,
            evidence={"current_bytes": current, "ratio": ratio, "hostname": hostname},
        )
        link = _investigate_link(ip)
        msg = (
            f"📊 Unusual traffic: {hostname} using {ratio:.1f}x normal data "
            f"({_fmt_bytes(current)} in 15min)."
        )
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(msg, dedup_key=f"traffic_anomaly:{ip}")
        logger.warning("Traffic anomaly opened for %s: %.1f× normal", hostname, ratio)


# ── Main loop ─────────────────────────────────────────────────────────────────

_CHECKS = [
    _ping_and_store_wan_targets,   # must run first — writes WAN data that later checks read
    _check_wan_loss,
    _check_interface_errors,
    _check_devices_offline,
    _check_internal_latency,
    _check_collector_offline,
    _check_traffic_anomaly,
]


async def run_network_checks() -> None:
    """
    Entry point: started as an asyncio background task in main.py lifespan.
    Sleeps 60 seconds between cycles.  Each check runs in its own DB session
    so that a failure in one does not affect the others.
    """
    wan1       = settings.WAN1_GATEWAY_IP.strip()
    wan2       = settings.WAN2_GATEWAY_IP.strip()
    wan_legacy = settings.WAN_GATEWAY_IP.strip()

    wan_ips: list[str] = list(filter(None, [wan1, wan2]))
    if not wan_ips and wan_legacy:
        wan_ips = [wan_legacy]

    # Full list of IPs this backend will ping each cycle
    external_ping_targets = wan_ips + [_IP_DNS_CF, _IP_DNS_GOOGLE]

    logger.info(
        "Network monitor starting — %d checks registered (including WAN ping step)",
        len(_CHECKS),
    )
    logger.info(
        "WAN gateway IPs — WAN1_GATEWAY_IP=%s  WAN2_GATEWAY_IP=%s  WAN_GATEWAY_IP(legacy)=%s",
        wan1 or "(not set)",
        wan2 or "(not set)",
        wan_legacy or "(not set)",
    )
    logger.info(
        "External ping targets (written to latency_metrics each cycle): %s",
        ", ".join(external_ping_targets) if external_ping_targets else "(none configured)",
    )
    if not wan_ips:
        logger.warning(
            "No WAN gateway IPs configured — WAN packet-loss check will not fire. "
            "Set WAN1_GATEWAY_IP and/or WAN2_GATEWAY_IP in Railway environment variables."
        )

    while True:
        await asyncio.sleep(60)

        if not _IS_POSTGRES:
            continue  # Network tables only exist on PostgreSQL

        for check in _CHECKS:
            try:
                async with AsyncSessionLocal() as db:
                    await check(db)
            except Exception:
                logger.exception("Network monitor check %s failed", check.__name__)
