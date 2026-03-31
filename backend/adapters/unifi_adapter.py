"""
UniFi Network Controller adapter.

Parses device-state changes, events, and alarms polled from the UniFi
Controller REST API into normalised RawAlert objects.

This adapter is driven by the UniFiSourcePoller in backend/unifi_poller.py
rather than a webhook endpoint — it is never called directly from ingest.py.
"""

from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

# UniFi event key → (severity, human-readable label)
EVENT_MAP: dict[str, tuple[str, str]] = {
    # ── Access Points ──────────────────────────────────────────────────────────
    "EVT_AP_Disconnected":        ("critical", "AP Disconnected"),
    "EVT_AP_Connected":           ("ok",       "AP Connected"),
    "EVT_AP_Restarted":           ("warning",  "AP Restarted"),
    "EVT_AP_RestartedUnknown":    ("warning",  "AP Restarted (Unknown Reason)"),
    "EVT_AP_LostContact":         ("critical", "AP Lost Contact"),
    "EVT_AP_Adopted":             ("info",     "AP Adopted"),
    "EVT_AP_Upgraded":            ("info",     "AP Firmware Upgraded"),
    "EVT_AP_UpgradeFailed":       ("warning",  "AP Firmware Upgrade Failed"),
    "EVT_AP_AutoUpdated":         ("info",     "AP Auto-Updated"),
    "EVT_AP_ChannelChanged":      ("info",     "AP Channel Changed"),
    # ── Switches ───────────────────────────────────────────────────────────────
    "EVT_SW_Disconnected":        ("critical", "Switch Disconnected"),
    "EVT_SW_Connected":           ("ok",       "Switch Connected"),
    "EVT_SW_Restarted":           ("warning",  "Switch Restarted"),
    "EVT_SW_LostContact":         ("critical", "Switch Lost Contact"),
    "EVT_SW_Upgraded":            ("info",     "Switch Firmware Upgraded"),
    "EVT_SW_UpgradeFailed":       ("warning",  "Switch Firmware Upgrade Failed"),
    "EVT_SW_PoeOverload":         ("warning",  "Switch PoE Overload"),
    "EVT_SW_PoePowerCycle":       ("info",     "Switch PoE Power Cycle"),
    # ── Gateways / Routers ─────────────────────────────────────────────────────
    "EVT_GW_Disconnected":        ("critical", "Gateway Disconnected"),
    "EVT_GW_Connected":           ("ok",       "Gateway Connected"),
    "EVT_GW_Restarted":           ("warning",  "Gateway Restarted"),
    "EVT_GW_WANTransition":       ("warning",  "WAN State Changed"),
    "EVT_GW_WANFailover":         ("critical", "WAN Failover Triggered"),
    "EVT_GW_WANFailoverRecovery": ("info",     "WAN Failover Recovered"),
    "EVT_GW_SpeedTestFinished":   ("info",     "Speed Test Finished"),
    "EVT_GW_Upgraded":            ("info",     "Gateway Firmware Upgraded"),
    "EVT_GW_UpgradeFailed":       ("warning",  "Gateway Firmware Upgrade Failed"),
    # ── IDS / IPS ──────────────────────────────────────────────────────────────
    "EVT_IDS_IpsAlert":           ("critical", "IDS/IPS Alert"),
    "EVT_IDS_IpsAlertEmail":      ("warning",  "IDS/IPS Alert (Email)"),
    # ── Wireless Clients ───────────────────────────────────────────────────────
    "EVT_WU_Connected":           ("info",     "Wireless Client Connected"),
    "EVT_WU_Disconnected":        ("info",     "Wireless Client Disconnected"),
    "EVT_WU_Blocked":             ("warning",  "Wireless Client Blocked"),
    "EVT_WU_Roam":                ("info",     "Wireless Client Roamed"),
    # ── Wired Clients ──────────────────────────────────────────────────────────
    "EVT_LU_Connected":           ("info",     "Wired Client Connected"),
    "EVT_LU_Disconnected":        ("info",     "Wired Client Disconnected"),
    # ── Rogue Detection ────────────────────────────────────────────────────────
    "EVT_ND_RogueAPDetected":     ("warning",  "Rogue AP Detected"),
    "EVT_ND_RogueAPReconciled":   ("info",     "Rogue AP Reconciled"),
    # ── Remote Access / VPN ────────────────────────────────────────────────────
    "EVT_RC_Connected":           ("info",     "Remote Access Connected"),
    "EVT_RC_Disconnected":        ("info",     "Remote Access Disconnected"),
    "EVT_VPN_Connected":          ("info",     "VPN Connected"),
    "EVT_VPN_Disconnected":       ("info",     "VPN Disconnected"),
    # ── Admin ──────────────────────────────────────────────────────────────────
    "EVT_AD_LoginFailed":         ("warning",  "Admin Login Failed"),
    "EVT_AD_LoggedIn":            ("info",     "Admin Logged In"),
}

# Events that resolve existing device-offline alerts
RESOLUTION_EVENT_KEYS = {
    "EVT_AP_Connected",
    "EVT_SW_Connected",
    "EVT_GW_Connected",
}

# Friendly labels for device type codes
DEVICE_TYPE_LABELS: dict[str, str] = {
    "uap": "Access Point",
    "usw": "Switch",
    "ugw": "Gateway",
    "usg": "Security Gateway",
    "udm": "Dream Machine",
    "udmpro": "Dream Machine Pro",
    "uxg": "Express Gateway",
    "ubb": "Building Bridge",
    "ups": "Power Strip",
    "uph": "Phone",
}


class UniFiAdapter(BaseAdapter):
    """
    Parses UniFi events/alarms into RawAlert objects.

    Note: source_slug is overridden per-poller instance to support multiple
    controllers.  The class-level default is only a fallback.
    """
    source_slug = "unifi"

    def parse(self, raw_payload: dict) -> RawAlert:
        key     = raw_payload.get("key", "unifi_event")
        msg     = raw_payload.get("msg", "")
        device  = (
            raw_payload.get("device")
            or raw_payload.get("hostname")
            or raw_payload.get("ap")
            or raw_payload.get("sw")
            or raw_payload.get("gw")
            or "Unknown Device"
        )

        severity, label = EVENT_MAP.get(key, (
            "info",
            key.replace("EVT_", "").replace("_", " ").title(),
        ))

        title   = f"{device} — {label}"
        message = msg or title

        # Enrich message with available fields
        extras = []
        if raw_payload.get("network"):
            extras.append(f"Network: {raw_payload['network']}")
        if raw_payload.get("ssid"):
            extras.append(f"SSID: {raw_payload['ssid']}")
        if raw_payload.get("src_ip"):
            extras.append(f"Source IP: {raw_payload['src_ip']}")
        if raw_payload.get("dest_port"):
            extras.append(f"Dest Port: {raw_payload['dest_port']}")
        if raw_payload.get("proto"):
            extras.append(f"Protocol: {raw_payload['proto']}")
        if extras:
            message = f"{message} | {' | '.join(extras)}"

        return RawAlert(
            source_slug=self.source_slug,
            event_type=key.lower(),
            title=title,
            message=message[:400],
            severity=severity,
            fingerprint_key=f"{device}:{key}",
            raw_payload=raw_payload,
        )
