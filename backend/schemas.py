from datetime import datetime
from typing import Any, Optional, Literal
from pydantic import BaseModel, ConfigDict


# ── Source ────────────────────────────────────────────────────────────────────

class SourceBase(BaseModel):
    name: str
    slug: str
    adapter: str
    type: Literal["webhook", "syslog", "poll", "push"]
    enabled: bool = True
    config: dict = {}


class SourceRead(SourceBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    last_seen: Optional[datetime]
    status: Literal["online", "offline", "unknown"]
    created_at: datetime


class SourceUpdate(BaseModel):
    enabled: Optional[bool] = None
    config: Optional[dict] = None
    status: Optional[Literal["online", "offline", "unknown"]] = None


# ── Alert ─────────────────────────────────────────────────────────────────────

class AlertRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_id: Optional[int]
    severity: Literal["critical", "warning", "info", "ok"]
    title: str
    message: str
    raw_payload: dict
    fingerprint: str
    status: Literal["active", "acknowledged", "resolved"]
    first_seen: datetime
    last_seen: datetime
    occurrence_count: int
    notified_telegram: bool
    notified_email: bool
    acknowledged_by: Optional[str]
    acknowledged_at: Optional[datetime]
    resolved_at: Optional[datetime]
    source: Optional[SourceRead] = None


class AlertAcknowledge(BaseModel):
    acknowledged_by: str = "dashboard"


class AlertsListResponse(BaseModel):
    total: int
    alerts: list[AlertRead]


# ── Rule ──────────────────────────────────────────────────────────────────────

class RuleBase(BaseModel):
    name: str
    source_slug: Optional[str] = None
    condition: dict
    severity_override: Optional[Literal["critical", "warning", "info", "ok"]] = None
    action: str = "notify"
    notify_telegram: bool = True
    notify_email: bool = False
    cooldown_minutes: int = 15
    enabled: bool = True


class RuleUpdate(BaseModel):
    name: Optional[str] = None
    source_slug: Optional[str] = None
    condition: Optional[dict] = None
    severity_override: Optional[Literal["critical", "warning", "info", "ok"]] = None
    action: Optional[str] = None
    notify_telegram: Optional[bool] = None
    notify_email: Optional[bool] = None
    cooldown_minutes: Optional[int] = None
    enabled: Optional[bool] = None


class RuleRead(RuleBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


# ── Stats ─────────────────────────────────────────────────────────────────────

class StatsSummary(BaseModel):
    critical: int
    warning: int
    info: int
    ok: int
    total_active: int
    sources_online: int
    sources_total: int


class TimelineBucket(BaseModel):
    hour: str  # ISO datetime string
    count: int


class SourceStats(BaseModel):
    source_id: int
    source_name: str
    source_slug: str
    status: str
    last_seen: Optional[datetime]
    alert_count_total: int
    alert_count_active: int


# ── Ingest (RawAlert) ─────────────────────────────────────────────────────────

class RawAlert(BaseModel):
    source_slug: str
    event_type: str
    title: str
    message: str
    severity: Literal["critical", "warning", "info", "ok"] = "info"
    fingerprint_key: str = ""
    raw_payload: dict[str, Any] = {}


# ── WebSocket messages ────────────────────────────────────────────────────────

class WSMessage(BaseModel):
    event: str
    timestamp: datetime
    payload: dict[str, Any]


# ── Notification Channel Settings ─────────────────────────────────────────────

class NotificationChannelSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    channel: str
    enabled: bool
    send_resolutions: bool
    severity_filter: str
    message_template: str
    resolution_template: str
    field_toggles: dict
    parse_mode: str
    subject_template: str
    updated_at: datetime


class NotificationChannelSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    send_resolutions: Optional[bool] = None
    severity_filter: Optional[str] = None
    message_template: Optional[str] = None
    resolution_template: Optional[str] = None
    field_toggles: Optional[dict] = None
    parse_mode: Optional[str] = None
    subject_template: Optional[str] = None
