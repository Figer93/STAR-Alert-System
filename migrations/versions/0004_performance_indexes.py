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
    # ------------------------------------------------------------------
    # network_incidents — no secondary indexes existed at all
    # ------------------------------------------------------------------
    op.create_index(
        "ix_network_incidents_resolved_at",
        "network_incidents",
        ["resolved_at"],
    )
    op.create_index(
        "ix_network_incidents_started_at",
        "network_incidents",
        [sa.text("started_at DESC")],
    )

    # ------------------------------------------------------------------
    # latency_metrics — add (target_type, time DESC) for type-filtered scans
    # ------------------------------------------------------------------
    op.create_index(
        "ix_latency_metrics_target_type_time",
        "latency_metrics",
        ["target_type", sa.text("time DESC")],
    )

    # ------------------------------------------------------------------
    # switch_port_metrics — add time-only index for range scans that do not
    # filter by switch_id/port_id (overview COUNT queries, top-devices CTE)
    # ------------------------------------------------------------------
    op.create_index(
        "ix_switch_port_metrics_time",
        "switch_port_metrics",
        [sa.text("time DESC")],
    )

    # ------------------------------------------------------------------
    # device_registry — index is_online for active-device count
    # ------------------------------------------------------------------
    op.create_index(
        "ix_device_registry_is_online",
        "device_registry",
        ["is_online"],
    )

    # ------------------------------------------------------------------
    # alerts — FK and filter columns had no indexes in the initial migration
    # ------------------------------------------------------------------
    op.create_index("ix_alerts_source_id",   "alerts", ["source_id"])
    op.create_index("ix_alerts_status",      "alerts", ["status"])
    op.create_index("ix_alerts_severity",    "alerts", ["severity"])
    op.create_index(
        "ix_alerts_first_seen",
        "alerts",
        [sa.text("first_seen DESC")],
    )
    op.create_index(
        "ix_alerts_last_seen",
        "alerts",
        [sa.text("last_seen DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_alerts_last_seen",                    table_name="alerts")
    op.drop_index("ix_alerts_first_seen",                   table_name="alerts")
    op.drop_index("ix_alerts_severity",                     table_name="alerts")
    op.drop_index("ix_alerts_status",                       table_name="alerts")
    op.drop_index("ix_alerts_source_id",                    table_name="alerts")
    op.drop_index("ix_device_registry_is_online",           table_name="device_registry")
    op.drop_index("ix_switch_port_metrics_time",            table_name="switch_port_metrics")
    op.drop_index("ix_latency_metrics_target_type_time",    table_name="latency_metrics")
    op.drop_index("ix_network_incidents_started_at",        table_name="network_incidents")
    op.drop_index("ix_network_incidents_resolved_at",       table_name="network_incidents")
