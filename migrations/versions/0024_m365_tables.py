"""Add m365_service_health and m365_incidents tables

Revision ID: 0024
Revises: 0023
Create Date: 2026-04-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.create_table(
        "m365_service_health",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("service_id", sa.Text(), nullable=False),
        sa.Column("service_name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "recorded_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=True,
        ),
    )

    op.create_index(
        "ix_m365_health_service_recorded",
        "m365_service_health",
        ["service_id", sa.text("recorded_at DESC")],
    )

    op.create_table(
        "m365_incidents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("incident_id", sa.Text(), nullable=False, unique=True),
        sa.Column("service_name", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=True),
        sa.Column("classification", sa.Text(), nullable=True),
        sa.Column("severity", sa.Text(), nullable=True),
        sa.Column("start_time", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("end_time", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("is_resolved", sa.Boolean(), server_default=sa.text("FALSE"), nullable=True),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_table("m365_incidents")
    op.drop_index("ix_m365_health_service_recorded", table_name="m365_service_health")
    op.drop_table("m365_service_health")
