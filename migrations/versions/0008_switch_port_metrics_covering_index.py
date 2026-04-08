"""Covering index on switch_port_metrics for 24h error history query

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-08

switch_port_metrics
  The slow query on /api/network/ports (3s) is:
    SELECT date_trunc('hour', time) AS bucket, SUM(rx_errors), SUM(tx_errors)
    FROM switch_port_metrics
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY switch_id, port_id, bucket
    ORDER BY switch_id, port_id, bucket

  The existing ix_switch_port_metrics_switch_port_time index covers
  (switch_id, port_id, time DESC) but has no INCLUDE clause, so the DB
  must visit the heap to fetch rx_errors and tx_errors for every row in
  the 24-hour window.

  The new index adds INCLUDE (rx_errors, tx_errors), making the GROUP BY
  aggregation an index-only scan for the error history query.

  ix_switch_port_metrics_switch_port_time (from migration 0003) is left in
  place — it is still used by the ranked/latest CTE in the main ports query.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_switch_port_metrics_errors_covering "
        "ON switch_port_metrics (switch_id, port_id, time DESC) "
        "INCLUDE (rx_errors, tx_errors)"
    ))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DROP INDEX IF EXISTS ix_switch_port_metrics_errors_covering"
    ))
