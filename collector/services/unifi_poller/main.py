"""
unifi_poller — polls UniFi Controller every 60 seconds for switch port stats
and connected client inventory, then writes to Supabase.

Switch port stats  → switch_port_metrics table (insert)
Connected clients  → device_registry table (upsert on mac)

Environment variables:
  SUPABASE_URL      — https://<project>.supabase.co
  SUPABASE_KEY      — service role key
  UNIFI_URL         — e.g. https://192.168.1.1
  UNIFI_PORT        — default 8443
  UNIFI_USER        — local UniFi account username
  UNIFI_PASS        — local UniFi account password
  UNIFI_SITE        — default
  UNIFI_VERIFY_SSL  — false (self-signed cert)
  POLL_INTERVAL     — seconds between polls (default 60)
"""

import logging
import os
import time
from datetime import datetime, timezone

import requests
from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_KEY"]
UNIFI_URL      = os.environ["UNIFI_URL"].rstrip("/")
UNIFI_PORT     = os.environ.get("UNIFI_PORT", "8443")
UNIFI_USER     = os.environ["UNIFI_USER"]
UNIFI_PASS     = os.environ["UNIFI_PASS"]
UNIFI_SITE     = os.environ.get("UNIFI_SITE", "default")
VERIFY_SSL     = os.environ.get("UNIFI_VERIFY_SSL", "false").lower() not in ("false", "0", "no")
POLL_INTERVAL  = int(os.environ.get("POLL_INTERVAL", "60"))

_BASE = f"{UNIFI_URL}:{UNIFI_PORT}"


# ── UniFi session ─────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    """Authenticate to the UniFi Controller and return an authenticated session."""
    session = requests.Session()
    session.verify = VERIFY_SSL

    resp = session.post(
        f"{_BASE}/api/login",
        json={"username": UNIFI_USER, "password": UNIFI_PASS},
        timeout=10,
    )
    resp.raise_for_status()
    log.info("Authenticated to UniFi Controller at %s", _BASE)
    return session


def _get(session: requests.Session, path: str) -> list[dict]:
    """GET /api/s/{site}/{path} and return the data list."""
    url = f"{_BASE}/api/s/{UNIFI_SITE}/{path}"
    resp = session.get(url, timeout=10)
    resp.raise_for_status()
    return resp.json().get("data", [])


# ── Switch port parsing ───────────────────────────────────────────────────────

def _build_port_map(stations: list[dict]) -> dict[tuple, dict]:
    """
    Build a (switch_mac, port_idx) → {device_name, device_ip} lookup from the
    connected-client list.  UniFi includes sw_mac / sw_port on wired clients,
    which is the only reliable way to know which device is on which port.
    """
    port_map: dict[tuple, dict] = {}
    for client in stations:
        sw_port = client.get("sw_port")
        sw_mac  = client.get("sw_mac", "").lower()
        if not sw_port or not sw_mac:
            continue
        name = (
            client.get("hostname")
            or client.get("name")
            or client.get("mac", "")
        )
        ip = client.get("ip", "").split("/")[0]  # strip /32 CIDR suffix if present
        port_map[(sw_mac, int(sw_port))] = {"device_name": name, "device_ip": ip or None}
    return port_map


def _parse_switch_ports(
    devices: list[dict],
    stations: list[dict],
    now: str,
) -> list[dict]:
    """
    Extract per-port metrics from USW (UniFi Switch) devices.
    Uses the connected-client list to resolve device_name and device_ip per port.
    Returns rows ready for switch_port_metrics insert.
    """
    port_map = _build_port_map(stations)
    rows = []
    for device in devices:
        if device.get("type") != "usw":
            continue

        switch_id   = device.get("mac", "").lower()
        switch_name = device.get("name") or device.get("model", switch_id)

        for port in device.get("port_table", []):
            port_idx    = port.get("port_idx")
            client_info = port_map.get((switch_id, int(port_idx or 0)), {})
            port_label  = port.get("name", "") or f"Port {port_idx}"
            rows.append({
                "time":        now,
                "switch_id":   switch_id,
                "switch_name": switch_name,
                "port_id":     port_idx,
                "port_name":   port_label,
                "device_name": client_info.get("device_name") or port_label,
                "device_ip":   client_info.get("device_ip"),
                "rx_bytes":    port.get("rx_bytes"),
                "tx_bytes":    port.get("tx_bytes"),
                "rx_errors":   port.get("rx_errors"),
                "tx_errors":   port.get("tx_errors"),
                "rx_packets":  port.get("rx_packets"),
                "tx_packets":  port.get("tx_packets"),
                "poe_watts":   port.get("poe_power"),
                "is_uplink":   port.get("is_uplink", False),
            })
    return rows


# ── Client parsing ────────────────────────────────────────────────────────────

def _parse_clients(stations: list[dict]) -> list[dict]:
    """
    Map connected UniFi stations to device_registry upsert rows.
    Only fields present in device_registry are populated; others left to defaults.
    """
    rows = []
    for sta in stations:
        mac = sta.get("mac", "").lower()
        ip  = sta.get("ip", "").strip()
        if not mac or not ip:
            continue

        sw_mac  = sta.get("sw_mac", "").lower() or None
        sw_port = sta.get("sw_port")
        rows.append({
            "mac":         mac,
            "ip":          ip,
            "hostname":    sta.get("hostname") or sta.get("name") or "",
            "device_type": "unknown",
            "is_online":   True,
            "last_seen":   datetime.now(timezone.utc).isoformat(),
            "switch_id":   sw_mac,
            "port_id":     str(sw_port) if sw_port else None,
        })
    return rows


# ── Supabase writes ───────────────────────────────────────────────────────────

def _write_port_metrics(client: Client, rows: list[dict]) -> None:
    if not rows:
        return
    try:
        client.table("switch_port_metrics").insert(rows).execute()
        log.info("Inserted %d switch port rows", len(rows))
    except Exception as exc:
        log.error("Failed to insert switch_port_metrics: %s", exc)


def _upsert_clients(client: Client, rows: list[dict]) -> None:
    if not rows:
        return
    try:
        client.table("device_registry").upsert(
            rows, on_conflict="ip"
        ).execute()
        log.info("Upserted %d client rows into device_registry", len(rows))
    except Exception as exc:
        log.error("Failed to upsert device_registry: %s", exc)


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    log.info(
        "unifi_poller starting — controller=%s site=%s interval=%ds",
        _BASE, UNIFI_SITE, POLL_INTERVAL,
    )
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    while True:
        start = time.monotonic()
        try:
            session = _make_session()

            now = datetime.now(timezone.utc).isoformat()

            # Fetch both endpoints; stations are needed for port→device mapping
            devices  = _get(session, "stat/device")
            stations = _get(session, "stat/sta")

            # Switch port stats (uses station list to resolve device_name/device_ip)
            port_rows = _parse_switch_ports(devices, stations, now)
            _write_port_metrics(supabase, port_rows)

            # Connected clients → device_registry upsert
            client_rows = _parse_clients(stations)
            _upsert_clients(supabase, client_rows)

        except requests.HTTPError as exc:
            log.error("UniFi HTTP error: %s", exc)
        except requests.ConnectionError as exc:
            log.error("UniFi connection error: %s", exc)
        except Exception as exc:
            log.exception("Unexpected error: %s", exc)

        elapsed   = time.monotonic() - start
        sleep_for = max(0.0, POLL_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
