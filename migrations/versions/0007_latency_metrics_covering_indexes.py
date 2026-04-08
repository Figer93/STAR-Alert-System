"""Covering indexes on latency_metrics + ANALYZE to refresh planner stats

Revision ID: 0007
Revises: 0006
Create Date: 2026-04-08

latency_metrics — two slow queries identified in logs:

  Query 1 (1.5s):
    SELECT DISTINCT ON (target_name) target_name, target_type
    FROM latency_metrics
    WHERE target_name = ANY($1)
    ORDER BY target_name, time DESC
    Fix: replace ix_latency_metrics_target_time (no INCLUDE) with
    ix_latency_metrics_target_name_time (target_name, time DESC) INCLUDE (target_type).
    The INCLUDE means target_type is fetched from the index leaf without a heap access.

  Query 2 (0.5s):
    SELECT date_trunc('minute', time) AS bucket, target_name,
           AVG(rtt_ms), AVG(packet_loss_pct)
    FROM latency_metrics
    WHERE time >= NOW() - INTERVAL '1 hour'
    GROUP BY bucket, target_name
    Fix: new ix_latency_metrics_time_target (time DESC, target_name)
    INCLUDE (rtt_ms, packet_loss_pct) — time-first ordering matches the range
    filter; INCLUDE covers the two AVG columns without heap access.

  ANALYZE latency_metrics and ANALYZE alerts run after index creation so the
  planner picks up current row counts and column statistics immediately.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    # Drop the old non-covering index so the new one takes its place cleanly.
    # The new index covers the same (target_name, time DESC) columns plus
    # target_type in the INCLUDE clause.
    bind.execute(sa.text(
        "DROP INDEX IF EXISTS ix_latency_metrics_target_time"
    ))

    statements = [
        # Query 1: DISTINCT ON (target_name) ... ORDER BY target_name, time DESC
        "CREATE INDEX IF NOT EXISTS ix_latency_metrics_target_name_time "
        "ON latency_metrics (target_name, time DESC) "
        "INCLUDE (target_type)",

        # Query 2: WHERE time >= NOW() - INTERVAL ... GROUP BY bucket, target_name
        "CREATE INDEX IF NOT EXISTS ix_latency_metrics_time_target "
        "ON latency_metrics (time DESC, target_name) "
        "INCLUDE (rtt_ms, packet_loss_pct)",

        # Refresh planner statistics so the new indexes are used immediately
        "ANALYZE latency_metrics",
        "ANALYZE alerts",
    ]
    for stmt in statements:
        bind.execute(sa.text(stmt))


def downgrade() -> None:
    bind = op.get_bind()

    bind.execute(sa.text(
        "DROP INDEX IF EXISTS ix_latency_metrics_time_target"
    ))
    bind.execute(sa.text(
        "DROP INDEX IF EXISTS ix_latency_metrics_target_name_time"
    ))
    # Restore the original non-covering index
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_latency_metrics_target_time "
        "ON latency_metrics (target_name, time DESC)"
    ))
