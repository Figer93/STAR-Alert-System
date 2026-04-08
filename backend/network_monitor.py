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
_WAN_LOSS_THRESHOLD = 5.0             # %
_LATENCY_THRESHOLD_MS = 50.0          # ms
_PORT_ERROR_THRESHOLD = 50            # RX errors per 5-min window
_TRAFFIC_ANOMALY_MULTIPLIER = 5.0     # × historical average
_TRAFFIC_HISTORY_MIN_AVG_BYTES = 102_400  # 100 KB — ignore very-low-traffic devices

# Module-level state for collector liveness (no DB row involved)
_collector_online_state: Optional[bool] = None

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
        f"SELECT id::text AS id, title, severity, started_at "
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
) -> Optional[str]:
    """
    Insert a new network_incident row and commit.
    Returns the generated UUID as a string, or None on error.

    NULL/INET casting is handled by conditional SQL fragments so that
    asyncpg never receives a typed None where a cast is specified.
    """
    ip_sql = "CAST(:affected_ip AS INET)" if affected_ip else "NULL"
    ev_sql = "CAST(:evidence AS JSONB)"   if evidence   else "NULL"

    params: dict[str, Any] = {
        "severity":        severity,
        "category":        category,
        "title":           title,
        "description":     description,
        "affected_switch": affected_switch,
        "affected_port":   affected_port,
    }
    if affected_ip:
        params["affected_ip"] = affected_ip
    if evidence:
        params["evidence"] = json.dumps(evidence)

    rows = await _exec(db, f"""
        INSERT INTO network_incidents (
            severity, category, title, description,
            affected_ip, affected_switch, affected_port,
            evidence, auto_detected
        ) VALUES (
            :severity, :category, :title, :description,
            {ip_sql}, :affected_switch, :affected_port,
            {ev_sql}, true
        )
        RETURNING id::text AS id
    """, params)
    await db.commit()
    return rows[0]["id"] if rows else None


async def _resolve_incident(db: AsyncSession, incident_id: str) -> None:
    """Set resolved_at = NOW() on the given incident and commit."""
    await _exec(db,
        "UPDATE network_incidents SET resolved_at = NOW() WHERE id::text = :id",
        {"id": incident_id})
    await db.commit()


# ── Individual checks ─────────────────────────────────────────────────────────

async def _check_wan_loss(db: AsyncSession) -> None:
    """Check 1: WAN packet loss > 5% averaged over the last 3 minutes."""
    row = await _exec_one(db, """
        SELECT AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE target_type = 'wan'
          AND time > NOW() - INTERVAL '3 minutes'
    """)
    if not row or row["avg_loss"] is None:
        return  # No collector data yet

    avg_loss = float(row["avg_loss"])
    open_inc = await _get_open_incident(db, "wan_issue")

    if avg_loss > _WAN_LOSS_THRESHOLD:
        if open_inc:
            return  # Already tracking
        if await _recently_resolved(db, "wan_issue"):
            return  # Avoid re-opening too soon

        await _create_incident(
            db,
            severity="high",
            category="wan_issue",
            title=f"WAN packet loss: {avg_loss:.1f}%",
            description=(
                f"Average WAN packet loss over the last 3 minutes: {avg_loss:.1f}%. "
                f"Internal gateway appears reachable."
            ),
            evidence={"avg_loss_pct": round(avg_loss, 2)},
        )
        link = _investigate_link()
        msg = f"🔴 WAN packet loss: {avg_loss:.1f}% — Internal network OK. Check ISP."
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(msg, dedup_key="wan_issue")
        logger.warning("WAN packet loss incident opened: %.1f%%", avg_loss)

    elif open_inc:
        await _resolve_incident(db, open_inc["id"])
        await _send_telegram(f"✅ Resolved: {open_inc['title']}")
        logger.info("WAN packet loss resolved")


async def _check_interface_errors(db: AsyncSession) -> None:
    """Check 2: Ports with more than 50 RX errors in the last 5 minutes."""
    error_ports = await _exec(db, """
        SELECT switch_id, switch_name, port_id, port_name, device_name,
               device_ip::text AS device_ip,
               SUM(rx_errors) AS total_rx_errors
        FROM switch_port_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
        GROUP BY switch_id, switch_name, port_id, port_name, device_name, device_ip
        HAVING SUM(rx_errors) > :threshold
    """, {"threshold": _PORT_ERROR_THRESHOLD})

    erroring_keys = {(r["switch_id"], r["port_id"]) for r in error_ports}

    # Auto-resolve ports that are no longer erroring
    open_incs = await _exec(db, """
        SELECT id::text AS id, title, affected_switch, affected_port
        FROM network_incidents
        WHERE category = 'interface_error' AND resolved_at IS NULL
    """)
    for inc in open_incs:
        key = (inc.get("affected_switch"), inc.get("affected_port"))
        if key not in erroring_keys:
            await _resolve_incident(db, inc["id"])
            await _send_telegram(f"✅ Resolved: {inc['title']}")
            logger.info("Interface error resolved: %s / %s", *key)

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

        device_ip   = row.get("device_ip") or None
        hostname    = device_name  # device_name from switch_port_metrics

        await _create_incident(
            db,
            severity="medium",
            category="interface_error",
            title=f"Interface errors on {switch_name} / {port_id} ({hostname})",
            description=(
                f"Port {port_id} on {switch_name} reported {rx_errors:,} RX errors "
                f"in the last 5 minutes. Likely a cable or NIC fault."
            ),
            affected_ip=device_ip,
            affected_switch=switch_id,
            affected_port=port_id,
            evidence={
                "rx_errors":      rx_errors,
                "device_name":    hostname,
                "likely_cause":   "cable_or_nic",
            },
        )
        link = _investigate_link(device_ip)
        msg = (
            f"⚠️ Cable or NIC issue: {hostname} on Port {port_id}. "
            f"{rx_errors:,} RX errors. "
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
        await db.commit()

        # Only alert for critical infrastructure and manually flagged devices
        if device_type not in _ALERTABLE_DEVICE_TYPES and not is_critical:
            logger.debug("Device offline (no alert — type=%s): %s (%s)",
                         device_type, hostname, ip)
            continue

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

        for inc in open_incs:
            ip = inc.get("affected_ip")
            if not ip:
                continue
            if ip in fresh_online_ips:
                await _resolve_incident(db, inc["id"])
                await _send_telegram(f"✅ Resolved: {inc['title']}")
                logger.info("Device came back online: %s", ip)


async def _check_internal_latency(db: AsyncSession) -> None:
    """Check 4: Average gateway RTT > 50 ms in the last 3 minutes."""
    row = await _exec_one(db, """
        SELECT AVG(rtt_ms) AS avg_rtt
        FROM latency_metrics
        WHERE target_type = 'gateway'
          AND time > NOW() - INTERVAL '3 minutes'
    """)
    if not row or row["avg_rtt"] is None:
        return

    avg_rtt  = float(row["avg_rtt"])
    open_inc = await _get_open_incident(db, "internal_latency")

    if avg_rtt > _LATENCY_THRESHOLD_MS:
        if open_inc:
            return
        if await _recently_resolved(db, "internal_latency"):
            return

        await _create_incident(
            db,
            severity="high",
            category="internal_latency",
            title=f"Internal latency spike: {avg_rtt:.1f} ms to gateway",
            description=(
                f"Average RTT to gateway over the last 3 minutes: {avg_rtt:.1f} ms. "
                f"Possible core switch congestion or cabling fault."
            ),
            evidence={"avg_rtt_ms": round(avg_rtt, 2)},
        )
        link = _investigate_link()
        msg = f"🔴 Internal latency: {avg_rtt:.1f}ms to gateway. Check core switch load."
        if link:
            msg += f"\n{link}"
        await _rate_limited_telegram(msg, dedup_key="internal_latency")
        logger.warning("Internal latency incident opened: %.1f ms", avg_rtt)

    elif open_inc:
        await _resolve_incident(db, open_inc["id"])
        await _send_telegram(f"✅ Resolved: {open_inc['title']}")
        logger.info("Internal latency resolved")


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
    for inc in open_incs:
        if inc.get("affected_ip") not in anomalous_ips:
            await _resolve_incident(db, inc["id"])
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
    logger.info("Network monitor starting — %d checks registered", len(_CHECKS))

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
