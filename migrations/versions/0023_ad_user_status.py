"""Add ad_user_status table for Azure AD user sync

Revision ID: 0023
Revises: 0019
Create Date: 2026-04-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.create_table(
        "ad_user_status",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("azure_id", sa.Text(), nullable=False, unique=True),
        sa.Column("display_name", sa.Text(), nullable=True),
        sa.Column("upn", sa.Text(), nullable=True),
        sa.Column("account_enabled", sa.Boolean(), nullable=True),
        sa.Column("mfa_registered", sa.Boolean(), nullable=True),
        sa.Column("last_sign_in", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("created_at_azure", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("FALSE"), nullable=True),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=True,
        ),
    )

    op.create_index("ix_ad_user_status_upn", "ad_user_status", ["upn"])


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_index("ix_ad_user_status_upn", table_name="ad_user_status")
    op.drop_table("ad_user_status")
