"""Composite index on switch_port_metrics (switch_id, time DESC)

Revision ID: 0011
Revises: 0010
Create Date: 2026-04-09

Adds idx_spm_switch_time to accelerate the DISTINCT ON (switch_id) query:

    SELECT DISTINCT ON (switch_id) switch_id, switch_name
    FROM switch_port_metrics ORDER BY switch_id, time DESC

This is a targeted index without the INCLUDE clause from 0009 so PostgreSQL
can use it as a smaller, more cache-friendly structure for queries that only
need switch_id and time.  Both indexes can coexist; the planner picks the
cheaper one.

CONCURRENTLY is used so the index build does not acquire an exclusive table
lock, keeping the production table readable during the migration.  Because
CONCURRENTLY cannot run inside a transaction block, this migration commits
any implicit transaction before issuing the CREATE INDEX statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # network tables only exist on PostgreSQL

    # CONCURRENTLY requires running outside an explicit transaction block.
    # Commit any open transaction first so the CREATE INDEX can proceed.
    bind.execute(sa.text("COMMIT"))
    bind.execute(sa.text(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spm_switch_time "
        "ON switch_port_metrics (switch_id, time DESC)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("COMMIT"))
    bind.execute(sa.text(
        "DROP INDEX CONCURRENTLY IF EXISTS idx_spm_switch_time"
    ))
