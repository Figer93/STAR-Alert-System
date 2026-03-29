import asyncio
import logging
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Tuple

from backend.config import settings
from backend.models import Alert
from backend.notifiers.base import BaseNotifier

logger = logging.getLogger(__name__)

SEVERITY_COLOUR = {
    "critical": "#dc2626",
    "warning": "#d97706",
    "info": "#2563eb",
    "ok": "#16a34a",
}


def _build_html(alert: Alert) -> str:
    colour = SEVERITY_COLOUR.get(alert.severity, "#6b7280")
    source_name = alert.source.name if alert.source else "Unknown"
    return f"""
    <html><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;">
      <div style="max-width:600px;margin:0 auto;border:1px solid #334155;border-radius:8px;overflow:hidden;">
        <div style="background:{colour};padding:12px 20px;">
          <strong style="color:#fff;font-size:16px;">{alert.severity.upper()} — {source_name}</strong>
        </div>
        <div style="padding:20px;">
          <h2 style="margin:0 0 8px;color:#f1f5f9;">{alert.title}</h2>
          <p style="color:#94a3b8;">{alert.message}</p>
          <hr style="border-color:#334155;margin:16px 0;">
          <p style="color:#64748b;font-size:12px;">
            First seen: {alert.first_seen.strftime('%Y-%m-%d %H:%M:%S UTC')}<br>
            Occurrences: {alert.occurrence_count}
          </p>
        </div>
      </div>
    </body></html>
    """


def _build_resolution_html(alert: Alert) -> str:
    source_name = alert.source.name if alert.source else "Unknown"
    resolved_at = (
        alert.resolved_at.strftime("%Y-%m-%d %H:%M:%S UTC")
        if alert.resolved_at
        else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    )
    return f"""
    <html><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;">
      <div style="max-width:600px;margin:0 auto;border:1px solid #334155;border-radius:8px;overflow:hidden;">
        <div style="background:#16a34a;padding:12px 20px;">
          <strong style="color:#fff;font-size:16px;">&#x2705; RESOLVED — {source_name}</strong>
        </div>
        <div style="padding:20px;">
          <h2 style="margin:0 0 8px;color:#f1f5f9;">{alert.title}</h2>
          <p style="color:#94a3b8;">This alert has been resolved.</p>
          <hr style="border-color:#334155;margin:16px 0;">
          <p style="color:#64748b;font-size:12px;">
            Resolved at: {resolved_at}<br>
            Total occurrences: {alert.occurrence_count}
          </p>
        </div>
      </div>
    </body></html>
    """


def _send_resolution_sync(alert: Alert):
    if not settings.SMTP_USER or not settings.email_to_list:
        raise ValueError("Email not configured")

    msg = MIMEMultipart("alternative")
    source_name = alert.source.name if alert.source else "Unknown"
    msg["Subject"] = f"[RESOLVED] {source_name}: {alert.title}"
    msg["From"] = settings.EMAIL_FROM or settings.SMTP_USER
    msg["To"] = ", ".join(settings.email_to_list)
    msg.attach(MIMEText(_build_resolution_html(alert), "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(msg["From"], settings.email_to_list, msg.as_string())


def _send_sync(alert: Alert):
    if not settings.SMTP_USER or not settings.email_to_list:
        raise ValueError("Email not configured")

    msg = MIMEMultipart("alternative")
    source_name = alert.source.name if alert.source else "Unknown"
    msg["Subject"] = f"[{alert.severity.upper()}] {source_name}: {alert.title}"
    msg["From"] = settings.EMAIL_FROM or settings.SMTP_USER
    msg["To"] = ", ".join(settings.email_to_list)
    msg.attach(MIMEText(_build_html(alert), "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(msg["From"], settings.email_to_list, msg.as_string())


class EmailNotifier(BaseNotifier):
    async def send(self, alert: Alert) -> Tuple[bool, str | None]:
        try:
            await asyncio.to_thread(_send_sync, alert)
            logger.info("Email sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Email send failed: %s", e)
            return False, str(e)

    async def send_resolution(self, alert: Alert) -> Tuple[bool, str | None]:
        try:
            await asyncio.to_thread(_send_resolution_sync, alert)
            logger.info("Resolution email sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Resolution email failed: %s", e)
            return False, str(e)
