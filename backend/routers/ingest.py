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
    stmt = select(Source).where(Source.slug == slug)
    source = (await db.execute(stmt)).scalars().first()
    if source:
        source.last_seen = datetime.now(timezone.utc)
        source.status = "online"
        await db.commit()


def _verify_hmac(secret: str, body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()  # type: ignore[attr-defined]
    return hmac.compare_digest(expected, signature.lstrip("sha256="))


async def _resolve_alerts_by_fingerprint_key(
    source_slug: str, event_type: str, fingerprint_key: str, db: AsyncSession
) -> int:
    """Find active/acknowledged alerts matching a fingerprint and resolve them.
    Returns the number of alerts resolved."""
    import hashlib as _hs
    fingerprint = _hs.sha256(f"{source_slug}:{event_type}:{fingerprint_key}".encode()).hexdigest()
    stmt = (
        select(Alert)
        .where(Alert.fingerprint == fingerprint)
        .where(Alert.status.in_(["active", "acknowledged"]))
    )
    alerts = (await db.execute(stmt)).scalars().all()

    count = 0
    for alert in alerts:
        was_notified_telegram = alert.notified_telegram
        was_notified_email    = alert.notified_email

        alert.status = "resolved"
        alert.resolved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(alert)

        await ws_manager.broadcast("alert.updated", {"id": alert.id, "status": "resolved"})

        # Resolution follow-up notifications
        if was_notified_telegram:
            try:
                from backend.notifiers.telegram_notifier import TelegramNotifier
                success, error = await TelegramNotifier().send_resolution(alert)
                db.add(NotificationLog(
                    alert_id=alert.id, channel="telegram",
                    recipient="configured_chat_ids", success=success, error=error,
                ))
                await db.commit()
            except Exception:
                logger.exception("Resolution telegram failed for auto-resolve alert id=%d", alert.id)

        if was_notified_email:
            try:
                from backend.notifiers.email_notifier import EmailNotifier
                success, error = await EmailNotifier().send_resolution(alert)
                db.add(NotificationLog(
                    alert_id=alert.id, channel="email",
                    recipient="configured_recipients", success=success, error=error,
                ))
                await db.commit()
            except Exception:
                logger.exception("Resolution email failed for auto-resolve alert id=%d", alert.id)

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

    # Support both Activity webhook format (eventType) and Condition format (activityType+statusCode)
    activity_type = payload.get("activityType") or payload.get("eventType", "UNKNOWN")
    status_code   = payload.get("statusCode", "")
    device_id     = payload.get("deviceId")
    device_name   = payload.get("deviceName") or (f"Device #{device_id}" if device_id else "Unknown Device")

    # Build effective event type (mirrors adapter logic)
    if activity_type == "CONDITION" and status_code:
        effective_event_type = f"CONDITION_{status_code.upper()}"
    else:
        effective_event_type = activity_type

    from backend.adapters.ninjarmm_adapter import RESOLUTION_EVENTS
    if effective_event_type in RESOLUTION_EVENTS:
        if effective_event_type == "CONDITION_RESET":
            # Resolve the matching CONDITION_TRIGGERED alert using same fingerprint as adapter
            data      = payload.get("data") or {}
            msg_data  = data.get("message") or {}
            cond_code = msg_data.get("code", "") or effective_event_type
            fingerprint_key = f"{device_name}:{cond_code}"
            resolved = await _resolve_alerts_by_fingerprint_key(
                "ninjarmm", "condition_triggered", fingerprint_key, db
            )
            logger.info("NinjaRMM CONDITION_RESET: resolved %d alert(s) for %s cond=%s", resolved, device_name, cond_code)
        else:
            # DEVICE_ONLINE resolves any active DEVICE_OFFLINE alert for this device
            resolved = await _resolve_alerts_by_fingerprint_key(
                "ninjarmm", "device_offline", f"{device_name}:DEVICE_OFFLINE", db
            )
            logger.info("NinjaRMM DEVICE_ONLINE: resolved %d alert(s) for %s", resolved, device_name)
        return {"status": "resolved", "resolved_count": resolved}

    adapter = ADAPTER_REGISTRY["ninjarmm"]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        logger.exception("NinjaRMM adapter parse error")
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
    target     = payload.get("target", "unknown")

    # "resolved" event from PingPlotter — clear the matching active alert
    if event_type == "resolved":
        # Try both unreachable and other event types that might have fired
        resolved = 0
        for orig_event in ("unreachable", "latency_spike", "packet_loss", "route_change"):
            resolved += await _resolve_alerts_by_fingerprint_key(
                "pingplotter", orig_event, f"{target}:{orig_event}", db
            )
        logger.info("PingPlotter resolved event: resolved %d alert(s) for target=%s", resolved, target)
        return {"status": "resolved", "resolved_count": resolved}

    adapter = ADAPTER_REGISTRY["pingplotter"]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        logger.exception("PingPlotter adapter parse error")
        raise HTTPException(status_code=422, detail=str(e))

    alert = await process_alert(raw, db)
    return {"status": "accepted", "alert_id": alert.id if alert else None}


@router.post("/{slug}")
async def ingest_generic(slug: str, request: Request, db: AsyncSession = Depends(get_db)):
    if slug not in ADAPTER_REGISTRY:
        raise HTTPException(status_code=404, detail=f"No adapter registered for slug '{slug}'")

    payload = await request.json()
    await _update_source_heartbeat(slug, db)

    adapter = ADAPTER_REGISTRY[slug]()
    try:
        raw = adapter.parse(payload)
    except Exception as e:
        logger.exception("Adapter parse error for slug=%s", slug)
        raise HTTPException(status_code=422, detail=str(e))

    alert = await process_alert(raw, db)
    return {"status": "accepted", "alert_id": alert.id if alert else None}
