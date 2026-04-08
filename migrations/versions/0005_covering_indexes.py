"""Covering indexes for per-device lookup and alerts severity GROUP BY

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-08

device_registry
  - (ip, is_online, last_seen)  covering index so the fresh-online-device
    query (WHERE is_online = true AND last_seen > ...) is an index-only scan.
    Also ensures comparisons against the inet column use the index without
    a cast (ip = :value::inet rather than ip::text = :value).

alerts
  - (status, severity)  composite index for the stats summary query:
    SELECT severity, count(*) FROM alerts WHERE status = ? GROUP BY severity
    The composite covers both the filter and the grouping column, avoiding
    a sort or hash step on top of the index scan.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    statements = [
        # Covering index for device online-check query (avoids per-row cast)
        "CREATE INDEX IF NOT EXISTS ix_device_registry_ip_online_lastseen "
        "ON device_registry (ip, is_online, last_seen)",
        # Composite index for alerts severity GROUP BY filtered on status
        "CREATE INDEX IF NOT EXISTS ix_alerts_status_severity "
        "ON alerts (status, severity)",
    ]
    for stmt in statements:
        bind.execute(sa.text(stmt))


def downgrade() -> None:
    bind = op.get_bind()
    for idx in (
        "ix_alerts_status_severity",
        "ix_device_registry_ip_online_lastseen",
    ):
        bind.execute(sa.text(f"DROP INDEX IF EXISTS {idx}"))
