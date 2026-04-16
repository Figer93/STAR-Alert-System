"""Network Monitor schema — flows, port metrics, latency, devices, incidents, heartbeat

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-03

TimescaleDB not available, using standard PostgreSQL.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# TimescaleDB and PostgreSQL-specific features are skipped on SQLite
def _is_postgres() -> bool:
    bind = op.get_bind()
    return bind.dialect.name == "postgresql"


def upgrade() -> None:

    # ------------------------------------------------------------------
    # Clean up any partial state from previous failed migration runs.
    # Drop tables first (they depend on the enum types), then the enums.
    # All objects are recreated below, so this is a safe idempotent reset.
    # ------------------------------------------------------------------
    if _is_postgres():
        bind = op.get_bind()
        for _tbl in (
            "collector_heartbeat",
            "network_incidents",
            "latency_metrics",
            "switch_port_metrics",
            "network_flows",
            "device_registry",
        ):
            bind.execute(sa.text(f"DROP TABLE IF EXISTS {_tbl} CASCADE"))
        for _enum in (
            "device_type_enum",
            "flow_direction_enum",
            "latency_target_type_enum",
            "incident_severity_enum",
            "incident_category_enum",
        ):
            bind.execute(sa.text(f"DROP TYPE IF EXISTS {_enum}"))

    # ------------------------------------------------------------------
    # device_registry  (referenced by other tables, created first)
    # ------------------------------------------------------------------
    op.create_table(
        "device_registry",
        sa.Column("ip",          postgresql.INET() if _is_postgres() else sa.String(45), primary_key=True),
        sa.Column("mac",         sa.String(17),                 nullable=True),
        sa.Column("hostname",    sa.Text(),                     nullable=True),
        sa.Column("switch_id",   sa.Text(),                     nullable=True),
        sa.Column("port_id",     sa.Text(),                     nullable=True),
        sa.Column("last_seen",   sa.DateTime(timezone=True),    nullable=True),
        sa.Column("first_seen",  sa.DateTime(timezone=True),    nullable=True),
        sa.Column("is_online",   sa.Boolean(),                  nullable=False, server_default="false"),
        sa.Column(
            "device_type",
            sa.Enum("workstation", "server", "printer", "ap", "unknown", "desktop", "network_infrastructure", name="device_type_enum"),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("ix_device_registry_mac",      "device_registry", ["mac"])
    op.create_index("ix_device_registry_hostname",  "device_registry", ["hostname"])

    # ------------------------------------------------------------------
    # network_flows  (hypertable on `time`)
    # ------------------------------------------------------------------
    op.create_table(
        "network_flows",
        sa.Column("time",        sa.DateTime(timezone=True),    nullable=False),
        sa.Column("src_ip",      postgresql.INET() if _is_postgres() else sa.String(45), nullable=True),
        sa.Column("dst_ip",      postgresql.INET() if _is_postgres() else sa.String(45), nullable=True),
        sa.Column("src_port",    sa.Integer(),                  nullable=True),
        sa.Column("dst_port",    sa.Integer(),                  nullable=True),
        sa.Column("protocol",    sa.SmallInteger(),             nullable=True),
        sa.Column("bytes",       sa.BigInteger(),               nullable=True),
        sa.Column("packets",     sa.Integer(),                  nullable=True),
        sa.Column("device_name", sa.Text(),                     nullable=True),
        sa.Column(
            "direction",
            sa.Enum("inbound", "outbound", "internal", name="flow_direction_enum"),
            nullable=True,
        ),
    )
    op.create_index("ix_network_flows_src_ip",  "network_flows", ["src_ip"])
    op.create_index("ix_network_flows_dst_ip",  "network_flows", ["dst_ip"])
    op.create_index("ix_network_flows_time",    "network_flows", [sa.text("time DESC")])

    # ------------------------------------------------------------------
    # switch_port_metrics  (hypertable on `time`)
    # ------------------------------------------------------------------
    op.create_table(
        "switch_port_metrics",
        sa.Column("time",        sa.DateTime(timezone=True),    nullable=False),
        sa.Column("switch_id",   sa.Text(),                     nullable=False),
        sa.Column("switch_name", sa.Text(),                     nullable=True),
        sa.Column("port_id",     sa.Text(),                     nullable=False),
        sa.Column("port_name",   sa.Text(),                     nullable=True),
        sa.Column("device_name", sa.Text(),                     nullable=True),
        sa.Column("device_ip",   postgresql.INET() if _is_postgres() else sa.String(45), nullable=True),
        sa.Column("rx_bytes",    sa.BigInteger(),               nullable=True),
        sa.Column("tx_bytes",    sa.BigInteger(),               nullable=True),
        sa.Column("rx_errors",   sa.BigInteger(),               nullable=True),
        sa.Column("tx_errors",   sa.BigInteger(),               nullable=True),
        sa.Column("rx_packets",  sa.BigInteger(),               nullable=True),
        sa.Column("tx_packets",  sa.BigInteger(),               nullable=True),
        sa.Column("poe_watts",   sa.Float(),                    nullable=True),
        sa.Column("is_uplink",   sa.Boolean(),                  nullable=False, server_default="false"),
    )
    op.create_index(
        "ix_switch_port_metrics_switch_port_time",
        "switch_port_metrics",
        ["switch_id", "port_id", sa.text("time DESC")],
    )

    # ------------------------------------------------------------------
    # latency_metrics  (hypertable on `time`)
    # ------------------------------------------------------------------
    op.create_table(
        "latency_metrics",
        sa.Column("time",             sa.DateTime(timezone=True), nullable=False),
        sa.Column("target_name",      sa.Text(),                  nullable=False),
        sa.Column("target_ip",        postgresql.INET() if _is_postgres() else sa.String(45), nullable=True),
        sa.Column(
            "target_type",
            sa.Enum("gateway", "wan", "dns", "internal", name="latency_target_type_enum"),
            nullable=True,
        ),
        sa.Column("rtt_ms",           sa.Float(),                 nullable=True),
        sa.Column("packet_loss_pct",  sa.Float(),                 nullable=True),
    )
    op.create_index(
        "ix_latency_metrics_target_time",
        "latency_metrics",
        ["target_name", sa.text("time DESC")],
    )

    # ------------------------------------------------------------------
    # network_incidents
    # ------------------------------------------------------------------
    op.create_table(
        "network_incidents",
        sa.Column("id",               postgresql.UUID(as_uuid=True) if _is_postgres() else sa.String(36),
                  primary_key=True,
                  server_default=sa.text("gen_random_uuid()") if _is_postgres() else sa.text("(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))")),
        sa.Column("started_at",       sa.DateTime(timezone=True),  nullable=False, server_default=sa.text("now()")),
        sa.Column("resolved_at",      sa.DateTime(timezone=True),  nullable=True),
        sa.Column(
            "severity",
            sa.Enum("low", "medium", "high", "critical", name="incident_severity_enum"),
            nullable=False,
        ),
        sa.Column(
            "category",
            sa.Enum(
                "wan_issue", "interface_error", "device_offline",
                "internal_latency", "traffic_anomaly", "firewall_drop",
                name="incident_category_enum",
            ),
            nullable=False,
        ),
        sa.Column("affected_ip",       postgresql.INET() if _is_postgres() else sa.String(45), nullable=True),
        sa.Column("affected_switch",   sa.Text(),                  nullable=True),
        sa.Column("affected_port",     sa.Text(),                  nullable=True),
        sa.Column("title",             sa.Text(),                  nullable=False),
        sa.Column("description",       sa.Text(),                  nullable=True),
        sa.Column("evidence",          postgresql.JSONB() if _is_postgres() else sa.JSON(), nullable=True),
        sa.Column("root_cause",        sa.Text(),                  nullable=True),
        sa.Column("resolution_notes",  sa.Text(),                  nullable=True),
        sa.Column("auto_detected",     sa.Boolean(),               nullable=False, server_default="true"),
    )

    # ------------------------------------------------------------------
    # collector_heartbeat
    # ------------------------------------------------------------------
    op.create_table(
        "collector_heartbeat",
        sa.Column("collector_id", sa.Text(), primary_key=True),
        sa.Column("last_seen",    sa.DateTime(timezone=True), nullable=True),
        sa.Column("version",      sa.Text(),                  nullable=True),
        sa.Column("sources",      postgresql.JSONB() if _is_postgres() else sa.JSON(), nullable=True),
    )



def downgrade() -> None:
    op.drop_table("collector_heartbeat")
    op.drop_table("network_incidents")
    op.drop_table("latency_metrics")
    op.drop_table("switch_port_metrics")
    op.drop_table("network_flows")
    op.drop_table("device_registry")

    if _is_postgres():
        bind = op.get_bind()
        for enum_name in (
            "latency_target_type_enum",
            "flow_direction_enum",
            "device_type_enum",
            "incident_severity_enum",
            "incident_category_enum",
        ):
            bind.execute(sa.text(f"DROP TYPE IF EXISTS {enum_name};"))
