"""Add delta columns to switch_port_metrics for accurate per-interval accounting

Revision ID: 0012
Revises: 0011
Create Date: 2026-04-10

UniFi API returns cumulative counters since switch boot, not per-interval values.
These delta columns store the change since the last reading so that UI queries
can display meaningful rates (errors/hr, MB/s) instead of ever-growing totals.

New columns:
  rx_errors_delta  — rx error count change since previous poll cycle
  tx_errors_delta  — tx error count change since previous poll cycle
  rx_bytes_delta   — rx bytes change since previous poll cycle (BIGINT)
  tx_bytes_delta   — tx bytes change since previous poll cycle (BIGINT)
  is_counter_reset — TRUE when a negative delta was detected (switch rebooted)

A partial index (idx_spm_errors_delta) is added to accelerate queries that
filter for rows where errors actually occurred — the common case for the
Ports error history view.

CONCURRENTLY is used for the index build so the production table remains
readable during the migration.  Because CONCURRENTLY cannot run inside a
transaction block, this migration commits the ALTER TABLE transaction first
before issuing the CREATE INDEX statement.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # network tables only exist on PostgreSQL

    # Add delta columns inside the current transaction — plain DDL, safe to run
    # transactionally on PostgreSQL.
    bind.execute(sa.text("""
        ALTER TABLE switch_port_metrics
          ADD COLUMN IF NOT EXISTS rx_errors_delta  INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS tx_errors_delta  INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS rx_bytes_delta   BIGINT  NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS tx_bytes_delta   BIGINT  NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS is_counter_reset BOOLEAN NOT NULL DEFAULT FALSE
    """))

    # CONCURRENTLY requires running outside an explicit transaction block.
    # Commit the ALTER TABLE transaction first so the CREATE INDEX can proceed.
    bind.execute(sa.text("COMMIT"))
    bind.execute(sa.text(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spm_errors_delta "
        "ON switch_port_metrics (switch_id, port_id, time DESC) "
        "WHERE rx_errors_delta > 0 OR tx_errors_delta > 0"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # Drop the partial index first (CONCURRENTLY, outside transaction).
    bind.execute(sa.text("COMMIT"))
    bind.execute(sa.text(
        "DROP INDEX CONCURRENTLY IF EXISTS idx_spm_errors_delta"
    ))

    # Drop the columns inside a new implicit transaction.
    bind.execute(sa.text("""
        ALTER TABLE switch_port_metrics
          DROP COLUMN IF EXISTS rx_errors_delta,
          DROP COLUMN IF EXISTS tx_errors_delta,
          DROP COLUMN IF EXISTS rx_bytes_delta,
          DROP COLUMN IF EXISTS tx_bytes_delta,
          DROP COLUMN IF EXISTS is_counter_reset
    """))
