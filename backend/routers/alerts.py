import logging
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.database import get_db
from backend.models import Alert, NotificationLog
from backend.schemas import AlertAcknowledge, AlertRead, AlertsListResponse
from backend.websocket_manager import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("", response_model=AlertsListResponse)
async def list_alerts(severity: Optional[str] = None, source: Optional[str] = None, status: Optional[str] = None, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0), db: AsyncSession = Depends(get_db)):
    stmt = select(Alert).options(selectinload(Alert.source))
    if severity:
        stmt = stmt.where(Alert.severity == severity)
    if status:
        stmt = stmt.where(Alert.status == status)
    if source:
        from backend.models import Source
        sub = select(Source.id).where(Source.slug == source)
        stmt = stmt.where(Alert.source_id.in_(sub))
    stmt = stmt.order_by(Alert.last_seen.desc())
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    alerts = (await db.execute(stmt.limit(limit).offset(offset))).scalars().all()
    return AlertsListResponse(total=total, alerts=alerts)


@router.get("/{alert_id}", response_model=AlertRead)
async def get_alert(alert_id: int, db: AsyncSession = Depends(get_db)):
    alert = (await db.execute(select(Alert).where(Alert.id == alert_id).options(selectinload(Alert.source)))).scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert


@router.patch("/{alert_id}/acknowledge", response_model=AlertRead)
async def acknowledge_alert(alert_id: int, body: AlertAcknowledge, db: AsyncSession = Depends(get_db)):
    alert = (await db.execute(select(Alert).where(Alert.id == alert_id).options(selectinload(Alert.source)))).scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.status = "acknowledged"
    alert.acknowledged_by = body.acknowledged_by
    alert.acknowledged_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(alert)
    await ws_manager.broadcast("alert.updated", {"id": alert.id, "status": alert.status, "acknowledged_by": alert.acknowledged_by})
    return alert


@router.patch("/{alert_id}/resolve", response_model=AlertRead)
async def resolve_alert(alert_id: int, db: AsyncSession = Depends(get_db)):
    alert = (await db.execute(select(Alert).where(Alert.id == alert_id).options(selectinload(Alert.source)))).scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    was_tg = alert.notified_telegram
    was_em = alert.notified_email
    alert.status = "resolved"
    alert.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(alert)
    await ws_manager.broadcast("alert.updated", {"id": alert.id, "status": alert.status})
    if was_tg:
        try:
            from backend.notifiers.telegram_notifier import TelegramNotifier
            success, error = await TelegramNotifier().send_resolution(alert)
            db.add(NotificationLog(alert_id=alert.id, channel="telegram", recipient="configured_chat_ids", success=success, error=error))
            await db.commit()
        except Exception:
            logger.exception("Resolution telegram failed for alert id=%d", alert_id)
    return alert


@router.delete("/{alert_id}", status_code=204)
async def delete_alert(alert_id: int, db: AsyncSession = Depends(get_db)):
    alert = (await db.execute(select(Alert).where(Alert.id == alert_id))).scalars().first()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    await db.delete(alert)
    await db.commit()


@router.get("/export")
async def export_alerts(format: Literal["csv"] = "csv", db: AsyncSession = Depends(get_db)):
    import csv, io
    alerts = (await db.execute(select(Alert).options(selectinload(Alert.source)).order_by(Alert.first_seen.desc()))).scalars().all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "source", "severity", "title", "message", "status", "first_seen", "last_seen", "occurrence_count"])
    for a in alerts:
        writer.writerow([a.id, a.source.slug if a.source else "", a.severity, a.title, a.message, a.status, a.first_seen.isoformat(), a.last_seen.isoformat(), a.occurrence_count])
    output.seek(0)
    return StreamingResponse(iter([output.read()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=alerts.csv"})
