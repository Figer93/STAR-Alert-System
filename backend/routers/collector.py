"""
Collector ingest endpoints — /api/collector/*

Receives metric batches from the on-premise collector stack and writes them
to Supabase via SQLAlchemy (raw SQL — these tables have no ORM models).

All endpoints accept {"rows": [...]} and return {"accepted": N, "rejected": M}.

Timestamp validation: rows with |time - NOW()| > 86400 s (24 h) are rejected
to guard against corrupted clocks while still allowing offline-buffer backfill.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/collector", tags=["collector"])

_MAX_TIMESTAMP_DRIFT_S = 86_400  # 24 hours — allow backfill window


# ── Shared helpers ────────────────────────────────────────────────────────────

def _parse_ts(raw: Any) -> datetime | None:
    """Parse an ISO-8601 string or datetime to an aware UTC datetime."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        if raw.tzinfo is None:
            return raw.replace(tzinfo=timezone.utc)
        return raw
    try:
        s = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _ts_ok(raw: Any) -> bool:
    """Return True if the timestamp is within the allowed backfill window."""
    dt = _parse_ts(raw)
    if dt is None:
        return False
    drift = abs((datetime.now(timezone.utc) - dt).total_seconds())
    return drift <= _MAX_TIMESTAMP_DRIFT_S


def _int(val: Any) -> int | None:
    """Coerce a possibly-string numeric value to int; None if absent/null."""
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _float(val: Any) -> float | None:
    """Coerce a possibly-string numeric value to float; None if absent/null."""
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


# ── Request models ────────────────────────────────────────────────────────────

class RowsPayload(BaseModel):
    rows: list[dict[str, Any]]


class HeartbeatPayload(BaseModel):
    collector_id: str
    last_seen: str
    version: str = "0.1.0"
    sources: dict[str, Any] = {}


# ── POST /api/collector/metrics/latency ──────────────────────────────────────

@router.post("/metrics/latency")
async def ingest_latency(
    payload: RowsPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """
    Insert latency_metrics rows from the collector buffer.

    Expected fields per row:
      time, target_name, target_ip, target_type, rtt_ms, packet_loss_pct
    """
    accepted = rejected = 0

    for row in payload.rows:
        if not _ts_ok(row.get("time")):
            logger.warning(
                "Rejected latency row: timestamp out of range — %s",
                row.get("time"),
            )
            rejected += 1
            continue

        try:
            await db.execute(
                text("""
                    INSERT INTO latency_metrics
                        (time, target_name, target_ip, target_type, rtt_ms, packet_loss_pct)
                    VALUES
                        (:time, :target_name, CAST(:target_ip AS INET), :target_type,
                         :rtt_ms, :packet_loss_pct)
                """),
                {
                    "time":            _parse_ts(row.get("time")),
                    "target_name":     row.get("target_name"),
                    "target_ip":       row.get("target_ip"),
                    "target_type":     row.get("target_type", "internal"),
                    "rtt_ms":          _float(row.get("rtt_ms")),      # None on 100% loss
                    "packet_loss_pct": _float(row.get("packet_loss_pct")) or 0.0,
                },
            )
            accepted += 1
        except Exception as exc:
            logger.error("Failed to insert latency row: %s — %s", row, exc)
            rejected += 1

    try:
        await db.commit()
    except Exception as exc:
        logger.error("Failed to commit latency batch: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    return {"accepted": accepted, "rejected": rejected}


# ── POST /api/collector/metrics/ports ────────────────────────────────────────

@router.post("/metrics/ports")
async def ingest_ports(
    payload: RowsPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """
    Insert switch_port_metrics rows from the collector buffer.

    Expected fields per row:
      time, switch_id, switch_name, port_id, port_name, device_name,
      device_ip, rx_bytes, tx_bytes, rx_errors, tx_errors,
      rx_packets, tx_packets, poe_watts, is_uplink,
      rx_errors_delta, tx_errors_delta, rx_bytes_delta, tx_bytes_delta,
      is_counter_reset

    Phase 3B/3C: rows where rx/tx_errors_delta > 0 also write to
    port_error_events and network_events, and update device_registry.last_error_at.
    """
    accepted = rejected = 0

    for row in payload.rows:
        if not _ts_ok(row.get("time")):
            logger.warning(
                "Rejected port row: timestamp out of range — %s",
                row.get("time"),
            )
            rejected += 1
            continue

        rx_errors_delta = _int(row.get("rx_errors_delta")) or 0
        tx_errors_delta = _int(row.get("tx_errors_delta")) or 0
        device_ip       = row.get("device_ip") or None
        switch_id       = row.get("switch_id")
        port_id_raw     = row.get("port_id")
        port_id         = str(port_id_raw) if port_id_raw is not None else None
        device_name     = row.get("device_name")
        occurred_at     = row.get("time")

        try:
            await db.execute(
                text("""
                    INSERT INTO switch_port_metrics
                        (time, switch_id, switch_name, port_id, port_name,
                         device_name, device_ip, rx_bytes, tx_bytes,
                         rx_errors, tx_errors, rx_packets, tx_packets,
                         poe_watts, is_uplink,
                         rx_errors_delta, tx_errors_delta,
                         rx_bytes_delta, tx_bytes_delta, is_counter_reset)
                    VALUES
                        (:time, :switch_id, :switch_name, :port_id, :port_name,
                         :device_name, CAST(:device_ip AS INET), :rx_bytes, :tx_bytes,
                         :rx_errors, :tx_errors, :rx_packets, :tx_packets,
                         :poe_watts, :is_uplink,
                         :rx_errors_delta, :tx_errors_delta,
                         :rx_bytes_delta, :tx_bytes_delta, :is_counter_reset)
                """),
                {
                    "time":             _parse_ts(occurred_at),
                    "switch_id":        switch_id,
                    "switch_name":      row.get("switch_name"),
                    "port_id":          port_id,
                    "port_name":        row.get("port_name"),
                    "device_name":      device_name,
                    "device_ip":        device_ip,
                    "rx_bytes":         _int(row.get("rx_bytes")),
                    "tx_bytes":         _int(row.get("tx_bytes")),
                    "rx_errors":        _int(row.get("rx_errors")),
                    "tx_errors":        _int(row.get("tx_errors")),
                    "rx_packets":       _int(row.get("rx_packets")),
                    "tx_packets":       _int(row.get("tx_packets")),
                    "poe_watts":        _float(row.get("poe_watts")),
                    "is_uplink":        row.get("is_uplink", False),
                    "rx_errors_delta":  rx_errors_delta,
                    "tx_errors_delta":  tx_errors_delta,
                    "rx_bytes_delta":   _int(row.get("rx_bytes_delta")) or 0,
                    "tx_bytes_delta":   _int(row.get("tx_bytes_delta")) or 0,
                    "is_counter_reset": row.get("is_counter_reset", False),
                },
            )
            accepted += 1
        except Exception as exc:
            logger.error("Failed to insert port row: %s — %s", row, exc)
            rejected += 1
            continue

        # Phase 3B/3C — error event side-writes (best-effort; never fail the batch)
        if rx_errors_delta > 0 or tx_errors_delta > 0:
            try:
                # port_error_events: one row per erroring port per cycle
                await db.execute(text("""
                    INSERT INTO port_error_events
                        (switch_id, port_id, device_name, device_ip,
                         rx_errors_delta, tx_errors_delta, occurred_at)
                    VALUES
                        (:switch_id, :port_id, :device_name,
                         CAST(NULLIF(:device_ip, '') AS INET),
                         :rx_errors_delta, :tx_errors_delta, :occurred_at)
                """), {
                    "switch_id":       switch_id,
                    "port_id":         str(port_id),
                    "device_name":     device_name,
                    "device_ip":       device_ip,
                    "rx_errors_delta": rx_errors_delta,
                    "tx_errors_delta": tx_errors_delta,
                    "occurred_at":     occurred_at,
                })

                # network_events: timeline entry
                error_desc = (
                    f"Port {port_id} on switch {switch_id}: "
                    f"rx_errors_delta={rx_errors_delta}, tx_errors_delta={tx_errors_delta}"
                )
                if device_name:
                    error_desc = f"{device_name} — " + error_desc

                await db.execute(text("""
                    INSERT INTO network_events
                        (event_type, device_ip, description, metadata, occurred_at)
                    VALUES
                        ('port_error', CAST(NULLIF(:device_ip, '') AS INET),
                         :description, :metadata::jsonb, :occurred_at)
                """), {
                    "device_ip":   device_ip,
                    "description": error_desc,
                    "metadata": __import__("json").dumps({
                        "switch_id":       switch_id,
                        "port_id":         str(port_id),
                        "device_name":     device_name,
                        "rx_errors_delta": rx_errors_delta,
                        "tx_errors_delta": tx_errors_delta,
                    }),
                    "occurred_at": occurred_at,
                })

                # device_registry: update last_error_at/desc if we have a device_ip
                if device_ip:
                    await db.execute(text("""
                        UPDATE device_registry
                           SET last_error_at   = :occurred_at,
                               last_error_desc = :desc
                         WHERE ip::text = :ip
                           AND (last_error_at IS NULL OR last_error_at < :occurred_at)
                    """), {
                        "ip":         device_ip,
                        "occurred_at": occurred_at,
                        "desc": (
                            f"Port {port_id}: rx={rx_errors_delta} "
                            f"tx={tx_errors_delta} errors"
                        ),
                    })
            except Exception as exc:
                logger.error(
                    "Failed to write error event for switch=%s port=%s: %s",
                    switch_id, port_id, exc,
                )

    try:
        await db.commit()
    except Exception as exc:
        logger.error("Failed to commit ports batch: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    return {"accepted": accepted, "rejected": rejected}


# ── POST /api/collector/metrics/devices ──────────────────────────────────────

@router.post("/metrics/devices")
async def ingest_devices(
    payload: RowsPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """
    Upsert device_registry rows from the collector buffer.
    Conflict target: ip column.

    Expected fields per row:
      mac, ip, hostname, device_type, is_online, last_seen,
      switch_id (optional), port_id (optional)
    """
    accepted = 0

    for row in payload.rows:
        try:
            await db.execute(
                text("""
                    INSERT INTO device_registry
                        (mac, ip, hostname, device_type, is_online,
                         last_seen, switch_id, port_id)
                    VALUES
                        (:mac, CAST(:ip AS INET), :hostname, :device_type, :is_online,
                         :last_seen, :switch_id, :port_id)
                    ON CONFLICT (ip) DO UPDATE SET
                        mac         = EXCLUDED.mac,
                        hostname    = EXCLUDED.hostname,
                        device_type = EXCLUDED.device_type,
                        is_online   = EXCLUDED.is_online,
                        last_seen   = EXCLUDED.last_seen,
                        switch_id   = COALESCE(EXCLUDED.switch_id, device_registry.switch_id),
                        port_id     = COALESCE(EXCLUDED.port_id, device_registry.port_id)
                """),
                {
                    "mac":         row.get("mac"),
                    "ip":          row.get("ip"),
                    "hostname":    row.get("hostname"),
                    "device_type": row.get("device_type", "unknown"),
                    "is_online":   row.get("is_online", True),
                    "last_seen":   _parse_ts(row.get("last_seen")),
                    "switch_id":   row.get("switch_id"),
                    "port_id":     str(row.get("port_id")) if row.get("port_id") is not None else None,
                },
            )
            accepted += 1
        except Exception as exc:
            logger.error("Failed to upsert device row: %s — %s", row, exc)

    try:
        await db.commit()
    except Exception as exc:
        logger.error("Failed to commit devices batch: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    return {"accepted": accepted}


# ── POST /api/collector/metrics/flows ────────────────────────────────────────

@router.post("/metrics/flows")
async def ingest_flows(
    payload: RowsPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """
    Insert network_flows rows from the collector buffer.

    Expected fields per row:
      time, src_ip, dst_ip, src_port, dst_port, protocol,
      bytes, packets, device_name, direction
    """
    accepted = rejected = 0

    for row in payload.rows:
        if not _ts_ok(row.get("time")):
            logger.warning(
                "Rejected flow row: timestamp out of range — %s",
                row.get("time"),
            )
            rejected += 1
            continue

        try:
            await db.execute(
                text("""
                    INSERT INTO network_flows
                        (time, src_ip, dst_ip, src_port, dst_port,
                         protocol, bytes, packets, device_name, direction)
                    VALUES
                        (:time, :src_ip, :dst_ip, :src_port, :dst_port,
                         :protocol, :bytes, :packets, :device_name, :direction)
                """),
                {
                    "time":        row.get("time"),
                    "src_ip":      row.get("src_ip"),
                    "dst_ip":      row.get("dst_ip"),
                    "src_port":    row.get("src_port"),
                    "dst_port":    row.get("dst_port"),
                    "protocol":    row.get("protocol"),
                    "bytes":       row.get("bytes"),
                    "packets":     row.get("packets"),
                    "device_name": row.get("device_name"),
                    "direction":   row.get("direction", "internal"),
                },
            )
            accepted += 1
        except Exception as exc:
            logger.error("Failed to insert flow row: %s — %s", row, exc)
            rejected += 1

    try:
        await db.commit()
    except Exception as exc:
        logger.error("Failed to commit flows batch: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    return {"accepted": accepted, "rejected": rejected}


# ── POST /api/collector/heartbeat ────────────────────────────────────────────

@router.post("/heartbeat")
async def ingest_heartbeat(
    payload: HeartbeatPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """
    Upsert a collector heartbeat row.
    Conflict target: collector_id (primary key).

    Body: {collector_id, last_seen, version, sources}
    """
    import json as _json

    sources_json = (
        _json.dumps(payload.sources)
        if isinstance(payload.sources, dict)
        else str(payload.sources)
    )

    try:
        await db.execute(
            text("""
                INSERT INTO collector_heartbeat
                    (collector_id, last_seen, version, sources)
                VALUES
                    (:collector_id, :last_seen, :version, :sources)
                ON CONFLICT (collector_id) DO UPDATE SET
                    last_seen = EXCLUDED.last_seen,
                    version   = EXCLUDED.version,
                    sources   = EXCLUDED.sources
            """),
            {
                "collector_id": payload.collector_id,
                "last_seen":    _parse_ts(payload.last_seen),
                "version":      payload.version,
                "sources":      sources_json,
            },
        )
        await db.commit()
    except Exception as exc:
        logger.error("Failed to upsert heartbeat: %s", exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    return {"status": "ok"}
