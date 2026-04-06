"""
Network Monitor router — /api/network/*

Queries the six tables written by the off-premise collector:
  network_flows, switch_port_metrics, latency_metrics,
  device_registry, network_incidents, collector_heartbeat

All tables are TimescaleDB hypertables created by migration 0002.  They do
not have SQLAlchemy ORM models, so every query here is raw SQL via text().

Behaviour on SQLite (local dev) or before the collector has ever run:
  - Every endpoint returns an empty/default response rather than an error.
  - DB errors caused by missing tables are caught, rolled back, and logged
    at DEBUG level so they don't pollute production logs.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import get_db
from backend.services.unifi_cloud import UniFiCloudService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/network", tags=["network"])

_IS_POSTGRES = "postgresql" in settings.DATABASE_URL

# ── Constants ─────────────────────────────────────────────────────────────────

# period value → (lookback interval, time_bucket bucket size)
_PERIOD_CONFIG: dict[str, tuple[str, str]] = {
    "15m": ("15 minutes", "30 seconds"),
    "1h":  ("1 hour",     "1 minute"),
    "6h":  ("6 hours",    "5 minutes"),
    "24h": ("24 hours",   "15 minutes"),
    "7d":  ("7 days",     "1 hour"),
}

# Fallback for standard PostgreSQL without TimescaleDB — maps period → date_trunc unit
_PERIOD_DATE_TRUNC: dict[str, str] = {
    "15m": "minute",
    "1h":  "minute",
    "6h":  "minute",
    "24h": "hour",
    "7d":  "hour",
}

# dst_port → human-readable protocol name
_PORT_NAMES: dict[int, str] = {
    21:    "FTP",
    22:    "SSH",
    25:    "SMTP",
    53:    "DNS",
    80:    "HTTP",
    110:   "POP3",
    143:   "IMAP",
    389:   "LDAP",
    443:   "HTTPS",
    445:   "SMB",
    587:   "SMTP-TLS",
    636:   "LDAPS",
    993:   "IMAP-TLS",
    995:   "POP3-TLS",
    1433:  "MSSQL",
    3306:  "MySQL",
    3389:  "RDP",
    3478:  "STUN",
    3479:  "STUN",
    5432:  "PostgreSQL",
    5060:  "SIP",
    8080:  "HTTP-Alt",
    8443:  "HTTPS-Alt",
    8801:  "Zoom",
    8802:  "Zoom",
    19302: "Google-Meet",
}
_IP_PROTO_NAMES: dict[int, str] = {1: "ICMP", 6: "TCP", 17: "UDP", 47: "GRE", 50: "ESP"}

# Ports that indicate collaboration traffic (Teams, Zoom, Meet)
_COLLAB_PORTS = {3478, 3479, 8801, 8802, 19302, 19305}


# ── Pydantic response models ──────────────────────────────────────────────────

class WanStatus(BaseModel):
    status: Literal["healthy", "degraded", "down"]
    latency_ms: Optional[float]
    packet_loss_pct: Optional[float]


class InternalStatus(BaseModel):
    status: Literal["healthy", "degraded", "down"]
    active_devices: int
    error_ports: int


class CollectorStatus(BaseModel):
    online: bool
    last_seen: Optional[datetime]
    sources: dict[str, Any]


class UniFiCloudSiteStats(BaseModel):
    total_devices:          int
    online_devices:         int
    offline_devices:        int
    wired_clients:          int
    wifi_clients:           int
    critical_notifications: int


class UniFiCloudStatus(BaseModel):
    connected:          bool
    controller_version: Optional[str]  = None
    controller_state:   str            = "disconnected"
    last_seen:          Optional[str]  = None
    site_stats:         Optional[UniFiCloudSiteStats] = None
    error:              Optional[str]  = None


class NetworkOverview(BaseModel):
    wan:             WanStatus
    internal:        InternalStatus
    collector:       CollectorStatus
    open_incidents:  int
    bytes_last_hour: int
    health_score:    int
    unifi_cloud:     Optional[UniFiCloudStatus] = None


class LatencyPoint(BaseModel):
    time: str


class LatencyResponse(BaseModel):
    targets: list[str]
    target_types: dict[str, str] = {}   # target_name → target_type ('gateway'|'wan'|'dns'|'internal')
    series: list[dict[str, Any]]


class PortStatus(BaseModel):
    switch_id: str
    switch_name: Optional[str]
    port_id: str
    port_name: Optional[str]
    device_name: Optional[str]
    device_ip: Optional[str]
    rx_bytes_rate: float
    tx_bytes_rate: float
    rx_errors_1h: int
    tx_errors_1h: int
    status: Literal["healthy", "warning", "error", "empty", "uplink"]
    last_error_time: Optional[datetime]
    errors_24h: list[dict[str, Any]] = []
    throughput_1h: list[dict[str, Any]] = []


class FlowRow(BaseModel):
    src_ip: Optional[str]
    src_hostname: Optional[str]
    dst_ip: Optional[str]
    dst_hostname: Optional[str]
    protocol_name: str
    bytes: int
    packets: int
    direction: Optional[str]
    percent_of_total: float


class TopDeviceRow(BaseModel):
    ip: str
    hostname: Optional[str]
    mac: Optional[str] = None
    rx_bytes: int
    tx_bytes: int
    total_bytes: int


class DeviceDetail(BaseModel):
    ip: str
    mac: Optional[str]
    hostname: Optional[str]
    switch_id: Optional[str]
    port_id: Optional[str]
    device_type: Optional[str]
    notes: Optional[str]
    is_online: bool
    last_seen: Optional[datetime]
    current_port_status: Optional[dict[str, Any]]
    flows_last_hour: list[dict[str, Any]]
    port_errors_24h: list[dict[str, Any]]
    latency_to_gateway_24h: list[dict[str, Any]]
    incidents: list[dict[str, Any]]


class TimelineEvent(BaseModel):
    time: datetime
    event_type: str
    severity: str
    description: str


class InvestigateMetrics(BaseModel):
    port_rx_errors: int
    port_tx_errors: int
    avg_packet_loss_gateway_pct: float
    avg_packet_loss_wan_pct: float
    avg_rtt_gateway_ms: Optional[float]
    bytes_sent: int
    bytes_received: int
    top_destinations: list[dict[str, Any]]


class Hypothesis(BaseModel):
    likely_cause: Literal[
        "cable_or_nic", "wan_issue", "firewall_drop", "server_side",
        "wifi_signal", "healthy", "unknown",
    ]
    confidence: Literal["high", "medium", "low"]
    evidence: list[str]
    recommended_action: str


class InvestigateResponse(BaseModel):
    device: Optional[dict[str, Any]]
    timeline: list[TimelineEvent]
    metrics: InvestigateMetrics
    hypothesis: Hypothesis


class IncidentRow(BaseModel):
    id: str
    started_at: datetime
    resolved_at: Optional[datetime]
    severity: str
    category: str
    affected_ip: Optional[str]
    affected_switch: Optional[str]
    affected_port: Optional[str]
    title: str
    description: Optional[str]
    evidence: Optional[dict]
    root_cause: Optional[str]
    resolution_notes: Optional[str]
    auto_detected: bool


class DeviceRow(BaseModel):
    ip: str
    mac: Optional[str]
    hostname: Optional[str]
    switch_id: Optional[str]
    switch_name: Optional[str]
    port_id: Optional[str]
    last_seen: Optional[datetime]
    first_seen: Optional[datetime]
    is_online: bool
    device_type: Optional[str]
    notes: Optional[str]


class DeviceUpdate(BaseModel):
    notes: Optional[str] = None
    device_type: Optional[Literal["workstation", "server", "printer", "ap", "unknown"]] = None


class NetworkSettingItem(BaseModel):
    key:        str
    value:      str
    updated_at: Optional[datetime] = None


class NetworkSettingsUpdate(BaseModel):
    settings: dict[str, str]


class FpingTarget(BaseModel):
    id:         str
    name:       str
    ip:         str
    type:       str
    created_at: Optional[datetime] = None


class FpingTargetCreate(BaseModel):
    name: str
    ip:   str
    type: str = "host"


class IncidentResolve(BaseModel):
    root_cause: Optional[str] = None
    resolution_notes: Optional[str] = None


# ── DB helpers ────────────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    d = dict(row._mapping)
    # Coerce any non-JSON-serialisable types
    for k, v in d.items():
        if isinstance(v, datetime):
            d[k] = v
        elif hasattr(v, "__str__") and not isinstance(v, (int, float, bool, str, type(None))):
            d[k] = str(v)
    return d


async def _exec(
    db: AsyncSession,
    sql: str,
    params: dict | None = None,
) -> list[dict]:
    """Execute raw SQL and return list of dicts. Returns [] on any error."""
    try:
        result = await db.execute(text(sql), params or {})
        return [_row_to_dict(row) for row in result]
    except Exception as exc:
        logger.debug("Network query failed (expected on SQLite): %s", exc)
        await db.rollback()
        return []


async def _scalar(
    db: AsyncSession,
    sql: str,
    params: dict | None = None,
    default: Any = 0,
) -> Any:
    """Execute raw SQL and return scalar. Returns default on any error."""
    try:
        result = await db.execute(text(sql), params or {})
        val = result.scalar()
        return val if val is not None else default
    except Exception as exc:
        logger.debug("Network scalar failed: %s", exc)
        await db.rollback()
        return default


# ── Business logic helpers ────────────────────────────────────────────────────

def _sanitise_key(name: str) -> str:
    """'8.8.8.8' → '8_8_8_8' — safe dict key for latency series."""
    return re.sub(r"[^a-zA-Z0-9]", "_", name)


def _protocol_name(dst_port: int | None, protocol: int | None) -> str:
    if protocol == 1:
        return "ICMP"
    if dst_port and dst_port in _PORT_NAMES:
        return _PORT_NAMES[dst_port]
    proto_str = _IP_PROTO_NAMES.get(protocol or 0, f"proto{protocol}")
    return f"{proto_str}/{dst_port}" if dst_port else proto_str


def _wan_status(loss: float | None, rtt: float | None) -> str:
    loss = loss or 0.0
    rtt  = rtt  or 0.0
    if loss >= 50:
        return "down"
    if loss >= 5 or rtt >= 200:
        return "degraded"
    return "healthy"


def _internal_status(error_ports: int, active_devices: int) -> str:
    if active_devices == 0:
        return "down"
    if error_ports >= 5:
        return "down"
    if error_ports > 0:
        return "degraded"
    return "healthy"


def _port_status(row: dict) -> str:
    if row.get("is_uplink"):
        return "uplink"
    if not row.get("device_name"):
        return "empty"
    rx_err = int(row.get("rx_errors_1h") or 0)
    tx_err = int(row.get("tx_errors_1h") or 0)
    if rx_err > 100 or tx_err > 100:
        return "error"
    if rx_err > 10 or tx_err > 10:
        return "warning"
    return "healthy"


def _health_score(
    wan_loss: float,
    wan_rtt: float,
    gateway_loss: float,
    error_ports: int,
    critical_incidents: int,
    other_incidents: int,
    collector_online: bool,
    has_data: bool,
) -> int:
    if not has_data:
        return 0
    score = 100
    if   wan_loss >= 50: score -= 40
    elif wan_loss >= 10: score -= 30
    elif wan_loss >=  5: score -= 20
    elif wan_loss >=  2: score -= 10
    if   wan_rtt  >= 200: score -= 15
    elif wan_rtt  >= 100: score -=  5
    if   gateway_loss >= 5: score -= 20
    elif gateway_loss >= 1: score -= 10
    score -= min(error_ports, 6) * 5
    score -= min(critical_incidents, 2) * 15
    score -= min(other_incidents, 4) * 5
    if not collector_online:
        score -= 10
    return max(0, min(100, score))


def _compute_hypothesis(
    port_rx_errors: int,
    port_tx_errors: int,
    gateway_loss: float,
    wan_loss: float,
    has_wired_port: bool,
    has_collab_traffic: bool,
) -> Hypothesis:
    evidence: list[str] = []

    # Rule 1: port errors + gateway loss → cable/NIC (high confidence)
    if port_rx_errors > 50 and gateway_loss > 2.0:
        return Hypothesis(
            likely_cause="cable_or_nic",
            confidence="high",
            evidence=[
                f"Port RX errors in window: {port_rx_errors}",
                f"Gateway packet loss: {gateway_loss:.1f}%",
            ],
            recommended_action=(
                "Check physical cable connection and NIC driver. "
                "Replace cable if errors persist after re-seat."
            ),
        )

    # Rule 2: port errors but gateway healthy → local cable/NIC (medium)
    if port_rx_errors > 50 and gateway_loss < 1.0:
        return Hypothesis(
            likely_cause="cable_or_nic",
            confidence="medium",
            evidence=[
                f"Port RX errors in window: {port_rx_errors}",
                f"Gateway reachable (loss: {gateway_loss:.1f}%)",
            ],
            recommended_action=(
                "Inspect cable and NIC. Gateway is reachable so this is "
                "likely a local layer-1 fault on this specific port."
            ),
        )

    # Rule 3: gateway fine, WAN lossy → ISP/WAN (high)
    if gateway_loss < 1.0 and wan_loss > 5.0:
        return Hypothesis(
            likely_cause="wan_issue",
            confidence="high",
            evidence=[
                f"Gateway reachable (loss: {gateway_loss:.1f}%)",
                f"WAN packet loss: {wan_loss:.1f}%",
            ],
            recommended_action=(
                "WAN link degraded past pfSense. "
                "Check pfSense WAN status and contact ISP if ongoing."
            ),
        )

    # Rule 4: both gateway and WAN lossy → upstream outage (high)
    if gateway_loss > 5.0 and wan_loss > 5.0:
        return Hypothesis(
            likely_cause="wan_issue",
            confidence="high",
            evidence=[
                f"Gateway loss: {gateway_loss:.1f}%",
                f"WAN loss: {wan_loss:.1f}%",
            ],
            recommended_action=(
                "Both gateway and WAN unreliable. Likely ISP or upstream outage. "
                "Check pfSense dashboard and ISP status page."
            ),
        )

    # Rule 5: all clean + collaboration traffic → server-side issue (medium)
    if (gateway_loss < 1.0 and wan_loss < 1.0
            and port_rx_errors == 0 and has_collab_traffic):
        return Hypothesis(
            likely_cause="server_side",
            confidence="medium",
            evidence=[
                "No packet loss or port errors detected",
                "Teams/Zoom/Meet traffic detected in window",
            ],
            recommended_action=(
                "Local network is healthy. Issue is likely with the remote "
                "service. Check Microsoft/Zoom status pages."
            ),
        )

    # Rule 6: no wired port data + gateway loss → wifi signal (high)
    if not has_wired_port and gateway_loss > 1.0:
        return Hypothesis(
            likely_cause="wifi_signal",
            confidence="high",
            evidence=[
                "No wired switch port data found for this device",
                f"Gateway packet loss: {gateway_loss:.1f}%",
            ],
            recommended_action=(
                "Device appears to be wireless. Check Wi-Fi signal strength "
                "and consider moving closer to the access point."
            ),
        )

    # Rule 7: all normal → healthy (high)
    if (gateway_loss < 1.0 and wan_loss < 1.0
            and port_rx_errors == 0 and port_tx_errors == 0):
        return Hypothesis(
            likely_cause="healthy",
            confidence="high",
            evidence=["All metrics within normal thresholds"],
            recommended_action="No action required.",
        )

    # Fallthrough
    return Hypothesis(
        likely_cause="unknown",
        confidence="low",
        evidence=evidence or ["Insufficient data to determine cause"],
        recommended_action=(
            "Gather more data. Check pfSense logs and switch port counters manually."
        ),
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _unifi_cloud_service() -> UniFiCloudService | None:
    """Return a UniFiCloudService if UNIFI_CLOUD_API_KEY is configured."""
    if not settings.UNIFI_CLOUD_API_KEY:
        return None
    return UniFiCloudService(
        api_key=settings.UNIFI_CLOUD_API_KEY,
        host_id=settings.UNIFI_HOST_ID,
        site_id=settings.UNIFI_SITE_ID,
    )


async def _fetch_unifi_cloud() -> UniFiCloudStatus:
    """
    Fetch UniFi Cloud status.  Returns a UniFiCloudStatus whether the call
    succeeds or fails — callers never need to handle exceptions from this.
    """
    svc = _unifi_cloud_service()
    if svc is None:
        return UniFiCloudStatus(connected=False, error="API key not configured")
    try:
        data = await svc.get_status()
        return UniFiCloudStatus(
            connected=bool(data.get("connected")),
            controller_version=data.get("controller_version"),
            controller_state=data.get("controller_state", "disconnected"),
            last_seen=data.get("last_seen"),
            site_stats=UniFiCloudSiteStats(**data["site_stats"]) if data.get("site_stats") else None,
        )
    except PermissionError:
        logger.warning("UniFi Cloud API: authentication failed (invalid API key)")
        return UniFiCloudStatus(connected=False, error="API key is invalid or expired")
    except Exception as exc:
        logger.warning("UniFi Cloud API unavailable: %s", exc)
        return UniFiCloudStatus(connected=False, error="Unable to reach UniFi Cloud API")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/overview", response_model=NetworkOverview)
async def get_overview(db: AsyncSession = Depends(get_db)):
    """
    Single-call dashboard summary: WAN health, internal health, collector
    status, open incident count, bytes last hour, and a 0-100 health score.
    """
    # ── WAN latency (average of latest rows per wan/dns target, last 5 min) ──
    wan_rows = await _exec(db, """
        SELECT AVG(rtt_ms) AS avg_rtt, AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
          AND target_type IN ('wan', 'dns')
    """)
    wan_rtt  = float(wan_rows[0]["avg_rtt"]  or 0) if wan_rows else 0.0
    wan_loss = float(wan_rows[0]["avg_loss"] or 0) if wan_rows else 0.0

    # ── Gateway latency ───────────────────────────────────────────────────────
    gw_rows = await _exec(db, """
        SELECT AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
          AND target_type = 'gateway'
    """)
    gateway_loss = float(gw_rows[0]["avg_loss"] or 0) if gw_rows else 0.0

    # ── Active devices ────────────────────────────────────────────────────────
    active_devices = await _scalar(db,
        "SELECT COUNT(*) FROM device_registry WHERE is_online = true")

    # ── Ports with errors in last 5 min ──────────────────────────────────────
    error_ports = await _scalar(db, """
        SELECT COUNT(DISTINCT port_id)
        FROM switch_port_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
          AND (rx_errors > 0 OR tx_errors > 0)
    """)

    # ── Collector heartbeat ───────────────────────────────────────────────────
    hb_rows = await _exec(db,
        "SELECT collector_id, last_seen, sources FROM collector_heartbeat "
        "ORDER BY last_seen DESC LIMIT 1")
    if hb_rows:
        hb = hb_rows[0]
        last_seen   = hb["last_seen"]
        stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        collector_online = (
            isinstance(last_seen, datetime) and last_seen > stale_cutoff
        )
        raw_sources = hb.get("sources") or {}
        sources_dict = raw_sources if isinstance(raw_sources, dict) else {}
    else:
        last_seen        = None
        collector_online = False
        sources_dict     = {}

    # ── Open incidents ────────────────────────────────────────────────────────
    open_incidents = await _scalar(db,
        "SELECT COUNT(*) FROM network_incidents WHERE resolved_at IS NULL")

    critical_open = await _scalar(db,
        "SELECT COUNT(*) FROM network_incidents "
        "WHERE resolved_at IS NULL AND severity = 'critical'")
    other_open = int(open_incidents) - int(critical_open)

    # ── Bytes last hour ───────────────────────────────────────────────────────
    bytes_last_hour = await _scalar(db, """
        SELECT COALESCE(SUM(bytes), 0)
        FROM network_flows
        WHERE time > NOW() - INTERVAL '1 hour'
    """, default=0)

    has_data = bool(wan_rows and wan_rows[0]["avg_rtt"] is not None)

    # ── UniFi Cloud status (non-blocking — failure yields connected=False) ────
    unifi_cloud = await _fetch_unifi_cloud()

    return NetworkOverview(
        wan=WanStatus(
            status=_wan_status(wan_loss, wan_rtt),
            latency_ms=round(wan_rtt, 2) if wan_rtt else None,
            packet_loss_pct=round(wan_loss, 2) if wan_loss else None,
        ),
        internal=InternalStatus(
            status=_internal_status(int(error_ports), int(active_devices)),
            active_devices=int(active_devices),
            error_ports=int(error_ports),
        ),
        collector=CollectorStatus(
            online=collector_online,
            last_seen=last_seen,
            sources=sources_dict,
        ),
        open_incidents=int(open_incidents),
        bytes_last_hour=int(bytes_last_hour),
        health_score=_health_score(
            wan_loss=wan_loss,
            wan_rtt=wan_rtt,
            gateway_loss=gateway_loss,
            error_ports=int(error_ports),
            critical_incidents=int(critical_open),
            other_incidents=max(0, other_open),
            collector_online=collector_online,
            has_data=has_data,
        ),
        unifi_cloud=unifi_cloud,
    )


@router.get("/unifi-cloud-status", response_model=UniFiCloudStatus)
async def get_unifi_cloud_status():
    """
    Standalone endpoint — returns the current UniFi Cloud connection state.
    Useful for health checks and the CollectorStatus modal.
    """
    return await _fetch_unifi_cloud()


@router.get("/top-devices", response_model=list[TopDeviceRow])
async def get_top_devices(
    period: Literal["15m", "1h", "6h", "24h", "7d"] = Query("15m"),
    limit: int = Query(10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """
    Top devices by switch port traffic volume in the given period.
    Uses MAX-MIN delta per port to approximate bytes transferred from
    cumulative counters — no dependency on NetFlow/pfSense.
    """
    if not _IS_POSTGRES:
        return []

    lookback = _PERIOD_CONFIG[period][0]
    rows = await _exec(db, f"""
        WITH port_deltas AS (
            SELECT
                device_ip,
                switch_id,
                port_id,
                GREATEST(MAX(rx_bytes) - MIN(rx_bytes), 0) AS delta_rx,
                GREATEST(MAX(tx_bytes) - MIN(tx_bytes), 0) AS delta_tx
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '{lookback}'
              AND device_ip IS NOT NULL
            GROUP BY device_ip, switch_id, port_id
        ),
        infra_ips AS (
            SELECT DISTINCT target_ip
            FROM latency_metrics
            WHERE target_type IN ('gateway', 'wan')
        )
        SELECT
            pd.device_ip::text  AS ip,
            dr.hostname,
            dr.mac,
            SUM(pd.delta_rx)    AS rx_bytes,
            SUM(pd.delta_tx)    AS tx_bytes,
            SUM(pd.delta_rx + pd.delta_tx) AS total_bytes
        FROM port_deltas pd
        LEFT JOIN device_registry dr ON dr.ip = pd.device_ip
        WHERE pd.device_ip NOT IN (SELECT target_ip FROM infra_ips)
        GROUP BY pd.device_ip, dr.hostname, dr.mac
        ORDER BY total_bytes DESC
        LIMIT :limit
    """, {"limit": limit})

    return [
        TopDeviceRow(
            ip=r["ip"],
            hostname=r.get("hostname"),
            mac=r.get("mac"),
            rx_bytes=int(r.get("rx_bytes") or 0),
            tx_bytes=int(r.get("tx_bytes") or 0),
            total_bytes=int(r.get("total_bytes") or 0),
        )
        for r in rows
    ]


@router.get("/latency", response_model=LatencyResponse)
async def get_latency(
    period: Literal["15m", "1h", "6h", "24h", "7d"] = Query("1h"),
    targets: str = Query("all"),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns aggregated latency time series, bucketed by TimescaleDB time_bucket.
    Pivots per-target rows into a single wide series for easy charting.

    targets=all  — all targets
    targets=gateway,8.8.8.8  — comma-separated filter
    """
    if not _IS_POSTGRES:
        return LatencyResponse(targets=[], series=[])

    lookback, bucket = _PERIOD_CONFIG[period]

    target_filter_sql = ""
    params: dict = {}
    if targets.lower() != "all":
        names = [t.strip() for t in targets.split(",") if t.strip()]
        if names:
            target_filter_sql = "AND target_name = ANY(:target_names)"
            params["target_names"] = names

    # f-string is safe here: lookback and bucket come from our whitelist dict
    sql = f"""
        SELECT
            time_bucket('{bucket}', time) AS bucket,
            target_name,
            AVG(rtt_ms)           AS avg_rtt,
            AVG(packet_loss_pct)  AS avg_loss
        FROM latency_metrics
        WHERE time >= NOW() - INTERVAL '{lookback}'
          {target_filter_sql}
        GROUP BY bucket, target_name
        ORDER BY bucket ASC
    """
    rows = await _exec(db, sql, params)
    logger.info("latency time_bucket query period=%s returned %d rows", period, len(rows))

    if not rows:
        # time_bucket() requires the TimescaleDB extension. Fall back to date_trunc()
        # which works on standard Supabase PostgreSQL without TimescaleDB.
        trunc_unit = _PERIOD_DATE_TRUNC[period]
        sql_datetunc = f"""
            SELECT
                date_trunc('{trunc_unit}', time) AS bucket,
                target_name,
                AVG(rtt_ms)           AS avg_rtt,
                AVG(packet_loss_pct)  AS avg_loss
            FROM latency_metrics
            WHERE time >= NOW() - INTERVAL '{lookback}'
              {target_filter_sql}
            GROUP BY bucket, target_name
            ORDER BY bucket ASC
        """
        rows = await _exec(db, sql_datetunc, params)
        logger.info("latency date_trunc('%s') fallback returned %d rows", trunc_unit, len(rows))

    if not rows:
        # No aggregated data yet (collector just started or table is empty).
        # Return raw rows so the chart has something to display immediately.
        sql_raw = f"""
            SELECT
                time                AS bucket,
                target_name,
                rtt_ms              AS avg_rtt,
                packet_loss_pct     AS avg_loss
            FROM latency_metrics
            WHERE time >= NOW() - INTERVAL '{lookback}'
              {target_filter_sql}
            ORDER BY time ASC
            LIMIT 500
        """
        rows = await _exec(db, sql_raw, params)
        logger.info("latency raw fallback returned %d rows", len(rows))

    # Collect distinct target names and their types in the result
    all_targets  = sorted({r["target_name"] for r in rows if r.get("target_name")})
    target_types: dict[str, str] = {}
    if all_targets:
        type_rows = await _exec(db, """
            SELECT DISTINCT ON (target_name) target_name, target_type
            FROM latency_metrics
            WHERE target_name = ANY(:names)
            ORDER BY target_name, time DESC
        """, {"names": all_targets})
        target_types = {r["target_name"]: r["target_type"] for r in type_rows if r.get("target_type")}

    # Pivot: one dict per time bucket, one key per target
    buckets: dict[str, dict] = {}
    for row in rows:
        t_key = (
            row["bucket"].isoformat()
            if isinstance(row["bucket"], datetime)
            else str(row["bucket"])
        )
        if t_key not in buckets:
            buckets[t_key] = {"time": t_key}
        key = _sanitise_key(row["target_name"])
        buckets[t_key][f"{key}_rtt"]  = round(float(row["avg_rtt"]),  2) if row["avg_rtt"]  is not None else None
        buckets[t_key][f"{key}_loss"] = round(float(row["avg_loss"]), 2) if row["avg_loss"] is not None else None

    return LatencyResponse(
        targets=all_targets,
        target_types=target_types,
        series=sorted(buckets.values(), key=lambda x: x["time"]),
    )


@router.get("/ports", response_model=list[PortStatus])
async def get_ports(
    switch_id: Optional[str] = Query(None),
    status: Literal["all", "errors", "high_traffic", "offline"] = Query("all"),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns latest port state per switch/port pair.
    bytes/sec is calculated as the delta between the two most recent rows
    divided by the elapsed seconds (approximation; counters may reset on switch reboot).
    """
    if not _IS_POSTGRES:
        return []

    switch_filter = "AND switch_id = :switch_id" if switch_id else ""
    params = {"switch_id": switch_id} if switch_id else {}

    rows = await _exec(db, f"""
        WITH ranked AS (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY switch_id, port_id ORDER BY time DESC) AS rn,
                LAG(rx_bytes) OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_rx,
                LAG(tx_bytes) OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_tx,
                LAG(time)     OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_time
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '10 minutes'
              {switch_filter}
        ),
        latest AS (
            SELECT * FROM ranked WHERE rn = 1
        ),
        errors_1h AS (
            SELECT
                switch_id, port_id,
                SUM(rx_errors)                                          AS rx_errors_1h,
                SUM(tx_errors)                                          AS tx_errors_1h,
                MAX(CASE WHEN rx_errors > 0 OR tx_errors > 0 THEN time END) AS last_error_time
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '1 hour'
              {switch_filter}
            GROUP BY switch_id, port_id
        )
        SELECT
            l.switch_id, l.switch_name, l.port_id, l.port_name,
            l.device_name, l.device_ip::text, l.is_uplink,
            CASE
                WHEN l.prev_rx IS NOT NULL AND l.rx_bytes >= l.prev_rx
                     AND EXTRACT(EPOCH FROM (l.time - l.prev_time)) > 0
                THEN (l.rx_bytes - l.prev_rx)::float
                     / EXTRACT(EPOCH FROM (l.time - l.prev_time))
                ELSE 0
            END AS rx_bytes_rate,
            CASE
                WHEN l.prev_tx IS NOT NULL AND l.tx_bytes >= l.prev_tx
                     AND EXTRACT(EPOCH FROM (l.time - l.prev_time)) > 0
                THEN (l.tx_bytes - l.prev_tx)::float
                     / EXTRACT(EPOCH FROM (l.time - l.prev_time))
                ELSE 0
            END AS tx_bytes_rate,
            COALESCE(e.rx_errors_1h, 0)  AS rx_errors_1h,
            COALESCE(e.tx_errors_1h, 0)  AS tx_errors_1h,
            e.last_error_time
        FROM latest l
        LEFT JOIN errors_1h e USING (switch_id, port_id)
        ORDER BY l.switch_id, l.port_id
    """, params)

    # ── Error history (24 h, hourly buckets) ──────────────────────────────────
    err_rows = await _exec(db, f"""
        SELECT switch_id, port_id::text AS port_id,
               date_trunc('hour', time) AS bucket,
               SUM(rx_errors)           AS rx_errors,
               SUM(tx_errors)           AS tx_errors
        FROM switch_port_metrics
        WHERE time > NOW() - INTERVAL '24 hours'
          {switch_filter}
        GROUP BY switch_id, port_id, bucket
        ORDER BY switch_id, port_id, bucket
    """, params)

    err_map: dict[tuple, list] = {}
    for er in err_rows:
        key = (er["switch_id"], str(er["port_id"]))
        bucket_t = er.get("bucket")
        bucket_s = bucket_t.isoformat() if isinstance(bucket_t, datetime) else str(bucket_t)
        err_map.setdefault(key, []).append({
            "time":      bucket_s,
            "rx_errors": int(er.get("rx_errors") or 0),
            "tx_errors": int(er.get("tx_errors") or 0),
        })

    # ── Throughput history (1 h, rate between readings) ────────────────────────
    tput_rows = await _exec(db, f"""
        SELECT switch_id, port_id::text AS port_id, time,
               CASE
                   WHEN prev_rx IS NOT NULL AND rx_bytes >= prev_rx AND elapsed > 0
                   THEN (rx_bytes - prev_rx)::float / elapsed
               END AS rx_bytes_rate,
               CASE
                   WHEN prev_tx IS NOT NULL AND tx_bytes >= prev_tx AND elapsed > 0
                   THEN (tx_bytes - prev_tx)::float / elapsed
               END AS tx_bytes_rate
        FROM (
            SELECT switch_id, port_id, time, rx_bytes, tx_bytes,
                   LAG(rx_bytes) OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_rx,
                   LAG(tx_bytes) OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_tx,
                   EXTRACT(EPOCH FROM (
                       time - LAG(time) OVER (PARTITION BY switch_id, port_id ORDER BY time)
                   )) AS elapsed
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '1 hour'
              {switch_filter}
        ) sub
        WHERE prev_rx IS NOT NULL
        ORDER BY switch_id, port_id, time
    """, params)

    tput_map: dict[tuple, list] = {}
    for tp in tput_rows:
        key = (tp["switch_id"], str(tp["port_id"]))
        t = tp.get("time")
        tput_map.setdefault(key, []).append({
            "time":          t.isoformat() if isinstance(t, datetime) else str(t),
            "rx_bytes_rate": round(float(tp.get("rx_bytes_rate") or 0), 2),
            "tx_bytes_rate": round(float(tp.get("tx_bytes_rate") or 0), 2),
        })

    # ── Build result ───────────────────────────────────────────────────────────
    result = []
    for row in rows:
        st = _port_status(row)
        if status == "errors"       and st not in ("error", "warning"):
            continue
        if status == "high_traffic" and float(row.get("rx_bytes_rate") or 0) < 100_000:
            continue
        if status == "offline"      and row.get("device_name"):
            continue

        key = (row["switch_id"], str(row["port_id"]))
        result.append(PortStatus(
            switch_id=row["switch_id"],
            switch_name=row.get("switch_name"),
            port_id=row["port_id"],
            port_name=row.get("port_name"),
            device_name=row.get("device_name"),
            device_ip=row.get("device_ip"),
            rx_bytes_rate=round(float(row.get("rx_bytes_rate") or 0), 2),
            tx_bytes_rate=round(float(row.get("tx_bytes_rate") or 0), 2),
            rx_errors_1h=int(row.get("rx_errors_1h") or 0),
            tx_errors_1h=int(row.get("tx_errors_1h") or 0),
            status=st,
            last_error_time=row.get("last_error_time"),
            errors_24h=err_map.get(key, []),
            throughput_1h=tput_map.get(key, []),
        ))

    return result


@router.get("/flows", response_model=list[FlowRow])
async def get_flows(
    period: Literal["15m", "1h", "6h", "24h", "7d"] = Query("1h"),
    ip: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """
    Top flows by bytes, aggregated by (src_ip, dst_ip, dst_port, protocol).
    Includes hostname resolution from device_registry and percentage of total bytes.
    """
    if not _IS_POSTGRES:
        return []

    lookback = _PERIOD_CONFIG[period][0]
    ip_filter = "AND (f.src_ip::text = :ip OR f.dst_ip::text = :ip)" if ip else ""
    params: dict = {"limit": limit}
    if ip:
        params["ip"] = ip

    rows = await _exec(db, f"""
        WITH flow_agg AS (
            SELECT
                src_ip::text  AS src_ip,
                dst_ip::text  AS dst_ip,
                dst_port,
                protocol,
                direction,
                SUM(bytes)    AS bytes,
                SUM(packets)  AS packets
            FROM network_flows f
            WHERE time > NOW() - INTERVAL '{lookback}'
              {ip_filter}
            GROUP BY src_ip, dst_ip, dst_port, protocol, direction
        ),
        totals AS (
            SELECT SUM(bytes) AS total_bytes FROM flow_agg
        )
        SELECT
            fa.src_ip,
            fa.dst_ip,
            fa.dst_port,
            fa.protocol,
            fa.direction,
            fa.bytes,
            fa.packets,
            d1.hostname AS src_hostname,
            d2.hostname AS dst_hostname,
            CASE WHEN t.total_bytes > 0
                THEN ROUND((fa.bytes::numeric / t.total_bytes * 100), 2)
                ELSE 0
            END AS percent_of_total
        FROM flow_agg fa
        CROSS JOIN totals t
        LEFT JOIN device_registry d1 ON fa.src_ip = d1.ip::text
        LEFT JOIN device_registry d2 ON fa.dst_ip = d2.ip::text
        ORDER BY fa.bytes DESC
        LIMIT :limit
    """, params)

    return [
        FlowRow(
            src_ip=row.get("src_ip"),
            src_hostname=row.get("src_hostname"),
            dst_ip=row.get("dst_ip"),
            dst_hostname=row.get("dst_hostname"),
            protocol_name=_protocol_name(row.get("dst_port"), row.get("protocol")),
            bytes=int(row.get("bytes") or 0),
            packets=int(row.get("packets") or 0),
            direction=row.get("direction"),
            percent_of_total=float(row.get("percent_of_total") or 0),
        )
        for row in rows
    ]


@router.get("/devices", response_model=list[DeviceRow])
async def list_devices(db: AsyncSession = Depends(get_db)):
    """List all known devices from device_registry, newest first.
    Joins with switch_port_metrics to resolve switch_name from the switch MAC."""
    rows = await _exec(db, """
        SELECT
            d.ip::text AS ip, d.mac, d.hostname, d.switch_id,
            spm.switch_name,
            d.port_id, d.last_seen, d.first_seen, d.is_online,
            d.device_type, d.notes
        FROM device_registry d
        LEFT JOIN (
            SELECT DISTINCT ON (switch_id) switch_id, switch_name
            FROM switch_port_metrics
            ORDER BY switch_id, time DESC
        ) spm ON spm.switch_id = d.switch_id
        ORDER BY d.last_seen DESC NULLS LAST
    """)
    return [DeviceRow(**r) for r in rows]


@router.patch("/devices/{ip:path}", response_model=DeviceRow)
async def update_device(
    ip: str,
    body: DeviceUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update notes or device_type for a device in device_registry."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    existing = await _exec(db,
        "SELECT ip::text AS ip FROM device_registry WHERE ip::text = :ip",
        {"ip": ip})
    if not existing:
        raise HTTPException(status_code=404, detail="Device not found")

    updates: list[str] = []
    params: dict = {"ip": ip}
    if body.notes is not None:
        updates.append("notes = :notes")
        params["notes"] = body.notes
    if body.device_type is not None:
        updates.append("device_type = :device_type")
        params["device_type"] = body.device_type

    if updates:
        await _exec(db,
            f"UPDATE device_registry SET {', '.join(updates)} WHERE ip::text = :ip",
            params)
        await db.commit()

    rows = await _exec(db,
        "SELECT ip::text AS ip, mac, hostname, switch_id, port_id, "
        "last_seen, first_seen, is_online, device_type, notes "
        "FROM device_registry WHERE ip::text = :ip",
        {"ip": ip})
    return DeviceRow(**rows[0])


@router.delete("/devices/{ip:path}", status_code=204)
async def delete_device(ip: str, db: AsyncSession = Depends(get_db)):
    """Remove a device from the registry entirely ('forget device')."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    existing = await _exec(db,
        "SELECT ip::text AS ip FROM device_registry WHERE ip::text = :ip",
        {"ip": ip})
    if not existing:
        raise HTTPException(status_code=404, detail="Device not found")

    await _exec(db, "DELETE FROM device_registry WHERE ip::text = :ip", {"ip": ip})
    await db.commit()


@router.get("/device/{ip:path}", response_model=DeviceDetail)
async def get_device(ip: str, db: AsyncSession = Depends(get_db)):
    """Full device profile: registry info, current port state, flows, latency, incidents."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=404, detail="Device not found")

    dev_rows = await _exec(db,
        "SELECT ip::text AS ip, mac, hostname, switch_id, port_id, "
        "last_seen, first_seen, is_online, device_type, notes "
        "FROM device_registry WHERE ip::text = :ip",
        {"ip": ip})
    if not dev_rows:
        raise HTTPException(status_code=404, detail="Device not found")
    dev = dev_rows[0]

    # Current port state
    port_rows = await _exec(db, """
        SELECT switch_id, switch_name, port_id, port_name,
               rx_bytes, tx_bytes, rx_errors, tx_errors, poe_watts, is_uplink, time
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
        ORDER BY time DESC LIMIT 1
    """, {"ip": ip})
    current_port = port_rows[0] if port_rows else None

    # Flows last hour
    flows = await _exec(db, """
        SELECT src_ip::text, dst_ip::text, dst_port, protocol, direction,
               SUM(bytes) AS bytes, SUM(packets) AS packets
        FROM network_flows
        WHERE time > NOW() - INTERVAL '1 hour'
          AND (src_ip::text = :ip OR dst_ip::text = :ip)
        GROUP BY src_ip, dst_ip, dst_port, protocol, direction
        ORDER BY bytes DESC
        LIMIT 20
    """, {"ip": ip})

    # Port errors last 24h — try time_bucket first, fall back to date_trunc
    port_errors_24h = await _exec(db, """
        SELECT time_bucket('1 hour', time) AS bucket,
               SUM(rx_errors) AS rx_errors,
               SUM(tx_errors) AS tx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time > NOW() - INTERVAL '24 hours'
        GROUP BY bucket ORDER BY bucket ASC
    """, {"ip": ip})
    if not port_errors_24h:
        port_errors_24h = await _exec(db, """
            SELECT date_trunc('hour', time) AS bucket,
                   SUM(rx_errors) AS rx_errors,
                   SUM(tx_errors) AS tx_errors
            FROM switch_port_metrics
            WHERE device_ip::text = :ip
              AND time > NOW() - INTERVAL '24 hours'
            GROUP BY bucket ORDER BY bucket ASC
        """, {"ip": ip})

    # Gateway latency last 24h (shows network conditions for this device's segment)
    # fping tracks fixed targets (gateway/WAN/DNS), not individual device IPs
    latency_24h = await _exec(db, """
        SELECT time_bucket('15 minutes', time) AS bucket,
               AVG(rtt_ms) AS avg_rtt,
               AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE target_type = 'gateway'
          AND time > NOW() - INTERVAL '24 hours'
        GROUP BY bucket ORDER BY bucket ASC
    """, {})
    if not latency_24h:
        latency_24h = await _exec(db, """
            SELECT date_trunc('hour', time) AS bucket,
                   AVG(rtt_ms) AS avg_rtt,
                   AVG(packet_loss_pct) AS avg_loss
            FROM latency_metrics
            WHERE target_type = 'gateway'
              AND time > NOW() - INTERVAL '24 hours'
            GROUP BY bucket ORDER BY bucket ASC
        """, {})

    # Related incidents
    incidents = await _exec(db,
        "SELECT id::text AS id, started_at, resolved_at, severity, category, "
        "title, description, root_cause, resolution_notes "
        "FROM network_incidents "
        "WHERE affected_ip::text = :ip "
        "ORDER BY started_at DESC LIMIT 10",
        {"ip": ip})

    def _serialise(rows: list[dict]) -> list[dict]:
        out = []
        for r in rows:
            d = {}
            for k, v in r.items():
                # Rename 'bucket' → 'time' so all chart data uses the same key
                out_key = "time" if k == "bucket" else k
                d[out_key] = v.isoformat() if isinstance(v, datetime) else v
            out.append(d)
        return out

    return DeviceDetail(
        ip=dev["ip"],
        mac=dev.get("mac"),
        hostname=dev.get("hostname"),
        switch_id=dev.get("switch_id"),
        port_id=dev.get("port_id"),
        device_type=dev.get("device_type"),
        notes=dev.get("notes"),
        is_online=bool(dev.get("is_online")),
        last_seen=dev.get("last_seen"),
        current_port_status=_serialise([current_port])[0] if current_port else None,
        flows_last_hour=_serialise(flows),
        port_errors_24h=_serialise(port_errors_24h),
        latency_to_gateway_24h=_serialise(latency_24h),
        incidents=_serialise(incidents),
    )


@router.get("/investigate", response_model=InvestigateResponse)
async def investigate(
    ip: str = Query(..., description="Device IP to investigate"),
    start: datetime = Query(..., description="Window start (ISO-8601)"),
    end: datetime   = Query(..., description="Window end (ISO-8601)"),
    db: AsyncSession = Depends(get_db),
):
    """
    Full diagnostic for a device over a time window.
    Returns a merged timeline of events, aggregate metrics, and an
    automated hypothesis about the likely root cause.
    """
    if not _IS_POSTGRES:
        return InvestigateResponse(
            device=None,
            timeline=[],
            metrics=InvestigateMetrics(
                port_rx_errors=0, port_tx_errors=0,
                avg_packet_loss_gateway_pct=0.0, avg_packet_loss_wan_pct=0.0,
                avg_rtt_gateway_ms=None, bytes_sent=0, bytes_received=0,
                top_destinations=[],
            ),
            hypothesis=Hypothesis(
                likely_cause="unknown", confidence="low",
                evidence=["Network tables not available (SQLite dev mode)"],
                recommended_action="Run against a PostgreSQL/Supabase database.",
            ),
        )

    params = {"ip": ip, "start": start, "end": end}

    # Device info
    dev_rows = await _exec(db,
        "SELECT ip::text AS ip, mac, hostname, switch_id, port_id, "
        "last_seen, is_online, device_type, notes "
        "FROM device_registry WHERE ip::text = :ip", {"ip": ip})
    device = dev_rows[0] if dev_rows else None

    # Port error totals in window
    port_err_rows = await _exec(db, """
        SELECT COALESCE(SUM(rx_errors), 0) AS rx_errors,
               COALESCE(SUM(tx_errors), 0) AS tx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time BETWEEN :start AND :end
    """, params)
    port_rx_errors = int((port_err_rows[0] or {}).get("rx_errors") or 0)
    port_tx_errors = int((port_err_rows[0] or {}).get("tx_errors") or 0)
    has_wired_port = bool(port_err_rows and port_err_rows[0].get("rx_errors") is not None)

    # Gateway latency in window
    gw_rows = await _exec(db, """
        SELECT AVG(packet_loss_pct) AS avg_loss,
               AVG(rtt_ms)          AS avg_rtt
        FROM latency_metrics
        WHERE target_type = 'gateway'
          AND time BETWEEN :start AND :end
    """, params)
    gateway_loss = float((gw_rows[0] or {}).get("avg_loss") or 0)
    gateway_rtt  = (gw_rows[0] or {}).get("avg_rtt")

    # WAN latency in window
    wan_rows = await _exec(db, """
        SELECT AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE target_type IN ('wan', 'dns')
          AND time BETWEEN :start AND :end
    """, params)
    wan_loss = float((wan_rows[0] or {}).get("avg_loss") or 0)

    # Flow metrics in window
    flow_rows = await _exec(db, """
        SELECT
            COALESCE(SUM(CASE WHEN src_ip::text = :ip THEN bytes ELSE 0 END), 0) AS bytes_sent,
            COALESCE(SUM(CASE WHEN dst_ip::text = :ip THEN bytes ELSE 0 END), 0) AS bytes_received,
            COALESCE(SUM(bytes), 0) AS total_bytes
        FROM network_flows
        WHERE (src_ip::text = :ip OR dst_ip::text = :ip)
          AND time BETWEEN :start AND :end
    """, params)
    bytes_sent     = int((flow_rows[0] or {}).get("bytes_sent")     or 0)
    bytes_received = int((flow_rows[0] or {}).get("bytes_received") or 0)

    # Top destinations
    top_dest = await _exec(db, """
        SELECT dst_ip::text AS dst_ip, dst_port, protocol,
               SUM(bytes) AS bytes, SUM(packets) AS packets
        FROM network_flows
        WHERE src_ip::text = :ip
          AND time BETWEEN :start AND :end
        GROUP BY dst_ip, dst_port, protocol
        ORDER BY bytes DESC
        LIMIT 10
    """, params)

    # Collaboration traffic detection
    has_collab = any(
        row.get("dst_port") in _COLLAB_PORTS for row in top_dest
    )

    # ── Timeline ──────────────────────────────────────────────────────────────

    timeline: list[TimelineEvent] = []

    # Port error events (bucket by 5 min)
    port_events = await _exec(db, """
        SELECT time_bucket('5 minutes', time) AS bucket,
               SUM(rx_errors) AS rx_errors,
               SUM(tx_errors) AS tx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time BETWEEN :start AND :end
          AND (rx_errors > 0 OR tx_errors > 0)
        GROUP BY bucket
        ORDER BY bucket ASC
    """, params)
    for e in port_events:
        total = int(e.get("rx_errors") or 0) + int(e.get("tx_errors") or 0)
        timeline.append(TimelineEvent(
            time=e["bucket"],
            event_type="port_errors",
            severity="warning" if total < 50 else "critical",
            description=f"Port errors: {int(e.get('rx_errors') or 0)} RX, {int(e.get('tx_errors') or 0)} TX",
        ))

    # Latency spike events (> 50 ms or > 5% loss, bucketed)
    lat_events = await _exec(db, """
        SELECT time_bucket('5 minutes', time) AS bucket,
               AVG(rtt_ms) AS avg_rtt,
               AVG(packet_loss_pct) AS avg_loss,
               target_type
        FROM latency_metrics
        WHERE time BETWEEN :start AND :end
          AND (rtt_ms > 50 OR packet_loss_pct > 5)
        GROUP BY bucket, target_type
        HAVING AVG(rtt_ms) > 50 OR AVG(packet_loss_pct) > 5
        ORDER BY bucket ASC
    """, params)
    for e in lat_events:
        rtt  = round(float(e.get("avg_rtt")  or 0), 1)
        loss = round(float(e.get("avg_loss") or 0), 1)
        sev  = "critical" if loss > 20 else "warning"
        timeline.append(TimelineEvent(
            time=e["bucket"],
            event_type="latency_spike",
            severity=sev,
            description=f"{e.get('target_type','?')} latency spike: {rtt} ms, {loss}% loss",
        ))

    # Incidents in window
    inc_events = await _exec(db,
        "SELECT started_at, severity, title FROM network_incidents "
        "WHERE (affected_ip::text = :ip OR :ip = ANY(ARRAY[affected_ip::text])) "
        "AND started_at BETWEEN :start AND :end "
        "ORDER BY started_at ASC",
        params)
    for e in inc_events:
        timeline.append(TimelineEvent(
            time=e["started_at"],
            event_type="incident",
            severity=e.get("severity", "info"),
            description=e.get("title", "Network incident"),
        ))

    timeline.sort(key=lambda x: x.time)

    # ── Related incidents for device ──────────────────────────────────────────
    related_incidents = await _exec(db,
        "SELECT id::text AS id, started_at, resolved_at, severity, category, title "
        "FROM network_incidents WHERE affected_ip::text = :ip "
        "AND started_at BETWEEN :start AND :end "
        "ORDER BY started_at DESC",
        params)

    def _fmt(rows: list[dict]) -> list[dict]:
        out = []
        for r in rows:
            d = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in r.items()}
            out.append(d)
        return out

    if device:
        device = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in device.items()}

    top_dest_fmt = [
        {
            "dst_ip":        r.get("dst_ip"),
            "protocol_name": _protocol_name(r.get("dst_port"), r.get("protocol")),
            "bytes":         int(r.get("bytes") or 0),
            "packets":       int(r.get("packets") or 0),
        }
        for r in top_dest
    ]

    return InvestigateResponse(
        device=device,
        timeline=timeline,
        metrics=InvestigateMetrics(
            port_rx_errors=port_rx_errors,
            port_tx_errors=port_tx_errors,
            avg_packet_loss_gateway_pct=round(gateway_loss, 2),
            avg_packet_loss_wan_pct=round(wan_loss, 2),
            avg_rtt_gateway_ms=round(float(gateway_rtt), 2) if gateway_rtt is not None else None,
            bytes_sent=bytes_sent,
            bytes_received=bytes_received,
            top_destinations=top_dest_fmt,
        ),
        hypothesis=_compute_hypothesis(
            port_rx_errors=port_rx_errors,
            port_tx_errors=port_tx_errors,
            gateway_loss=gateway_loss,
            wan_loss=wan_loss,
            has_wired_port=has_wired_port,
            has_collab_traffic=has_collab,
        ),
    )


@router.get("/incidents", response_model=list[IncidentRow])
async def list_incidents(
    status: Literal["open", "resolved", "all"] = Query("open"),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    where = {
        "open":     "WHERE resolved_at IS NULL",
        "resolved": "WHERE resolved_at IS NOT NULL",
        "all":      "",
    }[status]
    rows = await _exec(db,
        f"SELECT id::text AS id, started_at, resolved_at, severity, category, "
        f"affected_ip::text AS affected_ip, affected_switch, affected_port, "
        f"title, description, evidence, root_cause, resolution_notes, auto_detected "
        f"FROM network_incidents {where} "
        f"ORDER BY started_at DESC LIMIT :limit",
        {"limit": limit})

    return [
        IncidentRow(
            id=r["id"],
            started_at=r["started_at"],
            resolved_at=r.get("resolved_at"),
            severity=r["severity"],
            category=r["category"],
            affected_ip=r.get("affected_ip"),
            affected_switch=r.get("affected_switch"),
            affected_port=r.get("affected_port"),
            title=r["title"],
            description=r.get("description"),
            evidence=r.get("evidence") if isinstance(r.get("evidence"), dict) else None,
            root_cause=r.get("root_cause"),
            resolution_notes=r.get("resolution_notes"),
            auto_detected=bool(r.get("auto_detected")),
        )
        for r in rows
    ]


@router.post("/incidents/{incident_id}/resolve", response_model=IncidentRow)
async def resolve_incident(
    incident_id: str,
    body: IncidentResolve = Body(default=IncidentResolve()),
    db: AsyncSession = Depends(get_db),
):
    """Mark an incident as resolved and optionally record root cause and notes."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    existing = await _exec(db,
        "SELECT id::text AS id FROM network_incidents WHERE id::text = :id",
        {"id": incident_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Incident not found")

    await _exec(db, """
        UPDATE network_incidents
        SET resolved_at       = NOW(),
            root_cause        = COALESCE(:root_cause, root_cause),
            resolution_notes  = COALESCE(:notes, resolution_notes)
        WHERE id::text = :id
    """, {
        "id":         incident_id,
        "root_cause": body.root_cause,
        "notes":      body.resolution_notes,
    })
    await db.commit()

    rows = await _exec(db,
        "SELECT id::text AS id, started_at, resolved_at, severity, category, "
        "affected_ip::text AS affected_ip, affected_switch, affected_port, "
        "title, description, evidence, root_cause, resolution_notes, auto_detected "
        "FROM network_incidents WHERE id::text = :id",
        {"id": incident_id})

    r = rows[0]
    return IncidentRow(
        id=r["id"],
        started_at=r["started_at"],
        resolved_at=r.get("resolved_at"),
        severity=r["severity"],
        category=r["category"],
        affected_ip=r.get("affected_ip"),
        affected_switch=r.get("affected_switch"),
        affected_port=r.get("affected_port"),
        title=r["title"],
        description=r.get("description"),
        evidence=r.get("evidence") if isinstance(r.get("evidence"), dict) else None,
        root_cause=r.get("root_cause"),
        resolution_notes=r.get("resolution_notes"),
        auto_detected=bool(r.get("auto_detected")),
    )


# ── Network settings ──────────────────────────────────────────────────────────

_DEFAULT_SETTINGS: dict[str, str] = {
    "wan_packet_loss_threshold_pct": "5",
    "internal_latency_threshold_ms": "50",
    "port_error_threshold":          "50",
    "traffic_anomaly_multiplier":    "5",
    "business_hours_start":          "08:00",
    "business_hours_end":            "18:00",
}


@router.get("/settings", response_model=list[NetworkSettingItem])
async def get_settings(db: AsyncSession = Depends(get_db)):
    """Return all network alert threshold settings."""
    if not _IS_POSTGRES:
        return [NetworkSettingItem(key=k, value=v) for k, v in _DEFAULT_SETTINGS.items()]

    try:
        rows = await _exec(db, "SELECT key, value, updated_at FROM network_settings ORDER BY key")
    except Exception:
        return [NetworkSettingItem(key=k, value=v) for k, v in _DEFAULT_SETTINGS.items()]

    result = {r["key"]: r for r in rows}
    out: list[NetworkSettingItem] = []
    for k, default_v in _DEFAULT_SETTINGS.items():
        if k in result:
            out.append(NetworkSettingItem(key=k, value=result[k]["value"], updated_at=result[k].get("updated_at")))
        else:
            out.append(NetworkSettingItem(key=k, value=default_v))
    return out


@router.patch("/settings", response_model=list[NetworkSettingItem])
async def update_settings(body: NetworkSettingsUpdate, db: AsyncSession = Depends(get_db)):
    """Upsert one or more settings by key."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    for key, value in body.settings.items():
        if key not in _DEFAULT_SETTINGS:
            raise HTTPException(status_code=400, detail=f"Unknown setting key: {key}")
        await _exec(db,
            "INSERT INTO network_settings (key, value, updated_at) VALUES (:key, :value, NOW()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            {"key": key, "value": value})
    await db.commit()

    rows = await _exec(db, "SELECT key, value, updated_at FROM network_settings ORDER BY key")
    result = {r["key"]: r for r in rows}
    return [
        NetworkSettingItem(key=k, value=result.get(k, {}).get("value", v),
                           updated_at=result.get(k, {}).get("updated_at"))
        for k, v in _DEFAULT_SETTINGS.items()
    ]


# ── fping targets ─────────────────────────────────────────────────────────────

@router.get("/targets", response_model=list[FpingTarget])
async def list_targets(db: AsyncSession = Depends(get_db)):
    """List all fping monitoring targets."""
    if not _IS_POSTGRES:
        return []
    try:
        rows = await _exec(db,
            "SELECT id::text AS id, name, ip, type, created_at FROM fping_targets ORDER BY created_at")
        return [FpingTarget(**r) for r in rows]
    except Exception:
        return []


@router.post("/targets", response_model=FpingTarget, status_code=201)
async def create_target(body: FpingTargetCreate, db: AsyncSession = Depends(get_db)):
    """Add a new fping monitoring target."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    existing = await _exec(db,
        "SELECT id FROM fping_targets WHERE ip = :ip", {"ip": body.ip})
    if existing:
        raise HTTPException(status_code=409, detail="Target with that IP already exists")

    rows = await _exec(db,
        "INSERT INTO fping_targets (name, ip, type) VALUES (:name, :ip, :type) "
        "RETURNING id::text AS id, name, ip, type, created_at",
        {"name": body.name, "ip": body.ip, "type": body.type})
    return FpingTarget(**rows[0])


@router.delete("/targets/{target_id}", status_code=204)
async def delete_target(target_id: str, db: AsyncSession = Depends(get_db)):
    """Remove a fping monitoring target."""
    if not _IS_POSTGRES:
        raise HTTPException(status_code=503, detail="Network tables not available")

    existing = await _exec(db,
        "SELECT id FROM fping_targets WHERE id::text = :id", {"id": target_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Target not found")

    await _exec(db, "DELETE FROM fping_targets WHERE id::text = :id", {"id": target_id})
    await db.commit()
