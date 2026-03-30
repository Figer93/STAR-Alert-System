"""
NinjaRMM webhook adapter — Phase 5.
Handles all inbound NinjaRMM event types and normalises them into RawAlerts.
"""
from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

SEVERITY_MAP: dict[str, str] = {
    # Critical
    "DEVICE_OFFLINE":           "critical",
    "DEVICE_UNRESPONSIVE":      "critical",
    "DISK_FAILURE":             "critical",
    "RAID_FAILURE":             "critical",
    "BACKUP_FAILURE":           "critical",
    # Warning
    "DISK_USAGE_HIGH":          "warning",
    "CPU_USAGE_HIGH":           "warning",
    "RAM_USAGE_HIGH":           "warning",
    "ANTIVIRUS_ISSUE":          "warning",
    "ANTIVIRUS_OUTDATED":       "warning",
    "WINDOWS_UPDATE_FAILURE":   "warning",
    "SERVICE_STOPPED":          "warning",
    "PATCH_FAILURE":            "warning",
    "NETWORK_ISSUE":            "warning",
    # Condition-based alerts (threshold triggers via Notification Channels)
    "CONDITION_TRIGGERED":      "warning",
    "CONDITION_RESET":          "ok",
    # Info
    "SCRIPT_FAILURE":           "info",
    "PATCH_SUCCESS":            "info",
    "SOFTWARE_INSTALLED":       "info",
    "SOFTWARE_UNINSTALLED":     "info",
    "DEVICE_ONLINE":            "ok",
    "DEVICE_REBOOTED":          "info",
}

# Events that indicate a device is back online — used by ingest router to resolve alerts
RESOLUTION_EVENTS = {"DEVICE_ONLINE", "CONDITION_RESET"}


class NinjaRMMAdapter(BaseAdapter):
    source_slug = "ninjarmm"

    def parse(self, raw_payload: dict) -> RawAlert:
        event_type  = raw_payload.get("eventType", "UNKNOWN")
        device_name = raw_payload.get("deviceName", "Unknown Device")
        org_name    = raw_payload.get("organizationName", "")
        severity    = SEVERITY_MAP.get(event_type, "info")
        details     = raw_payload.get("details", {})

        prefix = f"[{org_name}] " if org_name else ""
        label  = event_type.replace("_", " ").title()
        title  = f"{prefix}{device_name} — {label}"
        message = (
            details.get("message")
            or details.get("description")
            or f"NinjaRMM event: {event_type} on {device_name}"
        )

        # Enrich message with numeric thresholds when present
        if "value" in details and "threshold" in details:
            message += f" (value={details['value']}, threshold={details['threshold']})"

        return RawAlert(
            source_slug=self.source_slug,
            event_type=event_type.lower(),
            title=title,
            message=str(message)[:400],
            severity=severity,
            fingerprint_key=f"{device_name}:{event_type}",
            raw_payload=raw_payload,
        )
