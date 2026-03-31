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

# ── Constants ─────────────────────────────────────────────────────────────────

SEVERITY_COLOUR = {
    "critical": "#dc2626",
    "warning":  "#d97706",
    "info":     "#2563eb",
    "ok":       "#16a34a",
}

DEFAULT_SUBJECT_TEMPLATE            = "[{severity}] {source}: {title}"
DEFAULT_RESOLUTION_SUBJECT_TEMPLATE = "[RESOLVED] {source}: {title}"

# ── Template rendering ────────────────────────────────────────────────────────


class _SafeDict(dict):
    def __missing__(self, key: str) -> str:
        return f"{{{key}}}"


def _build_context(alert: Alert) -> dict:
    source_name = alert.source.name if alert.source else "Unknown"
    first_seen  = alert.first_seen
    return {
        "severity":       alert.severity.upper(),
        "severity_lower": alert.severity,
        "severity_emoji": "",   # not useful in email subject
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
        return template


# ── HTML builders ─────────────────────────────────────────────────────────────

def _build_html(alert: Alert, field_toggles: dict | None = None) -> str:
    ft          = field_toggles or {}
    colour      = SEVERITY_COLOUR.get(alert.severity, "#6b7280")
    source_name = alert.source.name if alert.source else "Unknown"

    show_source    = ft.get("source",    True)
    show_message   = ft.get("message",   True)
    show_timestamp = ft.get("timestamp", True)
    show_count     = ft.get("count",     True)

    header_text   = f"{alert.severity.upper()} — {source_name}" if show_source else alert.severity.upper()
    message_block = f'<p style="color:#94a3b8;">{alert.message}</p>' if show_message else ""

    meta_parts: list[str] = []
    if show_timestamp:
        meta_parts.append(f"First seen: {alert.first_seen.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    if show_count:
        meta_parts.append(f"Occurrences: {alert.occurrence_count}")
    meta_block = "<br>".join(meta_parts)

    return f"""
    <html><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;">
      <div style="max-width:600px;margin:0 auto;border:1px solid #334155;border-radius:8px;overflow:hidden;">
        <div style="background:{colour};padding:12px 20px;">
          <strong style="color:#fff;font-size:16px;">{header_text}</strong>
        </div>
        <div style="padding:20px;">
          <h2 style="margin:0 0 8px;color:#f1f5f9;">{alert.title}</h2>
          {message_block}
          <hr style="border-color:#334155;margin:16px 0;">
          <p style="color:#64748b;font-size:12px;">{meta_block}</p>
        </div>
      </div>
    </body></html>
    """


def _build_resolution_html(alert: Alert, field_toggles: dict | None = None) -> str:
    ft          = field_toggles or {}
    source_name = alert.source.name if alert.source else "Unknown"
    show_source = ft.get("source", True)
    show_timestamp = ft.get("timestamp", True)
    show_count     = ft.get("count",     True)

    header_text = f"&#x2705; RESOLVED — {source_name}" if show_source else "&#x2705; RESOLVED"
    resolved_at = (
        alert.resolved_at.strftime("%Y-%m-%d %H:%M:%S UTC")
        if alert.resolved_at
        else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    )

    meta_parts: list[str] = []
    if show_timestamp:
        meta_parts.append(f"Resolved at: {resolved_at}")
    if show_count:
        meta_parts.append(f"Total occurrences: {alert.occurrence_count}")
    meta_block = "<br>".join(meta_parts)

    return f"""
    <html><body style="font-family:sans-serif;background:#0f172a;color:#f1f5f9;padding:24px;">
      <div style="max-width:600px;margin:0 auto;border:1px solid #334155;border-radius:8px;overflow:hidden;">
        <div style="background:#16a34a;padding:12px 20px;">
          <strong style="color:#fff;font-size:16px;">{header_text}</strong>
        </div>
        <div style="padding:20px;">
          <h2 style="margin:0 0 8px;color:#f1f5f9;">{alert.title}</h2>
          <p style="color:#94a3b8;">This alert has been resolved.</p>
          <hr style="border-color:#334155;margin:16px 0;">
          <p style="color:#64748b;font-size:12px;">{meta_block}</p>
        </div>
      </div>
    </body></html>
    """


# ── Sync send helpers (run in thread) ────────────────────────────────────────

def _send_sync(alert: Alert, ch_settings=None) -> None:
    if not settings.SMTP_USER or not settings.email_to_list:
        raise ValueError("Email not configured")

    ctx = _build_context(alert)
    ft  = ch_settings.field_toggles if ch_settings else None

    subject_tmpl = (
        (ch_settings.subject_template or DEFAULT_SUBJECT_TEMPLATE)
        if ch_settings else DEFAULT_SUBJECT_TEMPLATE
    )
    subject = _render(subject_tmpl, ctx)

    msg             = MIMEMultipart("alternative")
    msg["Subject"]  = subject
    msg["From"]     = settings.EMAIL_FROM or settings.SMTP_USER
    msg["To"]       = ", ".join(settings.email_to_list)
    msg.attach(MIMEText(_build_html(alert, ft), "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(msg["From"], settings.email_to_list, msg.as_string())


def _send_resolution_sync(alert: Alert, ch_settings=None) -> None:
    if not settings.SMTP_USER or not settings.email_to_list:
        raise ValueError("Email not configured")

    ctx = _build_context(alert)
    ft  = ch_settings.field_toggles if ch_settings else None

    subject_tmpl = (
        (ch_settings.resolution_template or DEFAULT_RESOLUTION_SUBJECT_TEMPLATE)
        if ch_settings else DEFAULT_RESOLUTION_SUBJECT_TEMPLATE
    )
    subject = _render(subject_tmpl, ctx)

    msg             = MIMEMultipart("alternative")
    msg["Subject"]  = subject
    msg["From"]     = settings.EMAIL_FROM or settings.SMTP_USER
    msg["To"]       = ", ".join(settings.email_to_list)
    msg.attach(MIMEText(_build_resolution_html(alert, ft), "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(msg["From"], settings.email_to_list, msg.as_string())


# ── Notifier class ────────────────────────────────────────────────────────────

class EmailNotifier(BaseNotifier):
    async def send(self, alert: Alert, ch_settings=None) -> Tuple[bool, str | None]:
        try:
            await asyncio.to_thread(_send_sync, alert, ch_settings)
            logger.info("Email sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Email send failed: %s", e)
            return False, str(e)

    async def send_resolution(self, alert: Alert, ch_settings=None) -> Tuple[bool, str | None]:
        try:
            await asyncio.to_thread(_send_resolution_sync, alert, ch_settings)
            logger.info("Resolution email sent for alert id=%d", alert.id)
            return True, None
        except Exception as e:
            logger.error("Resolution email failed: %s", e)
            return False, str(e)
