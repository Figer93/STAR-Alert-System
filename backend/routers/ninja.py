"""
NinjaRMM data endpoints — /api/ninja/*

Serves patch compliance, software inventory, and disk trend data
collected by the ninja_sync background service.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ninja", tags=["ninja"])


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _exec(db: AsyncSession, sql: str, params: dict | None = None) -> list[dict]:
    result = await db.execute(text(sql), params or {})
    rows = result.mappings().all()
    return [dict(r) for r in rows]


def _iso(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _serialise(rows: list[dict]) -> list[dict]:
    return [{k: _iso(v) for k, v in r.items()} for r in rows]


# ── Linear regression (no numpy) ──────────────────────────────────────────────

def _linear_slope(xs: list[float], ys: list[float]) -> float | None:
    """Return slope from simple OLS. Returns None if < 2 points."""
    n = len(xs)
    if n < 2:
        return None
    sum_x  = sum(xs)
    sum_y  = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_xx = sum(x * x for x in xs)
    denom  = n * sum_xx - sum_x ** 2
    if denom == 0:
        return None
    return (n * sum_xy - sum_x * sum_y) / denom


# ── Pydantic models ────────────────────────────────────────────────────────────

class PatchStatusRow(BaseModel):
    ninja_id:         int
    hostname:         str
    os_name:          Optional[str] = None
    patches_approved: int
    patches_pending:  int
    patches_failed:   int
    reboot_required:  bool
    last_scan:        Optional[str] = None
    updated_at:       Optional[str] = None


class SoftwareRow(BaseModel):
    id:           int
    ninja_id:     int
    name:         str
    version:      Optional[str] = None
    publisher:    Optional[str] = None
    install_date: Optional[str] = None


class DiskPoint(BaseModel):
    recorded_at:   str
    disk_free_pct: float


class DiskTrendResponse(BaseModel):
    history:               list[DiskPoint]
    fill_rate_pct_per_day: Optional[float] = None
    days_until_full:       Optional[int]   = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/patch-status", response_model=list[PatchStatusRow])
async def get_patch_status(db: AsyncSession = Depends(get_db)):
    """All devices' patch compliance, ordered by worst first."""
    rows = await _exec(db, """
        SELECT
            p.ninja_id,
            p.hostname,
            d.os_name,
            p.patches_approved,
            p.patches_pending,
            p.patches_failed,
            p.reboot_required,
            p.last_scan,
            p.updated_at
        FROM device_patch_status p
        LEFT JOIN device_registry d ON d.ninja_id = p.ninja_id
        ORDER BY p.patches_failed DESC, p.patches_pending DESC, p.hostname ASC
    """)
    return [
        PatchStatusRow(
            ninja_id         = r["ninja_id"],
            hostname         = r["hostname"],
            os_name          = r.get("os_name"),
            patches_approved = r["patches_approved"],
            patches_pending  = r["patches_pending"],
            patches_failed   = r["patches_failed"],
            reboot_required  = bool(r["reboot_required"]),
            last_scan        = _iso(r.get("last_scan")),
            updated_at       = _iso(r.get("updated_at")),
        )
        for r in rows
    ]


@router.get("/devices/{ninja_id}/software", response_model=list[SoftwareRow])
async def get_device_software(ninja_id: int, db: AsyncSession = Depends(get_db)):
    """Software inventory for a device, sorted by name."""
    rows = await _exec(
        db,
        """
        SELECT id, ninja_id, name, version, publisher, install_date
        FROM device_software
        WHERE ninja_id = :nid
        ORDER BY name ASC
        """,
        {"nid": ninja_id},
    )
    return [
        SoftwareRow(
            id           = r["id"],
            ninja_id     = r["ninja_id"],
            name         = r["name"],
            version      = r.get("version"),
            publisher    = r.get("publisher"),
            install_date = str(r["install_date"]) if r.get("install_date") else None,
        )
        for r in rows
    ]


@router.get("/devices/{ninja_id}/disk-trend", response_model=DiskTrendResponse)
async def get_disk_trend(
    ninja_id: int,
    days: int = Query(14, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
):
    """
    Disk free % history for a device over the last N days.

    Also returns:
      fill_rate_pct_per_day — linear regression slope (negative = filling up)
      days_until_full       — estimated days until disk is full (null if stable/freeing)
    """
    rows = await _exec(
        db,
        """
        SELECT disk_free_pct, recorded_at
        FROM disk_history
        WHERE ninja_id = :nid
          AND recorded_at >= NOW() - make_interval(days => :days)
        ORDER BY recorded_at ASC
        """,
        {"nid": ninja_id, "days": days},
    )

    if not rows:
        return DiskTrendResponse(history=[], fill_rate_pct_per_day=None, days_until_full=None)

    history = [
        DiskPoint(
            recorded_at   = _iso(r["recorded_at"]),
            disk_free_pct = float(r["disk_free_pct"]),
        )
        for r in rows
    ]

    # Regression: x = fractional days since first point, y = disk_free_pct
    t0 = rows[0]["recorded_at"]
    if isinstance(t0, str):
        t0 = datetime.fromisoformat(t0.replace("Z", "+00:00"))

    xs: list[float] = []
    ys: list[float] = []
    for r in rows:
        ts = r["recorded_at"]
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if t0.tzinfo is None:
            t0_aware = t0.replace(tzinfo=timezone.utc)
        else:
            t0_aware = t0
        delta_days = (ts - t0_aware).total_seconds() / 86400
        xs.append(delta_days)
        ys.append(float(r["disk_free_pct"]))

    slope = _linear_slope(xs, ys)  # pct per day; negative = filling

    fill_rate = round(slope, 4) if slope is not None else None
    days_until_full: int | None = None

    if slope is not None and slope < 0:
        # Disk is filling; estimate days until 0% free
        current_pct = ys[-1]
        if current_pct > 0:
            days_until_full = max(0, int(current_pct / (-slope)))

    return DiskTrendResponse(
        history               = history,
        fill_rate_pct_per_day = fill_rate,
        days_until_full       = days_until_full,
    )
