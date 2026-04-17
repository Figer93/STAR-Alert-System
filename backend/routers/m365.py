"""
Microsoft 365 endpoints — /api/m365/*

Serves service health and incident data synced by m365_monitor.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/m365", tags=["m365"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _iso(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    return v


# ── Pydantic models ────────────────────────────────────────────────────────────

class M365ServiceHealth(BaseModel):
    service_id:   str
    service_name: str
    status:       str
    recorded_at:  Optional[str] = None


class M365Incident(BaseModel):
    id:             int
    incident_id:    str
    service_name:   Optional[str] = None
    title:          Optional[str] = None
    status:         Optional[str] = None
    classification: Optional[str] = None
    severity:       Optional[str] = None
    start_time:     Optional[str] = None
    end_time:       Optional[str] = None
    is_resolved:    bool = False
    updated_at:     Optional[str] = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/health", response_model=list[M365ServiceHealth])
async def get_m365_health(db: AsyncSession = Depends(get_db)):
    """
    Latest status per service, ordered: non-operational first, then alphabetical.
    """
    result = await db.execute(text("""
        SELECT service_id, service_name, status, recorded_at
        FROM (
            SELECT DISTINCT ON (service_id)
                service_id, service_name, status, recorded_at
            FROM m365_service_health
            ORDER BY service_id, recorded_at DESC
        ) latest
        ORDER BY
            CASE WHEN status NOT IN ('serviceOperational', 'informational') THEN 0 ELSE 1 END,
            service_name ASC
    """))
    rows = result.mappings().all()
    return [
        M365ServiceHealth(
            service_id   = r["service_id"],
            service_name = r["service_name"],
            status       = r["status"],
            recorded_at  = _iso(r.get("recorded_at")),
        )
        for r in rows
    ]


@router.get("/incidents", response_model=list[M365Incident])
async def get_m365_incidents(
    resolved: Optional[bool] = Query(False, description="Include resolved incidents"),
    db: AsyncSession = Depends(get_db),
):
    """Incidents list. resolved=false (default) returns only active incidents."""
    where = "" if resolved else "WHERE is_resolved = FALSE"
    result = await db.execute(text(f"""
        SELECT id, incident_id, service_name, title, status, classification,
               severity, start_time, end_time, is_resolved, updated_at
        FROM m365_incidents
        {where}
        ORDER BY
            CASE WHEN is_resolved = FALSE THEN 0 ELSE 1 END,
            COALESCE(start_time, updated_at) DESC NULLS LAST
    """))
    rows = result.mappings().all()
    return [
        M365Incident(
            id             = r["id"],
            incident_id    = r["incident_id"],
            service_name   = r.get("service_name"),
            title          = r.get("title"),
            status         = r.get("status"),
            classification = r.get("classification"),
            severity       = r.get("severity"),
            start_time     = _iso(r.get("start_time")),
            end_time       = _iso(r.get("end_time")),
            is_resolved    = bool(r.get("is_resolved", False)),
            updated_at     = _iso(r.get("updated_at")),
        )
        for r in rows
    ]
