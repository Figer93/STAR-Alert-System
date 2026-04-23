"""Add traceroute_results table

Revision ID: 0029
Revises: 0028
Create Date: 2026-04-23

Stores on-demand traceroute captures triggered by the fping_collector when any
LAN target exceeds 10% packet loss. Each row holds the full hop list as JSONB.
Retention: 7 days (handled by _retention_cleanup in main.py).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: Union[str, None] = "0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS traceroute_results (
            id                     SERIAL PRIMARY KEY,
            target_ip              TEXT NOT NULL,
            target_name            TEXT,
            triggered_by_loss_pct  FLOAT,
            hops                   JSONB NOT NULL,
            collected_at           TIMESTAMPTZ NOT NULL,
            created_at             TIMESTAMPTZ DEFAULT NOW()
        )
    """))

    bind.execute(sa.text("""
        CREATE INDEX IF NOT EXISTS ix_traceroute_target_time
            ON traceroute_results (target_ip, collected_at DESC)
    """))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("DROP INDEX IF EXISTS ix_traceroute_target_time"))
    bind.execute(sa.text("DROP TABLE IF EXISTS traceroute_results"))
