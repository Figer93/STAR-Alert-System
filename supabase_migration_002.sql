-- TimescaleDB not available, using standard PostgreSQL
-- Network Monitor schema — flows, port metrics, latency, devices, incidents, heartbeat
-- Extracted from migrations/versions/0002_network_monitor_schema.py
-- Targets PostgreSQL / Supabase (standard PostgreSQL, no TimescaleDB)

-- ----------------------------------------------------------------------------
-- Enum types
-- ----------------------------------------------------------------------------

CREATE TYPE device_type_enum AS ENUM (
    'workstation',
    'server',
    'printer',
    'ap',
    'unknown'
);

CREATE TYPE flow_direction_enum AS ENUM (
    'inbound',
    'outbound',
    'internal'
);

CREATE TYPE latency_target_type_enum AS ENUM (
    'gateway',
    'wan',
    'dns',
    'internal'
);

CREATE TYPE incident_severity_enum AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);

CREATE TYPE incident_category_enum AS ENUM (
    'wan_issue',
    'interface_error',
    'device_offline',
    'internal_latency',
    'traffic_anomaly',
    'firewall_drop'
);

-- ----------------------------------------------------------------------------
-- device_registry  (created first — referenced by other tables)
-- ----------------------------------------------------------------------------

CREATE TABLE device_registry (
    ip          INET                PRIMARY KEY,
    mac         VARCHAR(17),
    hostname    TEXT,
    switch_id   TEXT,
    port_id     TEXT,
    last_seen   TIMESTAMPTZ,
    first_seen  TIMESTAMPTZ,
    is_online   BOOLEAN             NOT NULL DEFAULT false,
    device_type device_type_enum    NOT NULL DEFAULT 'unknown',
    notes       TEXT
);

CREATE INDEX ix_device_registry_mac      ON device_registry (mac);
CREATE INDEX ix_device_registry_hostname ON device_registry (hostname);

-- ----------------------------------------------------------------------------
-- network_flows
-- ----------------------------------------------------------------------------

CREATE TABLE network_flows (
    time        TIMESTAMPTZ         NOT NULL,
    src_ip      INET,
    dst_ip      INET,
    src_port    INTEGER,
    dst_port    INTEGER,
    protocol    SMALLINT,
    bytes       BIGINT,
    packets     INTEGER,
    device_name TEXT,
    direction   flow_direction_enum
);

CREATE INDEX ix_network_flows_src_ip ON network_flows (src_ip);
CREATE INDEX ix_network_flows_dst_ip ON network_flows (dst_ip);
CREATE INDEX ix_network_flows_time   ON network_flows (time DESC);

-- ----------------------------------------------------------------------------
-- switch_port_metrics
-- ----------------------------------------------------------------------------

CREATE TABLE switch_port_metrics (
    time        TIMESTAMPTZ NOT NULL,
    switch_id   TEXT        NOT NULL,
    switch_name TEXT,
    port_id     TEXT        NOT NULL,
    port_name   TEXT,
    device_name TEXT,
    device_ip   INET,
    rx_bytes    BIGINT,
    tx_bytes    BIGINT,
    rx_errors   BIGINT,
    tx_errors   BIGINT,
    rx_packets  BIGINT,
    tx_packets  BIGINT,
    poe_watts   DOUBLE PRECISION,
    is_uplink   BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX ix_switch_port_metrics_switch_port_time
    ON switch_port_metrics (switch_id, port_id, time DESC);

-- ----------------------------------------------------------------------------
-- latency_metrics
-- ----------------------------------------------------------------------------

CREATE TABLE latency_metrics (
    time            TIMESTAMPTZ             NOT NULL,
    target_name     TEXT                    NOT NULL,
    target_ip       INET,
    target_type     latency_target_type_enum,
    rtt_ms          DOUBLE PRECISION,
    packet_loss_pct DOUBLE PRECISION
);

CREATE INDEX ix_latency_metrics_target_time
    ON latency_metrics (target_name, time DESC);

-- ----------------------------------------------------------------------------
-- network_incidents
-- ----------------------------------------------------------------------------

CREATE TABLE network_incidents (
    id               UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at       TIMESTAMPTZ             NOT NULL DEFAULT now(),
    resolved_at      TIMESTAMPTZ,
    severity         incident_severity_enum  NOT NULL,
    category         incident_category_enum  NOT NULL,
    affected_ip      INET,
    affected_switch  TEXT,
    affected_port    TEXT,
    title            TEXT                    NOT NULL,
    description      TEXT,
    evidence         JSONB,
    root_cause       TEXT,
    resolution_notes TEXT,
    auto_detected    BOOLEAN                 NOT NULL DEFAULT true
);

-- ----------------------------------------------------------------------------
-- collector_heartbeat
-- ----------------------------------------------------------------------------

CREATE TABLE collector_heartbeat (
    collector_id TEXT        PRIMARY KEY,
    last_seen    TIMESTAMPTZ,
    version      TEXT,
    sources      JSONB
);

-- ----------------------------------------------------------------------------
-- network_settings  (alert thresholds, business hours)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS network_settings (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO network_settings (key, value) VALUES
    ('wan_packet_loss_threshold_pct', '5'),
    ('internal_latency_threshold_ms', '50'),
    ('port_error_threshold',          '50'),
    ('traffic_anomaly_multiplier',    '5'),
    ('business_hours_start',          '08:00'),
    ('business_hours_end',            '18:00')
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- fping_targets  (collector reads these; UI manages them)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fping_targets (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT        NOT NULL,
    ip         TEXT        NOT NULL UNIQUE,
    type       TEXT        NOT NULL DEFAULT 'host',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
