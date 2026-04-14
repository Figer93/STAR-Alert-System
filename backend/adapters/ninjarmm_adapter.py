"""
NinjaRMM webhook adapter.
Handles both Activity webhook events (DEVICE_OFFLINE etc.) and
Condition-based alerts (activityType=CONDITION, statusCode=TRIGGERED/RESET).
"""
from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

SEVERITY_MAP: dict[str, str] = {
    # Device activity events
    "DEVICE_OFFLINE":           "critical",
    "DEVICE_UNRESPONSIVE":      "critical",
    "DISK_FAILURE":             "critical",
    "RAID_FAILURE":             "critical",
    "BACKUP_FAILURE":           "critical",
    "DISK_USAGE_HIGH":          "warning",
    "CPU_USAGE_HIGH":           "warning",
    "RAM_USAGE_HIGH":           "warning",
    "ANTIVIRUS_ISSUE":          "warning",
    "ANTIVIRUS_OUTDATED":       "warning",
    "WINDOWS_UPDATE_FAILURE":   "warning",
    "SERVICE_STOPPED":          "warning",
    "PATCH_FAILURE":            "warning",
    "NETWORK_ISSUE":            "warning",
    "SCRIPT_FAILURE":           "info",
    "PATCH_SUCCESS":            "info",
    "SOFTWARE_INSTALLED":       "info",
    "SOFTWARE_UNINSTALLED":     "info",
    "DEVICE_ONLINE":            "ok",
    "DEVICE_REBOOTED":          "info",
    # Condition-based alerts (activityType=CONDITION + statusCode)
    "CONDITION_TRIGGERED":      "warning",
    "CONDITION_RESET":          "ok",
}

# Events that resolve existing alerts rather than creating new ones
RESOLUTION_EVENTS = {"DEVICE_ONLINE", "CONDITION_RESET"}

# Maps NinjaRMM condition codes to human-readable names
CONDITION_CODE_LABELS: dict[str, str] = {
    "agent_win_cond_cpu_ge":        "CPU Utilization",
    "agent_win_cond_ram_ge":        "RAM Utilization",
    "agent_win_cond_disk_ge":       "Disk Usage",
    "agent_win_cond_disk_io_ge":    "Disk I/O",
    "agent_win_cond_net_io_ge":     "Network I/O",
    "agent_win_cond_svc_stopped":   "Service Stopped",
    "agent_win_cond_process_ge":    "Process CPU/RAM",
}


class NinjaRMMAdapter(BaseAdapter):
    source_slug = "ninjarmm"

    def parse(self, raw_payload: dict, resolved_hostname: str | None = None) -> RawAlert:
        # Support both Activity webhook format (eventType) and
        # Condition webhook format (activityType + statusCode)
        activity_type = raw_payload.get("activityType") or raw_payload.get("eventType", "UNKNOWN")
        status_code   = raw_payload.get("statusCode", "")

        # Build effective event type
        if activity_type == "CONDITION" and status_code:
            event_type = f"CONDITION_{status_code.upper()}"
        else:
            event_type = activity_type

        # Device identification — use resolved hostname from device_registry if available
        device_id   = raw_payload.get("deviceId")
        device_name = resolved_hostname or raw_payload.get("deviceName") or (f"Device #{device_id}" if device_id else "Unknown Device")
        org_name    = raw_payload.get("organizationName", "")

        # Condition-specific fields
        data         = raw_payload.get("data") or {}
        msg_data     = data.get("message") or {}
        params       = msg_data.get("params") or {}
        cond_code    = msg_data.get("code", "")
        cond_label   = CONDITION_CODE_LABELS.get(cond_code, cond_code.replace("_", " ").title() if cond_code else "")

        # Severity
        severity = SEVERITY_MAP.get(event_type, "info")
        if activity_type == "CONDITION" and event_type not in SEVERITY_MAP:
            severity = "ok" if status_code.upper() == "RESET" else "warning"

        # Title — specific formats for known condition codes, fallback to generic
        prefix    = f"[{org_name}] " if org_name else ""
        threshold = params.get("threshold", "")
        if cond_code == "agent_win_cond_disk_free_le":
            volume   = params.get("volume", "")
            vol_part = f"{volume}, " if volume else ""
            thr_part = f"{threshold}% free" if threshold else "low free space"
            title = f"{prefix}{device_name} — Low disk space ({vol_part}{thr_part})"
        elif cond_code == "agent_win_cond_mem_ge":
            thr_part = f"≥{threshold}%" if threshold else "high usage"
            title = f"{prefix}{device_name} — High memory usage ({thr_part})"
        elif cond_code == "agent_win_cond_cpu_ge":
            thr_part = f"≥{threshold}%" if threshold else "high usage"
            title = f"{prefix}{device_name} — High CPU usage ({thr_part})"
        elif cond_label:
            unit  = params.get("unit", "")
            label = f"{cond_label} ≥ {threshold}{unit}" if threshold else cond_label
            title = f"{prefix}{device_name} — {label}"
        else:
            title = f"{prefix}{device_name} — {event_type.replace('_', ' ').title()}"

        # Message
        message = raw_payload.get("message") or f"NinjaRMM {event_type} on {device_name}"
        if params.get("top_processes"):
            message = message.split("\r\n")[0].split("\n")[0]  # trim process list from message; it's in params
            message += f"\nTop processes: {params['top_processes'][:200]}"

        # Fingerprint: use stable device_id for condition alerts; device_name for activity events
        if cond_code and device_id:
            fingerprint_key = f"{device_id}:{cond_code}"
        elif cond_code:
            fingerprint_key = f"{device_name}:{cond_code}"
        else:
            fingerprint_key = f"{device_name}:{event_type}"

        return RawAlert(
            source_slug=self.source_slug,
            event_type=event_type.lower(),
            title=title,
            message=str(message)[:400],
            severity=severity,
            fingerprint_key=fingerprint_key,
            raw_payload=raw_payload,
        )
