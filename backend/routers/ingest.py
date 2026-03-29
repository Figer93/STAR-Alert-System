import hashlib
import hmac
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.alert_engine import process_alert
from backend.config import settings
from backend.database import get_db
from backend.models import Alert, NotificationLog, Source
from backend.adapters import ADAPTER_REGISTRY
from backend.websocket_manager import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ingest", tags=["ingest"])


async def _update_source_heartbeat(slug: str, db: AsyncSession):
    source = (await db.execute(select(Source).where(Source.slug == slug))).scalars().first()
    if source:
        source.last_seen = datetime.now(timezone.utc)
        source.status = "online"
        await db.commit()


def _verify_hmac(secret: str, body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()  # type: ignore
    return hmac.compare_digest(expected, signature.lstrip("sha256="))


async def _resolve_alerts_by_fingerprint_key(source_slug: str, event_type: str, fingerprint_key: str, db: AsyncSession) -> int:
    import hashlib as _hs
    fingerprint = _hs.sha256(f"{source_slug}:{event_type}:{fingerprint_key}".encode()).hexdigest()
    alerts = (await db.execute(select(Alert).where(Alert.fingerprint == fingerprint).where(Alert.status.in_(["active", "acknowledged"])))).scalars().all()
    count = 0
    for alert in alerts:
        alert.status = "resolved"
        alert.resolved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(alert)
        await ws_manager.broadcast("alert.updated", {"id": alert.id, "status": "resolved"})
        count += 1
    return count


@router.post("/ninjarmm")
async def ingest_ninjarmm(request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.body()
    if settings.NINJARMM_WEBHOOK_SECRET:
        sig = request.headers.get("X-Ninja-Signature", "")
        if not _verify_hmac(settings.NINJARMM_WEBHOOK_SECRET, body, sig):
            raise HTTPException(status_code=401, detail="Invalid signature")
    payload = await request.json()
    await _update_source_heartbeat("ninjarmm", db)
    event_type = payload.get("eventType", "UNKNOWN")
    device_name = payload.get("deviceName", "Unknown Device")
    from backend.adapters.ninjarmm_adapter import RESOLUTION_EVENTS
    if event_type in RESOLUTION_EVENTS:
        resolved = await _resolve_alerts_by_fingerprint_key("ninjarmm", "device_offline", f"{device_name}:DEVICE_OFFLINE", db)
        return {"status": "resolved", "resolved_count": resolved}
    adapter = ADAPTER_REGISTRY["ninjarmm"]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))
    alert = await process_alert(raw, db)
    return {"status": "accepted", "alert_id": alert.id if alert else None}


@router.post("/pingplotter")
async def ingest_pingplotter(request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.body()
    if settings.PINGPLOTTER_WEBHOOK_SECRET:
        sig = request.headers.get("X-PingPlotter-Signature", "")
        if not _verify_hmac(settings.PINGPLOTTER_WEBHOOK_SECRET, body, sig):
            raise HTTPException(status_code=401, detail="Invalid signature")
    payload = await request.json()
    await _update_source_heartbeat("pingplotter", db)
    event_type = payload.get("event_type", "")
    target = payload.get("target", "unknown")
    if event_type == "resolved":
        resolved = 0
        for orig in ("unreachable", "latency_spike", "packet_loss", "route_change"):
            resolved += await _resolve_alerts_by_fingerprint_key("pingplotter", orig, f"{target}:{orig}", db)
        return {"status": "resolved", "resolved_count": resolved}
    adapter = ADAPTER_REGISTRY["pingplotter"]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))
    alert = await process_alert(raw, db)
    return {"status": "accepted", "alert_id": alert.id if alert else None}


@router.post("/{slug}")
async def ingest_generic(slug: str, request: Request, db: AsyncSession = Depends(get_db)):
    if slug not in ADAPTER_REGISTRY:
        raise HTTPException(status_code=404, detail=f"No adapter for '{slug}'")
    payload = await request.json()
    await _update_source_heartbeat(slug, db)
    adapter = ADAPTER_REGISTRY[slug]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))
    alert = await process_alert(raw, db)
    return {"status": "accepted", "alert_id": alert.id if alert else None}
