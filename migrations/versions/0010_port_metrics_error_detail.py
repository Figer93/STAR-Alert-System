"""Add error detail columns to switch_port_metrics

Revision ID: 0010
Revises: 0009
Create Date: 2026-04-08

Adds rx_dropped, tx_dropped, rx_frags columns to switch_port_metrics so the
collector can store per-error-type counts separately. These feed the enhanced
cable/NIC diagnosis in the investigation endpoint.

Columns are nullable with server_default 0 so existing rows and collectors
that do not yet populate them degrade gracefully.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_postgres() -> bool:
    bind = op.get_bind()
    return bind.dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return  # network tables only exist on PostgreSQL

    op.add_column(
        "switch_port_metrics",
        sa.Column("rx_dropped", sa.BigInteger(), nullable=True, server_default="0"),
    )
    op.add_column(
        "switch_port_metrics",
        sa.Column("tx_dropped", sa.BigInteger(), nullable=True, server_default="0"),
    )
    op.add_column(
        "switch_port_metrics",
        sa.Column("rx_frags", sa.BigInteger(), nullable=True, server_default="0"),
    )


def downgrade() -> None:
    if not _is_postgres():
        return

    op.drop_column("switch_port_metrics", "rx_frags")
    op.drop_column("switch_port_metrics", "tx_dropped")
    op.drop_column("switch_port_metrics", "rx_dropped")
