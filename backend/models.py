from datetime import datetime, timezone
from sqlalchemy import (
    Integer, String, Text, Boolean, DateTime, ForeignKey, JSON, Enum as SAEnum
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    slug: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    adapter: Mapped[str] = mapped_column(String(100))
    type: Mapped[str] = mapped_column(SAEnum("webhook", "syslog", "poll", "push", name="source_type"))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(
        SAEnum("online", "offline", "unknown", name="source_status"), default="unknown"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    alerts: Mapped[list["Alert"]] = relationship("Alert", back_populates="source")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sources.id"), nullable=True)
    severity: Mapped[str] = mapped_column(
        SAEnum("critical", "warning", "info", "ok", name="alert_severity")
    )
    title: Mapped[str] = mapped_column(String(255))
    message: Mapped[str] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(
        SAEnum("active", "acknowledged", "resolved", name="alert_status"), default="active"
    )
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    occurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    notified_telegram: Mapped[bool] = mapped_column(Boolean, default=False)
    notified_email: Mapped[bool] = mapped_column(Boolean, default=False)
    acknowledged_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    source: Mapped["Source | None"] = relationship("Source", back_populates="alerts")
    notification_logs: Mapped[list["NotificationLog"]] = relationship(
        "NotificationLog", back_populates="alert"
    )


class Rule(Base):
    __tablename__ = "rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    source_slug: Mapped[str | None] = mapped_column(String(50), nullable=True)
    condition: Mapped[dict] = mapped_column(JSON, default=dict)
    severity_override: Mapped[str | None] = mapped_column(
        SAEnum("critical", "warning", "info", "ok", name="rule_severity"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(50), default="notify")
    notify_telegram: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_email: Mapped[bool] = mapped_column(Boolean, default=False)
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=15)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NotificationLog(Base):
    __tablename__ = "notification_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alert_id: Mapped[int] = mapped_column(Integer, ForeignKey("alerts.id"))
    channel: Mapped[str] = mapped_column(String(50))
    recipient: Mapped[str] = mapped_column(String(255))
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    success: Mapped[bool] = mapped_column(Boolean)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    alert: Mapped["Alert"] = relationship("Alert", back_populates="notification_logs")


class NotificationChannelSettings(Base):
    """
    Per-channel notification configuration (one row per channel).
    Two rows are auto-seeded on startup: "telegram" and "email".
    """
    __tablename__ = "notification_channel_settings"

    channel: Mapped[str] = mapped_column(String(20), primary_key=True)

    # Global toggles
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    send_resolutions: Mapped[bool] = mapped_column(Boolean, default=False)

    # Severity filter — comma-separated list e.g. "critical,warning"
    # Empty string means "send for all severities"
    severity_filter: Mapped[str] = mapped_column(String(60), default="")

    # Message templates — empty string means "use built-in default"
    message_template: Mapped[str] = mapped_column(Text, default="")
    resolution_template: Mapped[str] = mapped_column(Text, default="")

    # Field inclusion toggles stored as JSON: {source, timestamp, count, message}
    field_toggles: Mapped[dict] = mapped_column(JSON, default=dict)

    # Telegram-specific
    parse_mode: Mapped[str] = mapped_column(String(10), default="plain")

    # Email-specific
    subject_template: Mapped[str] = mapped_column(String(500), default="")

    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
