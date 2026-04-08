"""Covering index on switch_port_metrics for DISTINCT ON switch_id query

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-08

switch_port_metrics
  The DISTINCT ON (switch_id) query used by the switch_names cache warm-up
  and cache-miss path in /api/network/devices:

    SELECT DISTINCT ON (switch_id) switch_id, switch_name
    FROM switch_port_metrics
    ORDER BY switch_id, time DESC

  Without a suitable index this scans the entire table (18s on first load).

  New index: (switch_id, time DESC) INCLUDE (switch_name)
    - switch_id + time DESC matches the DISTINCT ON + ORDER BY exactly,
      so PostgreSQL can satisfy the query with a single forward index scan,
      picking the first (most-recent) row per switch_id.
    - INCLUDE (switch_name) makes it a covering index — switch_name is
      read from the index leaf page without any heap access.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.get_bind().execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_switch_port_metrics_switch_id_time_name "
        "ON switch_port_metrics (switch_id, time DESC) "
        "INCLUDE (switch_name)"
    ))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DROP INDEX IF EXISTS ix_switch_port_metrics_switch_id_time_name"
    ))
