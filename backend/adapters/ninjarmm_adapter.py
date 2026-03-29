from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

SEVERITY_MAP: dict[str, str] = {
    "DEVICE_OFFLINE": "critical", "DEVICE_UNRESPONSIVE": "critical", "DISK_FAILURE": "critical", "RAID_FAILURE": "critical", "BACKUP_FAILURE": "critical",
    "DISK_USAGE_HIGH": "warning", "CPU_USAGE_HIGH": "warning", "RAM_USAGE_HIGH": "warning", "ANTIVIRUS_ISSUE": "warning", "WINDOWS_UPDATE_FAILURE": "warning", "SERVICE_STOPPED": "warning", "PATCH_FAILURE": "warning", "NETWORK_ISSUE": "warning",
    "SCRIPT_FAILURE": "info", "PATCH_SUCCESS": "info", "SOFTWARE_INSTALLED": "info", "DEVICE_REBOOTED": "info", "DEVICE_ONLINE": "ok",
}

RESOLUTION_EVENTS = {"DEVICE_ONLINE"}


class NinjaRMMAdapter(BaseAdapter):
    source_slug = "ninjarmm"

    def parse(self, raw_payload: dict) -> RawAlert:
        event_type = raw_payload.get("eventType", "UNKNOWN")
        device_name = raw_payload.get("deviceName", "Unknown Device")
        org_name = raw_payload.get("organizationName", "")
        severity = SEVERITY_MAP.get(event_type, "info")
        details = raw_payload.get("details", {})
        prefix = f"[{org_name}] " if org_name else ""
        title = f"{prefix}{device_name} \u2014 {event_type.replace('_', ' ').title()}"
        message = details.get("message") or details.get("description") or f"NinjaRMM event: {event_type} on {device_name}"
        return RawAlert(source_slug=self.source_slug, event_type=event_type.lower(), title=title, message=str(message)[:400], severity=severity, fingerprint_key=f"{device_name}:{event_type}", raw_payload=raw_payload)
