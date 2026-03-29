import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Tuple
from backend.config import settings
from backend.models import Alert
from backend.notifiers.base import BaseNotifier

logger = logging.getLogger(__name__)
SEVERITY_COLOUR = {"critical": "#dc2626", "warning": "#d97706", "info": "#2563eb", "ok": "#16a34a"}


def _send_sync(alert: Alert):
    if not settings.SMTP_USER or not settings.email_to_list:
        raise ValueError("Email not configured")
    colour = SEVERITY_COLOUR.get(alert.severity, "#6b7280")
    source_name = alert.source.name if alert.source else "Unknown"
    html = f'<html><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;"><div style="max-width:600px;margin:0 auto;border:1px solid #334155;border-radius:8px;overflow:hidden;"><div style="background:{colour};padding:12px 20px;"><strong style="color:#fff;">{alert.severity.upper()} \u2014 {source_name}</strong></div><div style="padding:20px;"><h2>{alert.title}</h2><p style="color:#94a3b8;">{alert.message}</p></div></div></body></html>'
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[{alert.severity.upper()}] {source_name}: {alert.title}"
    msg["From"] = settings.EMAIL_FROM or settings.SMTP_USER
    msg["To"] = ", ".join(settings.email_to_list)
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as s:
        s.starttls()
        s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        s.sendmail(msg["From"], settings.email_to_list, msg.as_string())


class EmailNotifier(BaseNotifier):
    async def send(self, alert: Alert) -> Tuple[bool, str | None]:
        try:
            await asyncio.to_thread(_send_sync, alert)
            return True, None
        except Exception as e:
            return False, str(e)

    async def send_resolution(self, alert: Alert) -> Tuple[bool, str | None]:
        return await self.send(alert)
