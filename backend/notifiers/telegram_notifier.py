import logging
from typing import Tuple

from backend.config import settings
from backend.models import Alert
from backend.notifiers.base import BaseNotifier

logger = logging.getLogger(__name__)

SEVERITY_EMOJI = {
    "critical": "🔴",
    "warning": "🟡",
    "info": "🔵",
    "ok": "🟢",
}


def _format_message(alert: Alert) -> str:
    emoji = SEVERITY_EMOJI.get(alert.severity, "⚪")
    severity_label = alert.severity.upper()
    source_name = alert.source.name if alert.source else "Unknown"
    time_str = alert.first_seen.strftime("%H:%M:%S UTC")

    return (
        f"{emoji} {severity_label} — {source_name}\n"
        f"{alert.title}\n\n"
        f"{alert.message}\n\n"
        f"🕐 {time_str}  |  ST&R Dashboard"
    )


def _format_resolution(alert: Alert) -> str:
    source_name = alert.source.name if alert.source else "Unknown"
    return f"✅ RESOLVED — {source_name}\n{alert.title}"


class TelegramNotifier(BaseNotifier):
    async def send(self, alert: Alert) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            logger.debug("Telegram not configured — skipping notification")
            return False, "Telegram not configured"

        try:
            import telegram
            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            text = _format_message(alert)

            for chat_id in settings.telegram_chat_id_list:
                await bot.send_message(chat_id=chat_id, text=text)

            logger.info("Telegram notification sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Telegram send failed: %s", e)
            return False, str(e)

    async def send_resolution(self, alert: Alert) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            return False, "Telegram not configured"

        try:
            import telegram
            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            text = _format_resolution(alert)

            for chat_id in settings.telegram_chat_id_list:
                await bot.send_message(chat_id=chat_id, text=text)

            return True, None
        except Exception as e:
            logger.error("Telegram resolution send failed: %s", e)
            return False, str(e)
