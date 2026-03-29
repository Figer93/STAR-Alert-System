import logging
from typing import Tuple
from backend.config import settings
from backend.models import Alert
from backend.notifiers.base import BaseNotifier

logger = logging.getLogger(__name__)
SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535", "ok": "\U0001f7e2"}


class TelegramNotifier(BaseNotifier):
    async def send(self, alert: Alert) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            return False, "Telegram not configured"
        try:
            import telegram
            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            emoji = SEVERITY_EMOJI.get(alert.severity, "\u26aa")
            source_name = alert.source.name if alert.source else "Unknown"
            text = f"{emoji} {alert.severity.upper()} \u2014 {source_name}\n{alert.title}\n\n{alert.message}\n\n\U0001f550 {alert.first_seen.strftime('%H:%M:%S UTC')}  |  ST&R Dashboard"
            for chat_id in settings.telegram_chat_id_list:
                await bot.send_message(chat_id=chat_id, text=text)
            return True, None
        except Exception as e:
            return False, str(e)

    async def send_resolution(self, alert: Alert) -> Tuple[bool, str | None]:
        if not settings.TELEGRAM_BOT_TOKEN or not settings.telegram_chat_id_list:
            return False, "Telegram not configured"
        try:
            import telegram
            bot = telegram.Bot(token=settings.TELEGRAM_BOT_TOKEN)
            source_name = alert.source.name if alert.source else "Unknown"
            for chat_id in settings.telegram_chat_id_list:
                await bot.send_message(chat_id=chat_id, text=f"\u2705 RESOLVED \u2014 {source_name}\n{alert.title}")
            return True, None
        except Exception as e:
            return False, str(e)
