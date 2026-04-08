"""Performance indexes for network monitor and alert tables

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-08

Adds indexes that were missing and causing full table scans on the five
slow network endpoints (/overview, /ports, /latency, /incidents, /top-devices)
and on the core alerts table.

network_incidents
  - (resolved_at)           WHERE resolved_at IS NULL/NOT NULL
  - (started_at DESC)       ORDER BY started_at DESC

latency_metrics
  - (target_type, time DESC)  WHERE target_type IN (...) — overview queries

switch_port_metrics
  - (time DESC)               time-only range scans (overview counts, top-devices CTE)

device_registry
  - (is_online)               WHERE is_online = true

alerts
  - (source_id)               FK — not indexed in 0001
  - (status)                  WHERE status IN (...)
  - (severity)                WHERE/GROUP BY severity
  - (first_seen DESC)         ORDER BY first_seen DESC
  - (last_seen DESC)          ORDER BY last_seen DESC
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    # Use raw SQL so IF NOT EXISTS is guaranteed regardless of Alembic version.
    # op.create_index(if_not_exists=True) does not emit IF NOT EXISTS on all
    # versions of the installed Alembic/asyncpg stack.
    bind = op.get_bind()
    statements = [
        # network_incidents — no secondary indexes existed at all
        "CREATE INDEX IF NOT EXISTS ix_network_incidents_resolved_at ON network_incidents (resolved_at)",
        "CREATE INDEX IF NOT EXISTS ix_network_incidents_started_at  ON network_incidents (started_at DESC)",
        # latency_metrics — (target_type, time DESC) for type-filtered overview scans
        "CREATE INDEX IF NOT EXISTS ix_latency_metrics_target_type_time ON latency_metrics (target_type, time DESC)",
        # switch_port_metrics — time-only index for range scans without switch_id filter
        "CREATE INDEX IF NOT EXISTS ix_switch_port_metrics_time ON switch_port_metrics (time DESC)",
        # device_registry — is_online for active-device COUNT
        "CREATE INDEX IF NOT EXISTS ix_device_registry_is_online ON device_registry (is_online)",
        # alerts — FK and filter columns missing from initial migration
        "CREATE INDEX IF NOT EXISTS ix_alerts_source_id  ON alerts (source_id)",
        "CREATE INDEX IF NOT EXISTS ix_alerts_status     ON alerts (status)",
        "CREATE INDEX IF NOT EXISTS ix_alerts_severity   ON alerts (severity)",
        "CREATE INDEX IF NOT EXISTS ix_alerts_first_seen ON alerts (first_seen DESC)",
        "CREATE INDEX IF NOT EXISTS ix_alerts_last_seen  ON alerts (last_seen DESC)",
    ]
    for stmt in statements:
        bind.execute(sa.text(stmt))


def downgrade() -> None:
    bind = op.get_bind()
    for idx in (
        "ix_alerts_last_seen",
        "ix_alerts_first_seen",
        "ix_alerts_severity",
        "ix_alerts_status",
        "ix_alerts_source_id",
        "ix_device_registry_is_online",
        "ix_switch_port_metrics_time",
        "ix_latency_metrics_target_type_time",
        "ix_network_incidents_started_at",
        "ix_network_incidents_resolved_at",
    ):
        bind.execute(sa.text(f"DROP INDEX IF EXISTS {idx}"))
