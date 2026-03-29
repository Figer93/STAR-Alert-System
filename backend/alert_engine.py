import hashlib
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import rule_engine
from backend.models import Alert, Source
from backend.schemas import RawAlert
from backend.websocket_manager import ws_manager
from backend.config import settings

logger = logging.getLogger(__name__)


def _build_fingerprint(source_slug: str, event_type: str, fingerprint_key: str) -> str:
    raw = f"{source_slug}:{event_type}:{fingerprint_key}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _alert_to_dict(alert: Alert) -> dict:
    return {
        "id": alert.id,
        "source_id": alert.source_id,
        "severity": alert.severity,
        "title": alert.title,
        "message": alert.message,
        "fingerprint": alert.fingerprint,
        "status": alert.status,
        "first_seen": alert.first_seen.isoformat(),
        "last_seen": alert.last_seen.isoformat(),
        "occurrence_count": alert.occurrence_count,
        "notified_telegram": alert.notified_telegram,
        "notified_email": alert.notified_email,
    }


async def _get_or_create_source(slug: str, db: AsyncSession) -> Source | None:
    stmt = select(Source).where(Source.slug == slug)
    source = (await db.execute(stmt)).scalars().first()
    return source


async def process_alert(raw: RawAlert, db: AsyncSession) -> Alert | None:
    now = datetime.now(timezone.utc)

    # 1. Run rule engine
    rule_result = await rule_engine.evaluate(raw, db)
    if rule_result.suppressed:
        logger.info("Alert suppressed by rule: %s / %s", raw.source_slug, raw.event_type)
        return None

    # 2. Apply severity override
    severity = rule_result.severity_override or raw.severity

    # 3. Build fingerprint
    fingerprint = _build_fingerprint(raw.source_slug, raw.event_type, raw.fingerprint_key)

    # 4. Dedup check
    dedup_window = timedelta(minutes=settings.DEFAULT_DEDUP_WINDOW_MINUTES)
    cutoff = now - dedup_window
    stmt = (
        select(Alert)
        .where(Alert.fingerprint == fingerprint)
        .where(Alert.first_seen >= cutoff)
        .where(Alert.status != "resolved")
    )
    existing = (await db.execute(stmt)).scalars().first()

    if existing:
        existing.occurrence_count += 1
        existing.last_seen = now
        await db.commit()
        await db.refresh(existing)
        logger.info("Dedup: alert id=%d occurrence_count=%d", existing.id, existing.occurrence_count)
        await ws_manager.broadcast("alert.updated", _alert_to_dict(existing))
        return existing

    # 5. Resolve source
    source = await _get_or_create_source(raw.source_slug, db)

    # 6. Persist new alert
    alert = Alert(
        source_id=source.id if source else None,
        severity=severity,
        title=raw.title,
        message=raw.message,
        raw_payload=raw.raw_payload,
        fingerprint=fingerprint,
        status="active",
        first_seen=now,
        last_seen=now,
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)

    logger.info("New alert id=%d severity=%s title=%s", alert.id, alert.severity, alert.title)

    # 7. Broadcast to WebSocket clients
    await ws_manager.broadcast("alert.new", _alert_to_dict(alert))

    # 8. Dispatch notifications (lazy import to avoid circular deps)
    try:
        from backend.notifiers import dispatch
        await dispatch(alert, rule_result, db)
    except Exception:
        logger.exception("Notification dispatch failed for alert id=%d", alert.id)

    return alert
