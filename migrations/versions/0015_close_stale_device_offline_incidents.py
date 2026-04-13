"""Close stale DEVICE_OFFLINE incidents from collector outage

Resolves all open DEVICE_OFFLINE incidents created before 2026-04-13 00:00:00 UTC
that are older than 24 hours and have never been resolved.

Revision ID: 0015
Revises: 0014
Create Date: 2026-04-13
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    bind.execute(sa.text("""
        UPDATE network_incidents
           SET resolved_at       = NOW(),
               resolution_notes  = 'Auto-closed: stale incident from collector outage'
         WHERE resolved_at IS NULL
           AND root_cause = 'DEVICE_OFFLINE'
           AND created_at < '2026-04-13 00:00:00+00'
           AND created_at < NOW() - INTERVAL '24 hours'
    """))


def downgrade() -> None:
    # Intentionally a no-op — we cannot safely reopen incidents that were
    # closed by this migration without knowing their prior state.
    pass
