"""Index for sources(adapter, enabled)

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-08

sources
  - (adapter, enabled)  composite index — used by the UniFi poller reconciliation
    loop every 60s: SELECT ... FROM sources WHERE adapter = 'unifi' AND enabled = true

Note: a functional index on (status::text, severity::text) for alerts was attempted
but PostgreSQL rejects it because enum casts are not IMMUTABLE. The existing btree
index ix_alerts_status_severity on the enum columns is correct and sufficient.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_sources_adapter_enabled "
        "ON sources (adapter, enabled)"
    ))


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DROP INDEX IF EXISTS ix_sources_adapter_enabled"
    ))
