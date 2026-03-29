from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.models import Source
from backend.schemas import SourceRead, SourceUpdate
from backend.websocket_manager import ws_manager

router = APIRouter(prefix="/api/sources", tags=["sources"])


@router.get("", response_model=list[SourceRead])
async def list_sources(db: AsyncSession = Depends(get_db)):
    return (await db.execute(select(Source).order_by(Source.name))).scalars().all()


@router.patch("/{source_id}", response_model=SourceRead)
async def update_source(source_id: int, body: SourceUpdate, db: AsyncSession = Depends(get_db)):
    source = await db.get(Source, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    if body.enabled is not None:
        source.enabled = body.enabled
    if body.config is not None:
        source.config = body.config
    if body.status is not None:
        old = source.status
        source.status = body.status
        if old != body.status:
            await ws_manager.broadcast("source.status_change", {"id": source.id, "slug": source.slug, "status": body.status})
    await db.commit()
    await db.refresh(source)
    return source


@router.get("/{source_id}/test")
async def test_source(source_id: int, db: AsyncSession = Depends(get_db)):
    source = await db.get(Source, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    from backend.schemas import RawAlert
    from backend.alert_engine import process_alert
    raw = RawAlert(source_slug=source.slug, event_type="test", title=f"Test alert from {source.name}", message="Synthetic test alert.", severity="info", fingerprint_key=f"test:{source.slug}", raw_payload={"test": True})
    alert = await process_alert(raw, db)
    return {"status": "ok", "alert_id": alert.id if alert else None}
