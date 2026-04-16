"""Add missing device_type_enum values: desktop, network_infrastructure, gateway, mobile

Revision ID: 0019
Revises: 0018
Create Date: 2026-04-15
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_VALUES = ("desktop", "network_infrastructure", "gateway", "mobile")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # ALTER TYPE ADD VALUE cannot run inside an open transaction.
    # Commit the current transaction first, then add each value.
    bind.execute(sa.text("COMMIT"))
    for value in _NEW_VALUES:
        bind.execute(
            sa.text(f"ALTER TYPE device_type_enum ADD VALUE IF NOT EXISTS '{value}'")
        )


def downgrade() -> None:
    # PostgreSQL does not support removing enum values without recreating the type.
    # A safe downgrade would require rebuilding the enum and casting all affected
    # rows — out of scope here.  Leave this as a no-op; reverting should be done
    # manually if ever needed.
    pass
