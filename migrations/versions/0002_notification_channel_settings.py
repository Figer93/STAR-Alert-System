"""Add notification_channel_settings table

Revision ID: 0002
Revises: 0001
Create Date: 2026-03-31
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notification_channel_settings",
        sa.Column("channel",             sa.String(20),              primary_key=True),
        sa.Column("enabled",             sa.Boolean(),               nullable=False, server_default="true"),
        sa.Column("send_resolutions",    sa.Boolean(),               nullable=False, server_default="false"),
        sa.Column("severity_filter",     sa.String(60),              nullable=False, server_default=""),
        sa.Column("message_template",    sa.Text(),                  nullable=False, server_default=""),
        sa.Column("resolution_template", sa.Text(),                  nullable=False, server_default=""),
        sa.Column("field_toggles",       sa.JSON(),                  nullable=False, server_default="{}"),
        sa.Column("parse_mode",          sa.String(10),              nullable=False, server_default="plain"),
        sa.Column("subject_template",    sa.String(500),             nullable=False, server_default=""),
        sa.Column("updated_at",          sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("notification_channel_settings")
