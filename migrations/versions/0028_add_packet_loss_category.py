"""Add packet_loss to incident_category_enum

Revision ID: 0028
Revises: 0027
Create Date: 2026-04-23

Adds the 'packet_loss' label to the incident_category_enum PostgreSQL enum type
so that _check_packet_loss in network_monitor.py can create incidents when any
latency target exceeds 10% average packet loss over a 5-minute window.

ALTER TYPE ... ADD VALUE cannot run inside a transaction block in PostgreSQL,
so we COMMIT the Alembic transaction first — matching the pattern used in
migrations 0012 and 0027. The IF NOT EXISTS guard makes it safe to re-run.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: Union[str, None] = "0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # Must exit the transaction — ALTER TYPE ADD VALUE is non-transactional.
    bind.execute(sa.text("COMMIT"))
    bind.execute(sa.text("ALTER TYPE incident_category_enum ADD VALUE IF NOT EXISTS 'packet_loss'"))


def downgrade() -> None:
    # PostgreSQL does not support removing enum labels; downgrade is a no-op.
    pass
