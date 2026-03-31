import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Alert, NotificationLog
from backend.rule_engine import RuleEngineResult
from backend.config import settings

logger = logging.getLogger(__name__)

# ── Channel settings cache ────────────────────────────────────────────────────
# Loaded from DB on first use, busted when settings are saved via the API.

_ch_cache: dict = {}
_ch_cache_time: float = 0.0
_CH_CACHE_TTL: float = 30.0   # seconds


def invalidate_channel_settings_cache() -> None:
    global _ch_cache_time
    _ch_cache_time = 0.0


async def _load_channel_settings(db: AsyncSession) -> dict:
    global _ch_cache, _ch_cache_time
    now = time.monotonic()
    if _ch_cache and (now - _ch_cache_time) < _CH_CACHE_TTL:
        return _ch_cache

    from backend.models import NotificationChannelSettings
    result = await db.execute(select(NotificationChannelSettings))
    rows = result.scalars().all()
    _ch_cache = {row.channel: row for row in rows}
    _ch_cache_time = now
    return _ch_cache


def _severity_allowed(alert_severity: str, severity_filter: str) -> bool:
    """Return True if alert_severity passes the channel's severity filter.
    An empty filter string means all severities are allowed."""
    if not severity_filter:
        return True
    allowed = {s.strip() for s in severity_filter.split(",") if s.strip()}
    return alert_severity in allowed


# ── Cooldown check ────────────────────────────────────────────────────────────

async def _within_cooldown(
    alert: Alert, channel: str, cooldown_minutes: int, db: AsyncSession
) -> bool:
    """Return True if a successful notification was already sent for this
    fingerprint+channel within the cooldown window."""
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


# ── Dispatch ──────────────────────────────────────────────────────────────────

async def dispatch(alert: Alert, rule_result: RuleEngineResult, db: AsyncSession):
    # Maintenance mode suppresses all outbound notifications
    from backend.maintenance import maintenance as _maintenance
    if _maintenance.active:
        logger.info(
            "Maintenance mode active — skipping notifications for alert id=%d", alert.id
        )
        return

    # Load channel settings (cached)
    ch_settings = await _load_channel_settings(db)
    tg_settings = ch_settings.get("telegram")
    em_settings = ch_settings.get("email")

    # ── Resolve notify_telegram ───────────────────────────────────────────────
    # Rule explicitly set the flag → honour it, but still apply severity filter.
    # Rule left it None → use channel settings (enabled + severity_filter).
    if rule_result.notify_telegram is not None:
        notify_telegram = rule_result.notify_telegram
        if notify_telegram and tg_settings:
            notify_telegram = _severity_allowed(alert.severity, tg_settings.severity_filter)
    else:
        if tg_settings:
            notify_telegram = (
                tg_settings.enabled
                and _severity_allowed(alert.severity, tg_settings.severity_filter)
            )
        else:
            notify_telegram = True   # fallback: old behaviour if no settings row exists

    # ── Resolve notify_email ──────────────────────────────────────────────────
    if rule_result.notify_email is not None:
        notify_email = rule_result.notify_email
        if notify_email and em_settings:
            notify_email = _severity_allowed(alert.severity, em_settings.severity_filter)
    else:
        if em_settings:
            notify_email = (
                em_settings.enabled
                and _severity_allowed(alert.severity, em_settings.severity_filter)
            )
        else:
            # Legacy fallback: email only for critical
            notify_email = alert.severity == "critical"

    # ── Cooldown ──────────────────────────────────────────────────────────────
    if rule_result.cooldown_minutes is not None:
        cooldown = rule_result.cooldown_minutes
    elif alert.severity == "critical":
        cooldown = settings.CRITICAL_COOLDOWN_MINUTES
    else:
        cooldown = settings.DEFAULT_COOLDOWN_MINUTES

    # ── Send Telegram ─────────────────────────────────────────────────────────
    if notify_telegram:
        if await _within_cooldown(alert, "telegram", cooldown, db):
            logger.debug(
                "Telegram notification suppressed by cooldown (%dm) for fingerprint=%s",
                cooldown, alert.fingerprint,
            )
        else:
            try:
                from backend.notifiers.telegram_notifier import TelegramNotifier
                notifier = TelegramNotifier()
                success, error = await notifier.send(alert, ch_settings=tg_settings)
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

    # ── Send Email ────────────────────────────────────────────────────────────
    if notify_email:
        if await _within_cooldown(alert, "email", cooldown, db):
            logger.debug(
                "Email notification suppressed by cooldown (%dm) for fingerprint=%s",
                cooldown, alert.fingerprint,
            )
        else:
            try:
                from backend.notifiers.email_notifier import EmailNotifier
                notifier = EmailNotifier()
                success, error = await notifier.send(alert, ch_settings=em_settings)
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
