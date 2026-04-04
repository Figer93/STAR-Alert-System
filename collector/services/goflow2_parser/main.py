"""
goflow2_parser — tails flows.jsonl written by goflow2 and inserts into
the Supabase network_flows table.

goflow2 JSON field mapping:
  src_addr            → src_ip
  dst_addr            → dst_ip
  src_port            → src_port
  dst_port            → dst_port
  proto               → protocol  (integer: 6=TCP, 17=UDP, 1=ICMP)
  bytes               → bytes
  packets             → packets
  time_flow_start_ns  → time      (nanoseconds → ISO timestamp)
  flow_direction      → direction (0=ingress→inbound, 1=egress→outbound)
  sampler_address     → used to derive device_name via src lookup

Direction heuristic (applied when flow_direction field is absent or 0/1
is ambiguous relative to our network):
  src in LOCAL_SUBNET and dst not → outbound
  dst in LOCAL_SUBNET and src not → inbound
  both in LOCAL_SUBNET            → internal
"""

import ipaddress
import json
import logging
import os
import time
from datetime import datetime, timezone

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_KEY"]
FLOWS_FILE     = os.environ.get("FLOWS_FILE", "/data/flows.jsonl")
BATCH_SIZE     = int(os.environ.get("BATCH_SIZE", "100"))
BATCH_INTERVAL = float(os.environ.get("BATCH_INTERVAL", "2.0"))

# Treat anything in these prefixes as "local" for direction classification.
# Extend if your office uses additional RFC-1918 ranges.
_LOCAL_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]


def _is_local(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
        return any(ip in net for net in _LOCAL_NETWORKS)
    except ValueError:
        return False


def _direction(row: dict) -> str:
    src = row.get("src_addr", "")
    dst = row.get("dst_addr", "")
    src_local = _is_local(src)
    dst_local = _is_local(dst)
    if src_local and not dst_local:
        return "outbound"
    if dst_local and not src_local:
        return "inbound"
    return "internal"


def _ns_to_iso(ns: int) -> str:
    """Convert nanosecond epoch to ISO-8601 string with timezone."""
    dt = datetime.fromtimestamp(ns / 1e9, tz=timezone.utc)
    return dt.isoformat()


def _parse_line(line: str) -> dict | None:
    """Parse one JSON line from goflow2 and return a network_flows row dict."""
    line = line.strip()
    if not line:
        return None
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        log.warning("Skipping malformed JSON line: %s — %s", line[:80], exc)
        return None

    time_ns = raw.get("time_flow_start_ns") or raw.get("TimeFlowStartNs", 0)

    return {
        "time":        _ns_to_iso(time_ns) if time_ns else datetime.now(timezone.utc).isoformat(),
        "src_ip":      raw.get("src_addr") or raw.get("SrcAddr"),
        "dst_ip":      raw.get("dst_addr") or raw.get("DstAddr"),
        "src_port":    raw.get("src_port") or raw.get("SrcPort"),
        "dst_port":    raw.get("dst_port") or raw.get("DstPort"),
        "protocol":    raw.get("proto") or raw.get("Proto"),
        "bytes":       raw.get("bytes") or raw.get("Bytes"),
        "packets":     raw.get("packets") or raw.get("Packets"),
        "device_name": None,   # enriched by queries against device_registry if needed
        "direction":   _direction(raw),
    }


def _flush(client: Client, batch: list[dict]) -> None:
    """Insert a batch of rows into network_flows, discarding rows on error."""
    if not batch:
        return
    try:
        client.table("network_flows").insert(batch).execute()
        log.info("Inserted %d flow rows", len(batch))
    except Exception as exc:
        log.error("Failed to insert batch of %d rows: %s", len(batch), exc)


def _wait_for_file(path: str) -> None:
    """Block until the flows file exists (goflow2 may take a moment to start)."""
    while not os.path.exists(path):
        log.info("Waiting for %s …", path)
        time.sleep(5)


def tail(path: str, client: Client) -> None:
    """Continuously tail the file, batching rows and flushing to Supabase."""
    _wait_for_file(path)
    batch: list[dict] = []
    last_flush = time.monotonic()

    with open(path, "r") as fh:
        # Seek to end on first open so we only process new flows, not history.
        fh.seek(0, 2)
        log.info("Tailing %s", path)

        while True:
            line = fh.readline()
            if line:
                row = _parse_line(line)
                if row:
                    batch.append(row)
            else:
                # No new data — check whether we should flush what we have.
                time.sleep(0.1)

            now = time.monotonic()
            if len(batch) >= BATCH_SIZE or (batch and now - last_flush >= BATCH_INTERVAL):
                _flush(client, batch)
                batch = []
                last_flush = now


def main() -> None:
    log.info("goflow2_parser starting — file=%s batch=%d interval=%.1fs",
             FLOWS_FILE, BATCH_SIZE, BATCH_INTERVAL)
    client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    while True:
        try:
            tail(FLOWS_FILE, client)
        except FileNotFoundError:
            log.warning("%s disappeared, waiting for it to reappear …", FLOWS_FILE)
            time.sleep(10)
        except Exception as exc:
            log.error("Unexpected error in tail loop: %s — restarting in 5 s", exc)
            time.sleep(5)


if __name__ == "__main__":
    main()
