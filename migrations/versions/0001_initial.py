"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2026-03-29
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

source_type_enum   = sa.Enum("webhook", "syslog", "poll", "push",            name="source_type")
source_status_enum = sa.Enum("online", "offline", "unknown",                  name="source_status")
alert_severity_enum= sa.Enum("critical", "warning", "info", "ok",             name="alert_severity")
alert_status_enum  = sa.Enum("active", "acknowledged", "resolved",            name="alert_status")
rule_severity_enum = sa.Enum("critical", "warning", "info", "ok",             name="rule_severity")


def upgrade() -> None:
    bind = op.get_bind()
    source_type_enum.create(bind, checkfirst=True)
    source_status_enum.create(bind, checkfirst=True)
    alert_severity_enum.create(bind, checkfirst=True)
    alert_status_enum.create(bind, checkfirst=True)
    rule_severity_enum.create(bind, checkfirst=True)

    op.create_table("sources",
        sa.Column("id",         sa.Integer(),               primary_key=True),
        sa.Column("name",       sa.String(100),             nullable=False),
        sa.Column("slug",       sa.String(50),              nullable=False),
        sa.Column("adapter",    sa.String(100),             nullable=False),
        sa.Column("type",       source_type_enum,           nullable=False),
        sa.Column("enabled",    sa.Boolean(),               nullable=False, server_default="true"),
        sa.Column("config",     sa.JSON(),                  nullable=False, server_default="{}"),
        sa.Column("last_seen",  sa.DateTime(timezone=True), nullable=True),
        sa.Column("status",     source_status_enum,         nullable=False, server_default="unknown"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("slug", name="uq_sources_slug"),
    )
    op.create_index("ix_sources_slug", "sources", ["slug"])

    op.create_table("rules",
        sa.Column("id",               sa.Integer(),               primary_key=True),
        sa.Column("name",             sa.String(255),             nullable=False),
        sa.Column("source_slug",      sa.String(50),              nullable=True),
        sa.Column("condition",        sa.JSON(),                  nullable=False, server_default="{}"),
        sa.Column("severity_override",rule_severity_enum,         nullable=True),
        sa.Column("action",           sa.String(50),              nullable=False, server_default="notify"),
        sa.Column("notify_telegram",  sa.Boolean(),               nullable=False, server_default="true"),
        sa.Column("notify_email",     sa.Boolean(),               nullable=False, server_default="false"),
        sa.Column("cooldown_minutes", sa.Integer(),               nullable=False, server_default="15"),
        sa.Column("enabled",          sa.Boolean(),               nullable=False, server_default="true"),
        sa.Column("created_at",       sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table("alerts",
        sa.Column("id",               sa.Integer(),               primary_key=True),
        sa.Column("source_id",        sa.Integer(),               sa.ForeignKey("sources.id"), nullable=True),
        sa.Column("severity",         alert_severity_enum,        nullable=False),
        sa.Column("title",            sa.String(255),             nullable=False),
        sa.Column("message",          sa.Text(),                  nullable=False),
        sa.Column("raw_payload",      sa.JSON(),                  nullable=False, server_default="{}"),
        sa.Column("fingerprint",      sa.String(64),              nullable=False),
        sa.Column("status",           alert_status_enum,          nullable=False, server_default="active"),
        sa.Column("first_seen",       sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen",        sa.DateTime(timezone=True), nullable=False),
        sa.Column("occurrence_count", sa.Integer(),               nullable=False, server_default="1"),
        sa.Column("notified_telegram",sa.Boolean(),               nullable=False, server_default="false"),
        sa.Column("notified_email",   sa.Boolean(),               nullable=False, server_default="false"),
        sa.Column("acknowledged_by",  sa.String(100),             nullable=True),
        sa.Column("acknowledged_at",  sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at",      sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_alerts_fingerprint", "alerts", ["fingerprint"])

    op.create_table("notification_logs",
        sa.Column("id",        sa.Integer(),               primary_key=True),
        sa.Column("alert_id",  sa.Integer(),               sa.ForeignKey("alerts.id"), nullable=False),
        sa.Column("channel",   sa.String(50),              nullable=False),
        sa.Column("recipient", sa.String(255),             nullable=False),
        sa.Column("sent_at",   sa.DateTime(timezone=True), nullable=False),
        sa.Column("success",   sa.Boolean(),               nullable=False),
        sa.Column("error",     sa.String(500),             nullable=True),
    )


def downgrade() -> None:
    op.drop_table("notification_logs")
    op.drop_table("alerts")
    op.drop_table("rules")
    op.drop_table("sources")
    bind = op.get_bind()
    for e in [rule_severity_enum, alert_status_enum, alert_severity_enum, source_status_enum, source_type_enum]:
        e.drop(bind, checkfirst=True)
