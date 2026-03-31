import logging
from typing import Tuple, Optional

from backend.config import settings
from backend.models import Alert
from backend.notifiers.base import BaseNotifier

logger = logging.getLogger(__name__)

# ── Severity helpers ──────────────────────────────────────────────────────────

SEVERITY_EMOJI = {
    "critical": "🔴",
    "warning":  "🟡",
    "info":     "🔵",
    "ok":       "🟢",
}

# ── Default templates (reproduce existing hardcoded behaviour) ────────────────

DEFAULT_TEMPLATE = (
    "{severity_emoji} {severity} — {source}\n"
    "{title}\n\n"
    "{message}\n\n"
    "🕐 {time}  |  ST&R Dashboard"
)

DEFAULT_RESOLUTION_TEMPLATE = "✅ RESOLVED — {source}\n{title}"

# ── Template rendering ────────────────────────────────────────────────────────


class _SafeDict(dict):
    """Return '{key}' for any missing placeholder so format_map never raises."""
    def __missing__(self, key: str) -> str:
        return f"{{{key}}}"


def _build_context(alert: Alert) -> dict:
    source_name = alert.source.name if alert.source else "Unknown"
    first_seen  = alert.first_seen
    return {
        "severity":       alert.severity.upper(),
        "severity_lower": alert.severity,
        "severity_emoji": SEVERITY_EMOJI.get(alert.severity, "⚪"),
        "source":         source_name,
        "title":          alert.title,
        "message":        alert.message,
        "time":           first_seen.strftime("%H:%M:%S UTC"),
        "date":           first_seen.strftime("%Y-%m-%d"),
        "datetime":       first_seen.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "count":          str(alert.occurrence_count),
    }


def _render(template: str, ctx: dict) -> str:
    try:
        return template.format_map(_SafeDict(ctx))
    except Exception:
        return template   # last resort: return template as-is


def _format_message(alert: Alert, ch_settings=None) -> str:
    ctx = _build_context(alert)

    if ch_settings:
        ft = ch_settings.field_toggles or {}
        # Blank out context values for disabled fields so they render as empty
        if not ft.get("source", True):
            ctx["source"] = ""
        if not ft.get("timestamp", True):
            ctx["time"] = ctx["date"] = ctx["datetime"] = ""
        if not ft.get("count", True):
            ctx["count"] = ""
        if not ft.get("message", True):
            ctx["message"] = ""

        tmpl = ch_settings.message_template or DEFAULT_TEMPLATE
    else:
        tmpl = DEFAULT_TEMPLATE

    return _render(tmpl, ctx)


def _format_resolution(alert: Alert, ch_settings=None) -> str:
    ctx = _build_context(alert)
    if ch_settings:
        tmpl = ch_settings.resolution_template or DEFAULT_RESOLUTION_TEMPLATE
    else:
        tmpl = DEFAULT_RESOLUTION_TEMPLATE
    return _render(tmpl, ctx)


# ── Notifier class ────────────────────────────────────────────────────────────

class TelegramNotifier(BaseNotifier):
    async def send(self, alert: Alert, ch_settings=None) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            logger.debug("Telegram not configured — skipping notification")
            return False, "Telegram not configured"

        try:
            import telegram

            text = _format_message(alert, ch_settings)

            parse_mode_arg: Optional[str] = None
            if ch_settings and ch_settings.parse_mode == "html":
                parse_mode_arg = "HTML"

            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            for chat_id in settings.telegram_chat_id_list:
                kwargs = {"chat_id": chat_id, "text": text}
                if parse_mode_arg:
                    kwargs["parse_mode"] = parse_mode_arg
                await bot.send_message(**kwargs)

            logger.info("Telegram notification sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Telegram send failed: %s", e)
            return False, str(e)

    async def send_resolution(self, alert: Alert, ch_settings=None) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            return False, "Telegram not configured"

        try:
            import telegram

            text = _format_resolution(alert, ch_settings)

            parse_mode_arg: Optional[str] = None
            if ch_settings and ch_settings.parse_mode == "html":
                parse_mode_arg = "HTML"

            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            for chat_id in settings.telegram_chat_id_list:
                kwargs = {"chat_id": chat_id, "text": text}
                if parse_mode_arg:
                    kwargs["parse_mode"] = parse_mode_arg
                await bot.send_message(**kwargs)

            return True, None
        except Exception as e:
            logger.error("Telegram resolution send failed: %s", e)
            return False, str(e)
