"""Add NinjaRMM columns to device_registry

Revision ID: 0018
Revises: 0017
Create Date: 2026-04-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.add_column("device_registry", sa.Column("ninja_id", sa.Integer(), nullable=True))
    op.add_column("device_registry", sa.Column("os_name", sa.Text(), nullable=True))
    op.add_column("device_registry", sa.Column("last_logged_in_user", sa.Text(), nullable=True))
    op.add_column("device_registry", sa.Column("serial", sa.Text(), nullable=True))
    op.add_column("device_registry", sa.Column("ninja_online", sa.Boolean(), nullable=True))
    op.add_column("device_registry", sa.Column("disk_free_pct", sa.Float(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_column("device_registry", "ninja_id")
    op.drop_column("device_registry", "os_name")
    op.drop_column("device_registry", "last_logged_in_user")
    op.drop_column("device_registry", "serial")
    op.drop_column("device_registry", "ninja_online")
    op.drop_column("device_registry", "disk_free_pct")
