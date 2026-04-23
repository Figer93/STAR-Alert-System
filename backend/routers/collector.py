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

    logger.info(
        "[latency] Received payload: %d rows — sample: %s",
        len(payload.rows),
        payload.rows[:2] if payload.rows else [],
    )

    for row in payload.rows:
        raw_time = row.get("time")
        if not _ts_ok(raw_time):
            logger.warning(
                "[latency] Rejected row: timestamp out of range — raw=%r, keys=%s",
                raw_time,
                list(row.keys()),
            )
            rejected += 1
            continue

        params = {
            "time":            _parse_ts(raw_time),
            "target_name":     row.get("target_name"),
            "target_ip":       row.get("target_ip"),
            "target_type":     row.get("target_type", "internal"),
            "rtt_ms":          _float(row.get("rtt_ms")),      # None on 100% loss
            "packet_loss_pct": _float(row.get("packet_loss_pct")) or 0.0,
        }
        logger.debug("[latency] Inserting row: %s", params)

        try:
            await db.execute(
                text("""
                    INSERT INTO latency_metrics
                        (time, target_name, target_ip, target_type, rtt_ms, packet_loss_pct)
                    VALUES
                        (:time, :target_name, CAST(:target_ip AS INET), :target_type,
                         :rtt_ms, :packet_loss_pct)
                """),
                params,
            )
            accepted += 1
        except Exception as exc:
            logger.error(
                "[latency] INSERT failed — row=%s exc=%s",
                row,
                exc,
                exc_info=True,
            )
            # Roll back and start a fresh transaction so previous accepted rows
            # are not lost on the next iteration.
            await db.rollback()
            rejected += 1

    try:
        await db.commit()
    except Exception as exc:
        logger.error("[latency] Commit failed: %s", exc, exc_info=True)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB commit failed")

    # Sanity check: log current row count so we can confirm writes land.
    try:
        result = await db.execute(text("SELECT COUNT(*) FROM latency_metrics"))
        total = result.scalar()
        logger.info(
            "[latency] Batch done — accepted=%d rejected=%d total_in_table=%s",
            accepted,
            rejected,
            total,
        )
    except Exception as exc:
        logger.warning("[latency] Could not query row count: %s", exc)
        logger.info("[latency] Batch done — accepted=%d rejected=%d", accepted, rejected)

    return {"accepted": accepted, "rejected": rejected}


# ── POST /api/collector/metrics/ports ────────────────────────────────────────

_PORTS_COLS = (
    "time, switch_id, switch_name, port_id, port_name, "
    "device_name, device_ip, rx_bytes, tx_bytes, "
    "rx_errors, tx_errors, rx_packets, tx_packets, "
    "poe_watts, is_uplink, "
    "rx_errors_delta, tx_errors_delta, "
    "rx_bytes_delta, tx_bytes_delta, is_counter_reset"
)


@router.post("/metrics/ports")
async def ingest_ports(
    payload: RowsPayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """
    Insert switch_port_metrics rows from the collector buffer.

    Accepts {"rows": [...]} with any number of port metric rows and uses a
    single multi-row INSERT per chunk to minimise DB round-trips.

    Expected fields per row:
      time, switch_id, switch_name, port_id, port_name, device_name,
      device_ip, rx_bytes, tx_bytes, rx_errors, tx_errors,
      rx_packets, tx_packets, poe_watts, is_uplink,
      rx_errors_delta, tx_errors_delta, rx_bytes_delta, tx_bytes_delta,
      is_counter_reset

    Rows where rx/tx_errors_delta > 0 also write to port_error_events and
    network_events, and update device_registry.last_error_at.
    """
    import json as _json

    accepted = rejected = 0
    _CHUNK = 100  # rows per multi-row INSERT; keeps param count well under PG limit

    # ── Validate timestamps upfront ───────────────────────────────────────────
    valid_rows = []
    for row in payload.rows:
        if not _ts_ok(row.get("time")):
            logger.warning(
                "Rejected port row: timestamp out of range — %s",
                row.get("time"),
            )
            rejected += 1
        else:
            valid_rows.append(row)

    if not valid_rows:
        return {"accepted": 0, "rejected": rejected}

    for chunk_start in range(0, len(valid_rows), _CHUNK):
        chunk = valid_rows[chunk_start : chunk_start + _CHUNK]

        # ── Build single multi-row INSERT for this chunk ──────────────────────
        value_clauses: list[str] = []
        params: dict = {}
        prepared: list[dict] = []  # pre-parsed data reused for error side-writes

        for i, row in enumerate(chunk):
            rx_ed       = _int(row.get("rx_errors_delta")) or 0
            tx_ed       = _int(row.get("tx_errors_delta")) or 0
            port_id_raw = row.get("port_id")
            port_id     = str(port_id_raw) if port_id_raw is not None else None
            device_ip   = row.get("device_ip") or None

            value_clauses.append(
                f"(:time_{i}, :switch_id_{i}, :switch_name_{i}, :port_id_{i}, "
                f":port_name_{i}, :device_name_{i}, CAST(:device_ip_{i} AS INET), "
                f":rx_bytes_{i}, :tx_bytes_{i}, :rx_errors_{i}, :tx_errors_{i}, "
                f":rx_packets_{i}, :tx_packets_{i}, :poe_watts_{i}, :is_uplink_{i}, "
                f":rx_errors_delta_{i}, :tx_errors_delta_{i}, "
                f":rx_bytes_delta_{i}, :tx_bytes_delta_{i}, :is_counter_reset_{i})"
            )
            params.update({
                f"time_{i}":             _parse_ts(row.get("time")),
                f"switch_id_{i}":        row.get("switch_id"),
                f"switch_name_{i}":      row.get("switch_name"),
                f"port_id_{i}":          port_id,
                f"port_name_{i}":        row.get("port_name"),
                f"device_name_{i}":      row.get("device_name"),
                f"device_ip_{i}":        device_ip,
                f"rx_bytes_{i}":         _int(row.get("rx_bytes")),
                f"tx_bytes_{i}":         _int(row.get("tx_bytes")),
                f"rx_errors_{i}":        _int(row.get("rx_errors")),
                f"tx_errors_{i}":        _int(row.get("tx_errors")),
                f"rx_packets_{i}":       _int(row.get("rx_packets")),
                f"tx_packets_{i}":       _int(row.get("tx_packets")),
                f"poe_watts_{i}":        _float(row.get("poe_watts")),
                f"is_uplink_{i}":        row.get("is_uplink", False),
                f"rx_errors_delta_{i}":  rx_ed,
                f"tx_errors_delta_{i}":  tx_ed,
                f"rx_bytes_delta_{i}":   _int(row.get("rx_bytes_delta")) or 0,
                f"tx_bytes_delta_{i}":   _int(row.get("tx_bytes_delta")) or 0,
                f"is_counter_reset_{i}": row.get("is_counter_reset", False),
            })
            prepared.append({
                "switch_id":       row.get("switch_id"),
                "port_id":         port_id,
                "device_name":     row.get("device_name"),
                "device_ip":       device_ip,
                "rx_errors_delta": rx_ed,
                "tx_errors_delta": tx_ed,
                "occurred_at":     row.get("time"),
            })

        try:
            await db.execute(
                text(
                    f"INSERT INTO switch_port_metrics ({_PORTS_COLS}) "
                    f"VALUES {', '.join(value_clauses)}"
                ),
                params,
            )
            accepted += len(chunk)
        except Exception as exc:
            logger.error(
                "Batch INSERT failed for port chunk %d–%d: %s",
                chunk_start, chunk_start + len(chunk) - 1, exc,
            )
            await db.rollback()
            rejected += len(chunk)
            continue  # skip error side-writes for this chunk; try next

        # ── Error event side-writes (best-effort; never fail the batch) ───────
        for pd in prepared:
            if pd["rx_errors_delta"] <= 0 and pd["tx_errors_delta"] <= 0:
                continue

            switch_id   = pd["switch_id"]
            port_id     = pd["port_id"]
            device_name = pd["device_name"]
            device_ip   = pd["device_ip"]
            rx_ed       = pd["rx_errors_delta"]
            tx_ed       = pd["tx_errors_delta"]
            occurred_at = pd["occurred_at"]

            try:
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
                    "port_id":         port_id,
                    "device_name":     device_name,
                    "device_ip":       device_ip,
                    "rx_errors_delta": rx_ed,
                    "tx_errors_delta": tx_ed,
                    "occurred_at":     occurred_at,
                })

                error_desc = (
                    f"Port {port_id} on switch {switch_id}: "
                    f"rx_errors_delta={rx_ed}, tx_errors_delta={tx_ed}"
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
                    "metadata": _json.dumps({
                        "switch_id":       switch_id,
                        "port_id":         port_id,
                        "device_name":     device_name,
                        "rx_errors_delta": rx_ed,
                        "tx_errors_delta": tx_ed,
                    }),
                    "occurred_at": occurred_at,
                })

                if device_ip:
                    await db.execute(text("""
                        UPDATE device_registry
                           SET last_error_at   = :occurred_at,
                               last_error_desc = :desc
                         WHERE ip::text = :ip
                           AND (last_error_at IS NULL OR last_error_at < :occurred_at)
                    """), {
                        "ip":          device_ip,
                        "occurred_at": occurred_at,
                        "desc":        f"Port {port_id}: rx={rx_ed} tx={tx_ed} errors",
                    })

            except Exception as exc:
                logger.error(
                    "Failed to write error event for switch=%s port=%s: %s",
                    switch_id, port_id, exc,
                )
                await db.rollback()

        try:
            await db.commit()
        except Exception as exc:
            logger.error(
                "Failed to commit ports chunk %d–%d: %s",
                chunk_start, chunk_start + len(chunk) - 1, exc,
            )
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
      switch_id (optional), port_id (optional), is_wired (optional)
    """
    VALID_DEVICE_TYPES = {
        "workstation", "server", "printer", "ap", "unknown",
        "desktop", "network_infrastructure", "gateway", "mobile",
    }
    accepted = 0

    for row in payload.rows:
        if str(row.get("ip") or "").startswith("169.254."):
            continue
        try:
            is_wired_val = row.get("is_wired")
            is_wired = bool(is_wired_val) if is_wired_val is not None else None
            await db.execute(
                text("""
                    INSERT INTO device_registry
                        (mac, ip, hostname, device_type, is_online,
                         last_seen, switch_id, port_id, is_wired)
                    VALUES
                        (:mac, CAST(:ip AS INET), :hostname, :device_type, :is_online,
                         :last_seen, :switch_id, :port_id, :is_wired)
                    ON CONFLICT (ip) DO UPDATE SET
                        mac         = EXCLUDED.mac,
                        hostname    = EXCLUDED.hostname,
                        device_type = EXCLUDED.device_type,
                        is_online   = EXCLUDED.is_online,
                        last_seen   = EXCLUDED.last_seen,
                        switch_id   = COALESCE(EXCLUDED.switch_id, device_registry.switch_id),
                        port_id     = COALESCE(EXCLUDED.port_id, device_registry.port_id),
                        is_wired    = COALESCE(EXCLUDED.is_wired, device_registry.is_wired)
                """),
                {
                    "mac":         row.get("mac"),
                    "ip":          row.get("ip"),
                    "hostname":    row.get("hostname"),
                    "device_type": row.get("device_type", "unknown") if row.get("device_type") in VALID_DEVICE_TYPES else "unknown",
                    "is_online":   row.get("is_online", True),
                    "last_seen":   _parse_ts(row.get("last_seen")),
                    "switch_id":   row.get("switch_id"),
                    "port_id":     str(row.get("port_id")) if row.get("port_id") is not None else None,
                    "is_wired":    is_wired,
                },
            )
            accepted += 1
        except Exception as exc:
            logger.error("Failed to upsert device row: %s — %s", row, exc)
            await db.rollback()

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


# ── POST /api/collector/metrics/traceroute ────────────────────────────────────

class TracerouteHop(BaseModel):
    hop_num: int
    ip: str | None
    rtt_ms: float | None


class TraceroutePayload(BaseModel):
    target_ip:             str
    target_name:           str | None = None
    triggered_by_loss_pct: float | None = None
    hops:                  list[TracerouteHop]
    collected_at:          str


@router.post("/metrics/traceroute")
async def ingest_traceroute(
    payload: TraceroutePayload,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """
    Insert a traceroute result triggered by the collector on >10% packet loss.

    Payload: {target_ip, target_name, triggered_by_loss_pct, hops, collected_at}
    hops: [{hop_num, ip, rtt_ms}]  — ip is null for non-responding hops (*)
    """
    import json as _json

    if not _ts_ok(payload.collected_at):
        raise HTTPException(status_code=422, detail="collected_at timestamp out of range")

    try:
        await db.execute(
            text("""
                INSERT INTO traceroute_results
                    (target_ip, target_name, triggered_by_loss_pct, hops, collected_at)
                VALUES
                    (:target_ip, :target_name, :triggered_by_loss_pct,
                     :hops::jsonb, :collected_at)
            """),
            {
                "target_ip":             payload.target_ip,
                "target_name":           payload.target_name,
                "triggered_by_loss_pct": payload.triggered_by_loss_pct,
                "hops":                  _json.dumps([h.model_dump() for h in payload.hops]),
                "collected_at":          _parse_ts(payload.collected_at),
            },
        )
        await db.commit()
    except Exception as exc:
        logger.error("Failed to insert traceroute for %s: %s", payload.target_ip, exc)
        await db.rollback()
        raise HTTPException(status_code=500, detail="DB write failed")

    return {"status": "ok"}


# ── GET /api/collector/heartbeat/latest ──────────────────────────────────────

@router.get("/heartbeat/latest")
async def get_latest_heartbeat(db: AsyncSession = Depends(get_db)) -> dict:
    """Return the most-recently-seen collector heartbeat row."""
    row = await db.execute(
        text(
            "SELECT last_seen, version FROM collector_heartbeat"
            " ORDER BY last_seen DESC LIMIT 1"
        )
    )
    result = row.fetchone()
    if result is None:
        return {"last_seen": None, "collector_version": None}
    return {
        "last_seen":         result.last_seen.isoformat() if result.last_seen else None,
        "collector_version": result.version,
    }
