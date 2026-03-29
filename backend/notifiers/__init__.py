import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Alert, NotificationLog
from backend.rule_engine import RuleEngineResult
from backend.config import settings

logger = logging.getLogger(__name__)


async def _within_cooldown(
    alert: Alert, channel: str, cooldown_minutes: int, db: AsyncSession
) -> bool:
    """Return True if a successful notification was already sent for this fingerprint+channel
    within the cooldown window."""
    if cooldown_minutes <= 0:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=cooldown_minutes)
    stmt = (
        select(NotificationLog.id)
        .join(Alert, NotificationLog.alert_id == Alert.id)
        .where(Alert.fingerprint == alert.fingerprint)
        .where(NotificationLog.channel == channel)
        .where(NotificationLog.success == True)  # noqa: E712
        .where(NotificationLog.sent_at >= cutoff)
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.first() is not None


async def dispatch(alert: Alert, rule_result: RuleEngineResult, db: AsyncSession):
    # Maintenance mode suppresses all outbound notifications
    from backend.maintenance import maintenance as _maintenance
    if _maintenance.active:
        logger.info(
            "Maintenance mode active — skipping notifications for alert id=%d", alert.id
        )
        return

    notify_telegram = rule_result.notify_telegram if rule_result.notify_telegram is not None else True
    notify_email = rule_result.notify_email if rule_result.notify_email is not None else False

    # Default: email only for critical
    if rule_result.notify_email is None and alert.severity != "critical":
        notify_email = False

    # Cooldown window: use rule's value, otherwise fall back to severity-based defaults
    if rule_result.cooldown_minutes is not None:
        cooldown = rule_result.cooldown_minutes
    elif alert.severity == "critical":
        cooldown = settings.CRITICAL_COOLDOWN_MINUTES
    else:
        cooldown = settings.DEFAULT_COOLDOWN_MINUTES

    if notify_telegram:
        if await _within_cooldown(alert, "telegram", cooldown, db):
            logger.debug(
                "Telegram notification suppressed by cooldown (%dm) for fingerprint=%s",
                cooldown,
                alert.fingerprint,
            )
        else:
            try:
                from backend.notifiers.telegram_notifier import TelegramNotifier
                notifier = TelegramNotifier()
                success, error = await notifier.send(alert)
                log = NotificationLog(
                    alert_id=alert.id,
                    channel="telegram",
                    recipient=",".join(settings.telegram_chat_id_list) or "configured_chat_ids",
                    success=success,
                    error=error,
                )
                db.add(log)
                if success:
                    alert.notified_telegram = True
            except Exception as e:
                logger.exception("Telegram notifier error: %s", e)

    if notify_email:
        if await _within_cooldown(alert, "email", cooldown, db):
            logger.debug(
                "Email notification suppressed by cooldown (%dm) for fingerprint=%s",
                cooldown,
                alert.fingerprint,
            )
        else:
            try:
                from backend.notifiers.email_notifier import EmailNotifier
                notifier = EmailNotifier()
                success, error = await notifier.send(alert)
                log = NotificationLog(
                    alert_id=alert.id,
                    channel="email",
                    recipient=",".join(settings.email_to_list) or "configured_recipients",
                    success=success,
                    error=error,
                )
                db.add(log)
                if success:
                    alert.notified_email = True
            except Exception as e:
                logger.exception("Email notifier error: %s", e)

    await db.commit()
