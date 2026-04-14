import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.maintenance import maintenance

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


# ── In-memory maintenance (existing endpoints) ────────────────────────────────

class MaintenanceStart(BaseModel):
    minutes: int = Field(default=30, ge=1, le=480)


@router.get("/status")
async def get_status():
    return maintenance.status()


@router.post("/start")
async def start_maintenance(body: MaintenanceStart):
    until = maintenance.start(body.minutes)
    logger.info("Maintenance mode started for %d minutes (until %s)", body.minutes, until.isoformat())
    return maintenance.status()


@router.post("/stop")
async def stop_maintenance():
    maintenance.stop()
    logger.info("Maintenance mode stopped")
    return maintenance.status()


# ── Scheduled maintenance windows (DB-backed) ─────────────────────────────────

class WindowCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    starts_at: datetime
    ends_at: datetime


def _window_row(row: dict) -> dict:
    now = datetime.now(timezone.utc)

    def _to_str(v) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.isoformat()
        return str(v)

    starts = row["starts_at"]
    ends   = row["ends_at"]
    is_active = False
    if isinstance(starts, datetime) and isinstance(ends, datetime):
        is_active = starts <= now <= ends

    return {
        "id":         row["id"],
        "name":       row["name"],
        "starts_at":  _to_str(starts),
        "ends_at":    _to_str(ends),
        "created_at": _to_str(row.get("created_at")),
        "is_active":  is_active,
    }


@router.get("")
async def list_windows(db: AsyncSession = Depends(get_db)):
    """List all active, upcoming, and recently-past windows (last 30 days)."""
    result = await db.execute(text("""
        SELECT id, name, starts_at, ends_at, created_at
        FROM maintenance_windows
        WHERE ends_at > NOW() - INTERVAL '30 days'
        ORDER BY starts_at ASC
    """))
    rows = [dict(r._mapping) for r in result]
    return [_window_row(r) for r in rows]


@router.post("", status_code=201)
async def create_window(body: WindowCreate, db: AsyncSession = Depends(get_db)):
    """Create a new scheduled maintenance window."""
    if body.ends_at <= body.starts_at:
        raise HTTPException(status_code=422, detail="ends_at must be after starts_at")

    window_id = str(uuid.uuid4())
    await db.execute(text("""
        INSERT INTO maintenance_windows (id, name, starts_at, ends_at, created_at)
        VALUES (:id, :name, :starts_at, :ends_at, NOW())
    """), {
        "id":        window_id,
        "name":      body.name,
        "starts_at": body.starts_at,
        "ends_at":   body.ends_at,
    })
    await db.commit()

    result = await db.execute(text("""
        SELECT id, name, starts_at, ends_at, created_at
        FROM maintenance_windows WHERE id = :id
    """), {"id": window_id})
    row = result.mappings().one()
    logger.info("Maintenance window created: %s (%s → %s)", body.name, body.starts_at, body.ends_at)
    return _window_row(dict(row))


@router.delete("/{window_id}", status_code=204)
async def delete_window(window_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a maintenance window by ID."""
    result = await db.execute(text(
        "DELETE FROM maintenance_windows WHERE id = :id RETURNING id"
    ), {"id": window_id})
    if not result.fetchone():
        raise HTTPException(status_code=404, detail="Maintenance window not found")
    await db.commit()
    logger.info("Maintenance window deleted: %s", window_id)
