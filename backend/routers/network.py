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
import time as _time
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

# ── In-memory response caches ─────────────────────────────────────────────────
# switch_id → switch_name; refreshed every 300 s (changes only when new switches
# are added, so a stale read is harmless).
_switch_names: dict[str, str | None] = {}
_switch_names_ts: float = 0.0
_SWITCH_NAMES_TTL = 300.0


async def warm_switch_names_cache() -> None:
    """
    Pre-populate the switch_names cache on startup so the first user request
    never triggers an 18-second cold query against switch_port_metrics.
    Called from main.py lifespan before the app begins serving traffic.
    No-op on SQLite or if the table does not yet exist.
    """
    global _switch_names, _switch_names_ts
    if not _IS_POSTGRES:
        return
    try:
        from backend.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            name_rows = await _exec(db, """
                SELECT DISTINCT ON (switch_id) switch_id, switch_name
                FROM switch_port_metrics
                ORDER BY switch_id, time DESC
            """)
        _switch_names = {r["switch_id"]: r.get("switch_name") for r in name_rows}
        _switch_names_ts = _time.monotonic()
        logger.info("switch_names cache pre-warmed: %d switch(es)", len(_switch_names))
    except Exception:
        logger.warning("switch_names cache pre-warm failed — first request will populate it")

# /ports full response keyed by (switch_id, status); refreshed every 30 s.
# Port error data is aggregated over 24 h — 30 s staleness is imperceptible.
_ports_cache: dict[str, tuple[list, float]] = {}
_PORTS_CACHE_TTL = 30.0

# /overview and /top-devices; refreshed every 30 s.
_overview_cache: tuple[Any, float] | None = None
_top_devices_cache: dict[str, tuple[list, float]] = {}  # keyed by "period:limit"
_RESPONSE_CACHE_TTL = 30.0

# ── Constants ─────────────────────────────────────────────────────────────────

# period value → (lookback interval, bucket size)
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
    status: Literal["healthy", "degraded", "down", "unknown"]
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
    # NinjaRMM-enriched fields
    ninja_id: Optional[int] = None
    os_name: Optional[str] = None
    last_logged_in_user: Optional[str] = None
    serial: Optional[str] = None
    ninja_online: Optional[bool] = None
    disk_free_pct: Optional[float] = None
    last_reboot: Optional[datetime] = None


class TimelineEvent(BaseModel):
    time: datetime
    event_type: str
    severity: str
    description: str


class InvestigateMetrics(BaseModel):
    port_rx_errors: int
    port_tx_errors: int
    port_rx_dropped: int = 0
    port_tx_dropped: int = 0
    port_rx_frags: int = 0
    error_rate_pct: float = 0.0
    error_timeline_profile: str = "normal"   # "sustained" | "single_spike" | "normal"
    error_windows_with_errors: int = 0       # of last 12 five-min windows, how many had errors
    peer_avg_error_rate: Optional[float] = None
    peer_comparison_result: str = "no_peer_data"  # "normal"|"elevated"|"highly_elevated"|"no_peer_data"
    avg_packet_loss_gateway_pct: float
    avg_packet_loss_wan_pct: float
    avg_rtt_gateway_ms: Optional[float]
    bytes_sent: int
    bytes_received: int
    top_destinations: list[dict[str, Any]]
    raw_port_metrics: list[dict[str, Any]] = []


class Hypothesis(BaseModel):
    likely_cause: Literal[
        "cable_or_nic", "wan_issue", "wan_instability", "firewall_drop", "server_side",
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
    global_incidents: list[dict[str, Any]] = []   # global incidents active during window
    device_incidents: list[dict[str, Any]] = []   # device-scoped incidents (last 20)


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
    incident_scope: str = "device"
    affected_component: Optional[str] = None


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
    is_wired: Optional[bool] = None
    # NinjaRMM-enriched fields
    ninja_id: Optional[int] = None
    os_name: Optional[str] = None
    last_logged_in_user: Optional[str] = None
    serial: Optional[str] = None
    ninja_online: Optional[bool] = None
    disk_free_pct: Optional[float] = None


class DeviceUpdate(BaseModel):
    notes: Optional[str] = None
    device_type: Optional[Literal["workstation", "server", "printer", "ap", "mobile", "unknown"]] = None


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
    warning_ports: int,
    error_ports: int,
    collector_online: bool,
    has_data: bool,
) -> int:
    """
    Weighted health score (0-100):
      WAN component       (40%) — based on packet loss %
      Ports component     (40%) — deductions per warning/error port
      Collector component (20%) — 100 if heartbeat fresh, 0 if offline
    """
    if not has_data:
        return 0

    # WAN (40%)
    if wan_loss < 1.0:
        wan_score = 100
    elif wan_loss < 5.0:
        wan_score = 70
    elif wan_loss < 10.0:
        wan_score = 40
    else:
        wan_score = 0

    # Ports (40%) — warning ports cost 10 pts, error ports cost 20 pts
    ports_score = max(0, 100 - warning_ports * 10 - error_ports * 20)

    # Collector (20%)
    collector_score = 100 if collector_online else 0

    return round(wan_score * 0.4 + ports_score * 0.4 + collector_score * 0.2)


def _compute_hypothesis(
    port_rx_errors: int,
    port_tx_errors: int,
    error_rate_pct: float,
    error_timeline: str,
    peer_comparison: str,
    port_rx_dropped: int,
    port_rx_frags: int,
    gateway_loss: float,
    wan_loss: float,
    has_wired_port: bool,
    has_collab_traffic: bool,
) -> Hypothesis:
    """
    Compute a diagnosis hypothesis.

    The cable/NIC rules now use error_rate_pct (thresholds: 0.001% low, 0.1% medium/high)
    and adjust confidence based on timeline profile (sustained vs spike) and peer
    comparison (is this port anomalous vs other ports on the same switch?).
    """

    # ── Helper: build error evidence bullets ──────────────────────────────────
    def _error_evidence() -> list[str]:
        ev: list[str] = []
        ev.append(f"RX error rate: {error_rate_pct:.4f}% ({port_rx_errors:,} errors)")
        if port_rx_dropped > 0:
            ev.append(f"RX dropped frames: {port_rx_dropped:,}")
        if port_rx_frags > 0:
            ev.append(f"RX fragmented frames: {port_rx_frags:,}")
        if error_timeline == "sustained":
            ev.append("Timeline: errors present in 6+ of the last 12 windows (sustained issue)")
        elif error_timeline == "single_spike":
            ev.append("Timeline: errors concentrated in 1-2 windows (single spike, lower reliability)")
        if peer_comparison == "highly_elevated":
            ev.append("Peer comparison: error rate is >10x higher than other ports on this switch")
        elif peer_comparison == "elevated":
            ev.append("Peer comparison: error rate is 2-10x higher than other ports on this switch")
        elif peer_comparison == "normal":
            ev.append("Peer comparison: error rate is similar to other ports on this switch")
        return ev

    # ── Helper: adjust confidence for cable/NIC ───────────────────────────────
    def _cable_confidence(base: str) -> str:
        """Upgrade or downgrade based on timeline and peer comparison."""
        score = {"high": 2, "medium": 1, "low": 0}[base]

        # Timeline adjustments
        if error_timeline == "single_spike":
            score -= 1  # Spike: reduce confidence
        elif error_timeline == "sustained":
            score += 1  # Sustained: increase confidence

        # Peer adjustments
        if peer_comparison == "highly_elevated":
            score += 1
        elif peer_comparison == "normal":
            score -= 1  # Not anomalous vs peers → less certain

        score = max(0, min(2, score))
        return ["low", "medium", "high"][score]

    # ── Cable/NIC rules (now error-rate based) ────────────────────────────────

    # Rule 1: meaningful error rate AND gateway loss → cable/NIC
    if error_rate_pct > 0.001 and gateway_loss > 2.0:
        base = "high" if error_rate_pct > 0.1 else "medium"
        conf = _cable_confidence(base)
        return Hypothesis(
            likely_cause="cable_or_nic",
            confidence=conf,
            evidence=_error_evidence() + [f"Gateway packet loss: {gateway_loss:.1f}%"],
            recommended_action=(
                "Check physical cable connection and NIC driver. "
                "Replace cable if errors persist after re-seat."
            ),
        )

    # Rule 2: error rate but gateway healthy → local cable/NIC
    if error_rate_pct > 0.001 and gateway_loss < 1.0:
        base = "medium" if error_rate_pct > 0.1 else "low"
        conf = _cable_confidence(base)
        return Hypothesis(
            likely_cause="cable_or_nic",
            confidence=conf,
            evidence=_error_evidence() + [f"Gateway reachable (loss: {gateway_loss:.1f}%)"],
            recommended_action=(
                "Inspect cable and NIC. Gateway is reachable so this is "
                "likely a local layer-1 fault on this specific port."
            ),
        )

    # Rule 3a: both gateway and WAN have equal packet loss → infrastructure-wide, not device-specific
    if gateway_loss > 0.0 and wan_loss > 0.0 and abs(gateway_loss - wan_loss) <= 5.0:
        return Hypothesis(
            likely_cause="wan_instability",
            confidence="high",
            evidence=[
                f"Gateway loss: {gateway_loss:.1f}%  ·  WAN loss: {wan_loss:.1f}%",
                "Matching loss on both gateway and WAN targets indicates infrastructure-wide instability.",
            ],
            recommended_action=(
                "No device-specific action required. "
                "WAN instability is affecting the whole network — monitor for a global incident."
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
            and error_rate_pct < 0.001 and has_collab_traffic):
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
            and error_rate_pct < 0.001 and port_tx_errors == 0):
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
        evidence=["Insufficient data to determine cause"],
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
    global _overview_cache
    _now = _time.monotonic()
    if _overview_cache is not None and _now - _overview_cache[1] < _RESPONSE_CACHE_TTL:
        return _overview_cache[0]

    # ── WAN + gateway latency in one query (single table scan) ───────────────
    lat_rows = await _exec(db, """
        SELECT
            AVG(CASE WHEN target_type IN ('wan', 'dns') THEN rtt_ms          END) AS wan_rtt,
            AVG(CASE WHEN target_type IN ('wan', 'dns') THEN packet_loss_pct  END) AS wan_loss,
            AVG(CASE WHEN target_type = 'gateway'       THEN packet_loss_pct  END) AS gw_loss
        FROM latency_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
          AND target_type IN ('wan', 'dns', 'gateway')
    """)
    wan_rtt      = float(lat_rows[0]["wan_rtt"]  or 0) if lat_rows else 0.0
    wan_loss     = float(lat_rows[0]["wan_loss"] or 0) if lat_rows else 0.0
    gateway_loss = float(lat_rows[0]["gw_loss"]  or 0) if lat_rows else 0.0

    # ── Active devices ────────────────────────────────────────────────────────
    active_devices = await _scalar(db,
        "SELECT COUNT(*) FROM device_registry WHERE is_online = true")

    # ── Ports with errors in last 5 min — single scan, two conditional counts ──
    port_count_rows = await _exec(db, """
        SELECT
            COUNT(DISTINCT CASE WHEN (rx_errors_delta BETWEEN 1 AND 100 OR tx_errors_delta BETWEEN 1 AND 100)
                                 AND NOT (rx_errors_delta > 100 OR tx_errors_delta > 100)
                                THEN port_id END) AS warning_ports,
            COUNT(DISTINCT CASE WHEN rx_errors_delta > 100 OR tx_errors_delta > 100
                                THEN port_id END) AS error_ports
        FROM switch_port_metrics
        WHERE time > NOW() - INTERVAL '5 minutes'
    """)
    warning_ports = int((port_count_rows[0] if port_count_rows else {}).get("warning_ports") or 0)
    error_ports   = int((port_count_rows[0] if port_count_rows else {}).get("error_ports")   or 0)

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

    # ── Bytes last hour ───────────────────────────────────────────────────────
    bytes_last_hour = await _scalar(db, """
        SELECT COALESCE(SUM(bytes), 0)
        FROM network_flows
        WHERE time > NOW() - INTERVAL '1 hour'
    """, default=0)

    # has_data is True when at least one wan/dns row exists in the window.
    # Use wan_loss (not wan_rtt) — rtt_ms is NULL when a host is unreachable,
    # so checking rtt would wrongly return 'unknown' during a WAN outage.
    has_data = bool(lat_rows and lat_rows[0]["wan_loss"] is not None)

    total_error_ports = warning_ports + error_ports

    # ── UniFi Cloud status (non-blocking — failure yields connected=False) ────
    unifi_cloud = await _fetch_unifi_cloud()

    result = NetworkOverview(
        wan=WanStatus(
            status="unknown" if not has_data else _wan_status(wan_loss, wan_rtt),
            latency_ms=round(wan_rtt, 2) if has_data and wan_rtt else None,
            packet_loss_pct=round(wan_loss, 2) if has_data else None,
        ),
        internal=InternalStatus(
            status=_internal_status(total_error_ports, int(active_devices)),
            active_devices=int(active_devices),
            error_ports=total_error_ports,
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
            warning_ports=warning_ports,
            error_ports=error_ports,
            collector_online=collector_online,
            has_data=has_data,
        ),
        unifi_cloud=unifi_cloud,
    )
    _overview_cache = (result, _time.monotonic())
    return result


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

    cache_key = f"{period}:{limit}"
    _now = _time.monotonic()
    if cache_key in _top_devices_cache:
        cached, ts = _top_devices_cache[cache_key]
        if _now - ts < _RESPONSE_CACHE_TTL:
            return cached

    lookback = _PERIOD_CONFIG[period][0]
    rows = await _exec(db, f"""
        WITH port_deltas AS (
            SELECT
                device_ip,
                switch_id,
                port_id,
                COALESCE(SUM(rx_bytes_delta), 0) AS delta_rx,
                COALESCE(SUM(tx_bytes_delta), 0) AS delta_tx
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

    result = [
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
    _top_devices_cache[cache_key] = (result, _time.monotonic())
    return result


@router.get("/latency", response_model=LatencyResponse)
async def get_latency(
    period: Literal["15m", "1h", "6h", "24h", "7d"] = Query("1h"),
    targets: str = Query("all"),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns aggregated latency time series bucketed by date_trunc.
    Pivots per-target rows into a single wide series for easy charting.

    targets=all  — all targets
    targets=gateway,8.8.8.8  — comma-separated filter
    """
    if not _IS_POSTGRES:
        return LatencyResponse(targets=[], series=[])

    lookback, _ = _PERIOD_CONFIG[period]

    target_filter_sql = ""
    params: dict = {}
    if targets.lower() != "all":
        names = [t.strip() for t in targets.split(",") if t.strip()]
        if names:
            target_filter_sql = "AND target_name = ANY(:target_names)"
            params["target_names"] = names

    # TimescaleDB is not installed; use date_trunc() for bucketing.
    trunc_unit = _PERIOD_DATE_TRUNC[period]
    sql = f"""
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
    rows = await _exec(db, sql, params)
    logger.info("latency query period=%s trunc=%s returned %d rows", period, trunc_unit, len(rows))

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

    cache_key = f"{switch_id}:{status}"
    _now = _time.monotonic()
    _cached = _ports_cache.get(cache_key)
    if _cached and (_now - _cached[1]) < _PORTS_CACHE_TTL:
        return _cached[0]

    switch_filter = "AND switch_id = :switch_id" if switch_id else ""
    params = {"switch_id": switch_id} if switch_id else {}

    rows = await _exec(db, f"""
        WITH ranked AS (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY switch_id, port_id ORDER BY time DESC) AS rn,
                LAG(time) OVER (PARTITION BY switch_id, port_id ORDER BY time) AS prev_time
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
                SUM(rx_errors_delta)                                                    AS rx_errors_1h,
                SUM(tx_errors_delta)                                                    AS tx_errors_1h,
                MAX(CASE WHEN rx_errors_delta > 0 OR tx_errors_delta > 0 THEN time END) AS last_error_time
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '1 hour'
              {switch_filter}
            GROUP BY switch_id, port_id
        )
        SELECT
            l.switch_id, l.switch_name, l.port_id, l.port_name,
            l.device_name, l.device_ip::text, l.is_uplink,
            CASE
                WHEN l.prev_time IS NOT NULL
                     AND EXTRACT(EPOCH FROM (l.time - l.prev_time)) > 0
                THEN l.rx_bytes_delta::float
                     / EXTRACT(EPOCH FROM (l.time - l.prev_time))
                ELSE 0
            END AS rx_bytes_rate,
            CASE
                WHEN l.prev_time IS NOT NULL
                     AND EXTRACT(EPOCH FROM (l.time - l.prev_time)) > 0
                THEN l.tx_bytes_delta::float
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
               SUM(rx_errors_delta)     AS rx_errors,
               SUM(tx_errors_delta)     AS tx_errors
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
                   WHEN elapsed > 0
                   THEN rx_bytes_delta::float / elapsed
               END AS rx_bytes_rate,
               CASE
                   WHEN elapsed > 0
                   THEN tx_bytes_delta::float / elapsed
               END AS tx_bytes_rate
        FROM (
            SELECT switch_id, port_id, time,
                   rx_bytes_delta, tx_bytes_delta,
                   EXTRACT(EPOCH FROM (
                       time - LAG(time) OVER (PARTITION BY switch_id, port_id ORDER BY time)
                   )) AS elapsed
            FROM switch_port_metrics
            WHERE time > NOW() - INTERVAL '1 hour'
              {switch_filter}
        ) sub
        WHERE elapsed IS NOT NULL
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

    _ports_cache[cache_key] = (result, _time.monotonic())
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
    switch_name is resolved from a 300-second in-memory cache of the
    DISTINCT ON (switch_id) subquery, avoiding a full switch_port_metrics
    scan on every request."""
    global _switch_names, _switch_names_ts

    now = _time.monotonic()
    if not _switch_names or (now - _switch_names_ts) >= _SWITCH_NAMES_TTL:
        name_rows = await _exec(db, """
            SELECT DISTINCT ON (switch_id) switch_id, switch_name
            FROM switch_port_metrics
            ORDER BY switch_id, time DESC
        """)
        _switch_names = {r["switch_id"]: r.get("switch_name") for r in name_rows}
        _switch_names_ts = now

    rows = await _exec(db, """
        SELECT
            d.ip::text AS ip, d.mac, d.hostname, d.switch_id,
            d.port_id, d.last_seen, d.first_seen, d.is_online,
            d.device_type, d.notes, d.is_wired,
            d.ninja_id, d.os_name, d.last_logged_in_user,
            d.serial, d.ninja_online, d.disk_free_pct
        FROM device_registry d
        WHERE NOT (d.ip::text LIKE '169.254.%')
        ORDER BY d.last_seen DESC NULLS LAST
    """)
    return [
        DeviceRow(**{**r, "switch_name": _switch_names.get(r["switch_id"])})
        for r in rows
    ]


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
        "last_seen, first_seen, is_online, device_type, notes, "
        "ninja_id, os_name, last_logged_in_user, serial, ninja_online, "
        "disk_free_pct, last_reboot "
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

    # Port errors last 24h — bucketed by hour
    port_errors_24h = await _exec(db, """
        SELECT date_trunc('hour', time) AS bucket,
               SUM(rx_errors_delta) AS rx_errors,
               SUM(tx_errors_delta) AS tx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time > NOW() - INTERVAL '24 hours'
        GROUP BY bucket ORDER BY bucket ASC
    """, {"ip": ip})

    # Gateway latency last 24h (shows LAN-segment health for any device).
    # The collector pings the LAN gateway (pfSense) and stores it as
    # target_type='internal', so we match by IP, not type.
    from backend.config import settings as _settings
    _gw_ip = _settings.LAN_GATEWAY_IP or "10.2.1.253"
    latency_24h = await _exec(db, """
        SELECT date_trunc('minute', time) + (EXTRACT(minute FROM time)::int / 15) * INTERVAL '15 minutes' AS bucket,
               AVG(rtt_ms) AS avg_rtt,
               AVG(packet_loss_pct) AS avg_loss
        FROM latency_metrics
        WHERE target_ip::text = :gw_ip
          AND time > NOW() - INTERVAL '24 hours'
        GROUP BY bucket ORDER BY bucket ASC
    """, {"gw_ip": _gw_ip})

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
        ninja_id=dev.get("ninja_id"),
        os_name=dev.get("os_name"),
        last_logged_in_user=dev.get("last_logged_in_user"),
        serial=dev.get("serial"),
        ninja_online=dev.get("ninja_online"),
        disk_free_pct=dev.get("disk_free_pct"),
        last_reboot=dev.get("last_reboot"),
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
                top_destinations=[], raw_port_metrics=[],
            ),
            hypothesis=Hypothesis(
                likely_cause="unknown", confidence="low",
                evidence=["Network tables not available (SQLite dev mode)"],
                recommended_action="Run against a PostgreSQL/Supabase database.",
            ),
            global_incidents=[],
            device_incidents=[],
        )

    params = {"ip": ip, "start": start, "end": end}

    # Device info
    dev_rows = await _exec(db,
        "SELECT ip::text AS ip, mac, hostname, switch_id, port_id, "
        "last_seen, is_online, device_type, notes "
        "FROM device_registry WHERE ip::text = :ip", {"ip": ip})
    device = dev_rows[0] if dev_rows else None

    # Port error totals + breakdown in window
    port_err_rows = await _exec(db, """
        SELECT COALESCE(SUM(rx_errors_delta), 0) AS rx_errors,
               COALESCE(SUM(tx_errors_delta), 0) AS tx_errors,
               COALESCE(SUM(rx_dropped),      0) AS rx_dropped,
               COALESCE(SUM(tx_dropped),      0) AS tx_dropped,
               COALESCE(SUM(rx_frags),        0) AS rx_frags,
               COALESCE(SUM(rx_bytes_delta),  0) AS rx_bytes,
               COALESCE(SUM(tx_bytes_delta),  0) AS tx_bytes
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time BETWEEN :start AND :end
    """, params)
    port_rx_errors = int((port_err_rows[0] or {}).get("rx_errors") or 0)
    port_tx_errors = int((port_err_rows[0] or {}).get("tx_errors") or 0)
    port_rx_dropped = int((port_err_rows[0] or {}).get("rx_dropped") or 0)
    port_tx_dropped = int((port_err_rows[0] or {}).get("tx_dropped") or 0)
    port_rx_frags   = int((port_err_rows[0] or {}).get("rx_frags")   or 0)
    port_rx_bytes   = int((port_err_rows[0] or {}).get("rx_bytes")   or 0)
    port_tx_bytes   = int((port_err_rows[0] or {}).get("tx_bytes")   or 0)
    has_wired_port  = bool(port_err_rows and port_err_rows[0].get("rx_errors") is not None)

    # Error rate calculation
    if port_rx_bytes > 0:
        error_rate_pct = (port_rx_errors / port_rx_bytes) * 100.0
    else:
        error_rate_pct = 0.0

    # Error timeline profile — last 12 five-minute windows
    timeline_rows = await _exec(db, """
        SELECT
            date_trunc('hour', time)
              + (EXTRACT(MINUTE FROM time)::int / 5) * INTERVAL '5 minutes' AS bucket,
            SUM(rx_errors_delta) AS rx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time > NOW() - INTERVAL '60 minutes'
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT 12
    """, {"ip": ip})
    windows_with_errors = sum(1 for r in timeline_rows if int(r.get("rx_errors") or 0) > 0)
    total_windows = len(timeline_rows)

    if total_windows == 0:
        error_timeline = "normal"
    elif windows_with_errors >= 6:
        error_timeline = "sustained"
    elif windows_with_errors <= 2 and windows_with_errors > 0:
        error_timeline = "single_spike"
    else:
        error_timeline = "normal"

    # Peer comparison — compare this port's error rate to others on same switch
    peer_avg_error_rate: Optional[float] = None
    peer_comparison_result = "no_peer_data"

    if device and device.get("switch_id"):
        switch_id_val = device["switch_id"]
        port_id_val   = device.get("port_id")
        peer_rows = await _exec(db, """
            SELECT
                port_id,
                CASE
                    WHEN SUM(rx_bytes_delta) > 0
                    THEN (SUM(rx_errors_delta)::float / SUM(rx_bytes_delta)) * 100
                    ELSE 0
                END AS port_error_rate
            FROM switch_port_metrics
            WHERE switch_id = :switch_id
              AND time BETWEEN :start AND :end
              AND (rx_bytes_delta IS NOT NULL OR rx_errors_delta IS NOT NULL)
            GROUP BY port_id
        """, {"switch_id": switch_id_val, "start": start, "end": end})

        peer_rates = [
            float(r["port_error_rate"])
            for r in peer_rows
            if r.get("port_id") != port_id_val
        ]
        if peer_rates:
            peer_avg_error_rate = sum(peer_rates) / len(peer_rates)
            if error_rate_pct > 0 and peer_avg_error_rate > 0:
                ratio = error_rate_pct / peer_avg_error_rate
                if ratio > 10:
                    peer_comparison_result = "highly_elevated"
                elif ratio > 2:
                    peer_comparison_result = "elevated"
                else:
                    peer_comparison_result = "normal"
            elif error_rate_pct > 0 and peer_avg_error_rate == 0:
                peer_comparison_result = "highly_elevated"
            else:
                peer_comparison_result = "normal"
        elif peer_rows:
            # Only this port has data → no comparison possible
            peer_comparison_result = "no_peer_data"

    # Raw port metrics — last 20 rows for this device
    raw_metrics_rows = await _exec(db, """
        SELECT
            time,
            rx_errors_delta  AS rx_errors,
            rx_dropped,
            rx_frags,
            rx_bytes_delta   AS rx_bytes,
            tx_bytes_delta   AS tx_bytes,
            CASE
                WHEN rx_bytes_delta > 0
                THEN ROUND((rx_errors_delta::numeric / rx_bytes_delta * 100)::numeric, 6)
                ELSE 0
            END AS error_rate_pct
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
        ORDER BY time DESC
        LIMIT 20
    """, {"ip": ip})
    raw_port_metrics = [
        {
            "timestamp":    r["time"].isoformat() if isinstance(r["time"], datetime) else str(r["time"]),
            "rx_errors":    int(r.get("rx_errors")   or 0),
            "rx_dropped":   int(r.get("rx_dropped")  or 0),
            "rx_frags":     int(r.get("rx_frags")    or 0),
            "rx_bytes":     int(r.get("rx_bytes")    or 0),
            "tx_bytes":     int(r.get("tx_bytes")    or 0),
            "error_rate_pct": float(r.get("error_rate_pct") or 0),
        }
        for r in raw_metrics_rows
    ]

    # Gateway latency in window — match by IP only.
    # The collector stores the LAN gateway (10.2.1.253) with target_type='internal',
    # NOT 'gateway', so filtering by target_type would miss all rows.
    from backend.config import settings as _settings
    _gw_ip = _settings.LAN_GATEWAY_IP or "10.2.1.253"
    logger.info("investigate gateway latency: gw_ip=%s start=%s end=%s", _gw_ip, start, end)
    gw_rows = await _exec(db, """
        SELECT AVG(packet_loss_pct) AS avg_loss,
               AVG(rtt_ms)          AS avg_rtt
        FROM latency_metrics
        WHERE target_ip::text = :gw_ip
          AND time BETWEEN :start AND :end
    """, {**params, "gw_ip": _gw_ip})
    logger.info("investigate gateway latency: returned %d rows, avg_loss=%s avg_rtt=%s",
                len(gw_rows), (gw_rows[0] or {}).get("avg_loss"), (gw_rows[0] or {}).get("avg_rtt"))
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

    # Bytes sent/received from switch_port_metrics delta columns (authoritative)
    # port_tx_bytes_delta = bytes leaving the device; port_rx_bytes_delta = bytes arriving
    bytes_sent     = port_tx_bytes
    bytes_received = port_rx_bytes

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

    # ── Global incidents active during window (4B, 4D) ───────────────────────
    global_inc_rows = await _exec(db, """
        SELECT id::text AS id, started_at, resolved_at, severity, title,
               root_cause, affected_component
        FROM network_incidents
        WHERE incident_scope = 'global'
          AND started_at <= :end
          AND (resolved_at IS NULL OR resolved_at >= :start)
        ORDER BY started_at DESC
    """, params)

    # ── Device-scoped incidents, last 20 (4D) ────────────────────────────────
    device_inc_rows = await _exec(db, """
        SELECT id::text AS id, started_at, resolved_at, severity, category,
               title, root_cause, resolution_notes
        FROM network_incidents
        WHERE incident_scope = 'device'
          AND affected_ip::text = :ip
        ORDER BY started_at DESC
        LIMIT 20
    """, {"ip": ip})

    # ── Timeline ──────────────────────────────────────────────────────────────

    timeline: list[TimelineEvent] = []

    # Port error events (bucket by 5 min)
    port_events = await _exec(db, """
        SELECT date_trunc('minute', time) + (EXTRACT(minute FROM time)::int / 5) * INTERVAL '5 minutes' AS bucket,
               SUM(rx_errors_delta) AS rx_errors,
               SUM(tx_errors_delta) AS tx_errors
        FROM switch_port_metrics
        WHERE device_ip::text = :ip
          AND time BETWEEN :start AND :end
          AND (rx_errors_delta > 0 OR tx_errors_delta > 0)
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
        SELECT date_trunc('minute', time) + (EXTRACT(minute FROM time)::int / 5) * INTERVAL '5 minutes' AS bucket,
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

    # network_events for this device (4E)
    _EVT_SEV: dict[str, str] = {
        "port_error":        "warning",
        "device_offline":    "critical",
        "device_online":     "ok",
        "latency_spike":     "warning",
        "incident_created":  "critical",
        "incident_resolved": "info",
    }
    ne_rows = await _exec(db, """
        SELECT occurred_at, event_type, description
        FROM network_events
        WHERE (device_ip::text = :ip OR target_ip::text = :ip)
          AND occurred_at BETWEEN :start AND :end
        ORDER BY occurred_at ASC
    """, params)
    seen_ne: set[tuple] = set()
    for e in ne_rows:
        evt_type = e.get("event_type", "unknown")
        key = (str(e["occurred_at"]), evt_type)
        if key in seen_ne:
            continue
        seen_ne.add(key)
        timeline.append(TimelineEvent(
            time=e["occurred_at"],
            event_type=evt_type,
            severity=_EVT_SEV.get(evt_type, "info"),
            description=e.get("description") or evt_type.replace("_", " ").title(),
        ))

    # Global incident start events that fall within the window
    for ginc in global_inc_rows:
        ginc_start = ginc["started_at"]
        if start <= ginc_start <= end:
            timeline.append(TimelineEvent(
                time=ginc_start,
                event_type="incident",
                severity=ginc.get("severity", "critical"),
                description=f"Global outage: {ginc.get('title', 'Network incident')}",
            ))

    # Device-scoped incident start events within the window
    for dinc in device_inc_rows:
        dinc_start = dinc["started_at"]
        if start <= dinc_start <= end:
            timeline.append(TimelineEvent(
                time=dinc_start,
                event_type="incident",
                severity=dinc.get("severity", "warning"),
                description=dinc.get("title", "Device incident"),
            ))

    timeline.sort(key=lambda x: x.time)

    # ── Serialise ─────────────────────────────────────────────────────────────

    def _fmt_row(r: dict) -> dict:
        return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in r.items()}

    if device:
        device = _fmt_row(device)

    global_incidents = [_fmt_row(r) for r in global_inc_rows]
    device_incidents = [_fmt_row(r) for r in device_inc_rows]

    top_dest_fmt = [
        {
            "dst_ip":        r.get("dst_ip"),
            "protocol_name": _protocol_name(r.get("dst_port"), r.get("protocol")),
            "bytes":         int(r.get("bytes") or 0),
            "packets":       int(r.get("packets") or 0),
        }
        for r in top_dest
    ]

    hypothesis = _compute_hypothesis(
        port_rx_errors=port_rx_errors,
        port_tx_errors=port_tx_errors,
        error_rate_pct=error_rate_pct,
        error_timeline=error_timeline,
        peer_comparison=peer_comparison_result,
        port_rx_dropped=port_rx_dropped,
        port_rx_frags=port_rx_frags,
        gateway_loss=gateway_loss,
        wan_loss=wan_loss,
        has_wired_port=has_wired_port,
        has_collab_traffic=has_collab,
    )

    # If the device's WAN diagnosis coincides with an active global incident,
    # the connectivity issue is infrastructure-wide — not device-specific.
    # Override likely_cause so the frontend can render the correct message
    # without needing to re-implement this logic client-side.
    if hypothesis.likely_cause == "wan_issue" and global_inc_rows:
        active = global_inc_rows[0]
        hypothesis = Hypothesis(
            likely_cause="global_wan_incident",
            confidence="high",
            evidence=[
                "WAN/ISP packet loss detected during this window.",
                f"Active global incident: {active.get('title', 'WAN outage')} "
                f"(started {active.get('started_at', 'unknown')})",
                "The connectivity issue is network-wide — not caused by this device.",
            ],
            recommended_action=(
                "No device-specific action required. "
                "Monitor the global incident for resolution."
            ),
        )

    return InvestigateResponse(
        device=device,
        timeline=timeline,
        metrics=InvestigateMetrics(
            port_rx_errors=port_rx_errors,
            port_tx_errors=port_tx_errors,
            port_rx_dropped=port_rx_dropped,
            port_tx_dropped=port_tx_dropped,
            port_rx_frags=port_rx_frags,
            error_rate_pct=round(error_rate_pct, 6),
            error_timeline_profile=error_timeline,
            error_windows_with_errors=windows_with_errors,
            peer_avg_error_rate=round(peer_avg_error_rate, 6) if peer_avg_error_rate is not None else None,
            peer_comparison_result=peer_comparison_result,
            avg_packet_loss_gateway_pct=round(gateway_loss, 2),
            avg_packet_loss_wan_pct=round(wan_loss, 2),
            avg_rtt_gateway_ms=round(float(gateway_rtt), 2) if gateway_rtt is not None else None,
            bytes_sent=bytes_sent,
            bytes_received=bytes_received,
            top_destinations=top_dest_fmt,
            raw_port_metrics=raw_port_metrics,
        ),
        hypothesis=hypothesis,
        global_incidents=global_incidents,
        device_incidents=device_incidents,
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
        f"title, description, evidence, root_cause, resolution_notes, auto_detected, "
        f"COALESCE(incident_scope, 'device') AS incident_scope, affected_component "
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
            incident_scope=r.get("incident_scope") or "device",
            affected_component=r.get("affected_component"),
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
        "title, description, evidence, root_cause, resolution_notes, auto_detected, "
        "COALESCE(incident_scope, 'device') AS incident_scope, affected_component "
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
        incident_scope=r.get("incident_scope") or "device",
        affected_component=r.get("affected_component"),
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
