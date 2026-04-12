"""Phase 3 — Timeline & Error History

Creates port_error_events and network_events tables.
Adds last_error_at / last_error_desc columns to device_registry.

Revision ID: 0014
Revises: 0013
Create Date: 2026-04-11

port_error_events  — one row per poll cycle where a port had rx/tx errors > 0.
                     Used for the "Last Error" column in the Ports table and
                     error-history sparklines.

network_events     — unified timeline: port errors, device online/offline,
                     latency spikes, incident created/resolved.
                     Queried by the Investigation and Timeline pages.

device_registry    — last_error_at / last_error_desc updated whenever a port
                     for that device records errors_delta > 0.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # network tables only exist on PostgreSQL

    # ── port_error_events ─────────────────────────────────────────────────────
    bind.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS port_error_events (
            id              BIGSERIAL PRIMARY KEY,
            switch_id       TEXT NOT NULL,
            port_id         TEXT NOT NULL,
            device_name     TEXT,
            device_ip       INET,
            rx_errors_delta INTEGER NOT NULL DEFAULT 0,
            tx_errors_delta INTEGER NOT NULL DEFAULT 0,
            occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_port_error_events_switch_port_time
            ON port_error_events (switch_id, port_id, occurred_at DESC)
    """))
    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_port_error_events_device_ip_time
            ON port_error_events (device_ip, occurred_at DESC)
    """))

    # ── network_events ────────────────────────────────────────────────────────
    # event_type values:
    #   port_error, device_offline, device_online, latency_spike,
    #   incident_created, incident_resolved
    bind.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS network_events (
            id          BIGSERIAL PRIMARY KEY,
            event_type  TEXT NOT NULL,
            device_ip   INET,
            target_ip   INET,
            incident_id UUID,
            description TEXT,
            metadata    JSONB,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_network_events_device_ip_time
            ON network_events (device_ip, occurred_at DESC)
    """))
    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_network_events_incident_id
            ON network_events (incident_id)
    """))
    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_network_events_type_time
            ON network_events (event_type, occurred_at DESC)
    """))

    # ── device_registry additions ─────────────────────────────────────────────
    bind.execute(sa.text("""
        ALTER TABLE device_registry
            ADD COLUMN IF NOT EXISTS last_error_at   TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_error_desc  TEXT
    """))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("DROP TABLE IF EXISTS network_events"))
    bind.execute(sa.text("DROP TABLE IF EXISTS port_error_events"))
    bind.execute(sa.text("""
        ALTER TABLE device_registry
            DROP COLUMN IF EXISTS last_error_at,
            DROP COLUMN IF EXISTS last_error_desc
    """))
