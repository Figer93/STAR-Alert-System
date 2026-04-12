"""Add incident_scope and affected_component to network_incidents

Revision ID: 0013
Revises: 0012
Create Date: 2026-04-11

incident_scope:        'global' for WAN/ISP/FULL_OUTAGE incidents that affect the whole
                       network; 'device' for incidents scoped to a single device/port.
affected_component:    Human-readable component label (e.g. 'WAN1', 'DC_PRIMARY') used
                       to surface the affected component in the UI without parsing titles.

Global root causes (always incident_scope='global'):
  WAN_ISP, WAN_LINE, WAN1_DOWN, WAN2_DOWN, FULL_OUTAGE, ALL_INTERNAL

Device root causes (always incident_scope='device'):
  PFSENSE, DC_PRIMARY, DC_SECONDARY, VLAN2_DC, and all non-WAN categories.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # network tables only exist on PostgreSQL

    bind.execute(sa.text("""
        ALTER TABLE network_incidents
          ADD COLUMN IF NOT EXISTS incident_scope TEXT NOT NULL DEFAULT 'device'
            CHECK (incident_scope IN ('global', 'device')),
          ADD COLUMN IF NOT EXISTS affected_component TEXT
    """))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("""
        ALTER TABLE network_incidents
          DROP COLUMN IF EXISTS incident_scope,
          DROP COLUMN IF EXISTS affected_component
    """))
