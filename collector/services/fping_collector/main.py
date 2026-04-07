"""
fping_collector — pings fixed targets every FPING_INTERVAL seconds and writes
rtt_ms / packet_loss_pct to the Supabase latency_metrics table.

Targets:
  - GATEWAY_IP    → category 'gateway'
  - ISP_GATEWAY_IP (optional) → category 'wan'
  - 8.8.8.8, 1.1.1.1  → category 'wan'

fping output format parsed:
  192.168.1.1 : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.33/0.40/0.54
"""

import logging
import os
import re
import subprocess
import time
from datetime import datetime, timezone

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL    = os.environ["SUPABASE_URL"]
SUPABASE_KEY    = os.environ["SUPABASE_KEY"]
GATEWAY_IP      = os.environ.get("GATEWAY_IP", "")
ISP_GATEWAY_IP  = os.environ.get("ISP_GATEWAY_IP", "").strip()
FPING_INTERVAL  = int(os.environ.get("FPING_INTERVAL", "30"))

# Static WAN targets always included.
_WAN_IPS = {"8.8.8.8", "1.1.1.1"}

# Regex for fping summary line:
#   192.168.1.1 : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.33/0.40/0.54
_FPING_RE = re.compile(
    r"^(\S+)\s*:\s*xmt/rcv/%loss\s*=\s*\d+/\d+/(\d+)%"
    r"(?:.*min/avg/max\s*=\s*[\d.]+/([\d.]+)/)?"
)


def _build_targets() -> dict[str, str]:
    """Return {ip: category} dict of fixed targets."""
    targets: dict[str, str] = {}

    if GATEWAY_IP:
        targets[GATEWAY_IP] = "gateway"
    if ISP_GATEWAY_IP:
        targets[ISP_GATEWAY_IP] = "wan"
    for ip in _WAN_IPS:
        targets[ip] = "wan"

    return targets


def _run_fping(ips: list[str]) -> str:
    """
    Run fping against the given IPs and return stderr output (where fping
    writes its summary).  fping exits non-zero when any host is unreachable,
    so we suppress CalledProcessError.
    """
    cmd = [
        "fping",
        "-q",          # quiet — suppress per-probe output
        "-c", "3",     # 3 probes per target
        "-p", "100",   # 100 ms between probes
        "-t", "500",   # 500 ms reply timeout
        *ips,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stderr  # fping summary goes to stderr regardless of exit code


def _parse_fping(output: str) -> dict[str, dict]:
    """
    Parse fping summary output.
    Returns {ip: {"rtt_ms": float|None, "packet_loss_pct": float}}.
    """
    parsed: dict[str, dict] = {}
    for line in output.splitlines():
        m = _FPING_RE.match(line.strip())
        if not m:
            continue
        ip        = m.group(1)
        loss_pct  = float(m.group(2))
        avg_rtt   = float(m.group(3)) if m.group(3) else None
        parsed[ip] = {"rtt_ms": avg_rtt, "packet_loss_pct": loss_pct}
    return parsed


def _build_rows(
    targets: dict[str, str],
    results: dict[str, dict],
    now: str,
) -> list[dict]:
    rows = []
    for ip, category in targets.items():
        stats = results.get(ip)
        if stats is None:
            # fping did not produce a line for this IP — treat as 100% loss.
            stats = {"rtt_ms": None, "packet_loss_pct": 100.0}
        rows.append({
            "time":            now,
            "target_name":     ip,
            "target_ip":       ip,
            "target_type":     category,
            "rtt_ms":          stats["rtt_ms"],
            "packet_loss_pct": stats["packet_loss_pct"],
        })
    return rows


def _write(client: Client, rows: list[dict]) -> None:
    try:
        client.table("latency_metrics").insert(rows).execute()
    except Exception as exc:
        log.error("Failed to write %d latency rows: %s", len(rows), exc)


def main() -> None:
    log.info(
        "fping_collector starting — gateway=%s isp=%s interval=%ds",
        GATEWAY_IP, ISP_GATEWAY_IP or "(not set)", FPING_INTERVAL,
    )
    client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    targets = _build_targets()
    log.info("Fixed targets: %s", list(targets.keys()))

    while True:
        start = time.monotonic()

        if targets:
            now    = datetime.now(timezone.utc).isoformat()
            output = _run_fping(list(targets.keys()))
            results = _parse_fping(output)
            rows   = _build_rows(targets, results, now)
            _write(client, rows)
            log.debug("Wrote %d latency rows", len(rows))
        else:
            log.warning("No targets configured — check GATEWAY_IP env var")

        elapsed = time.monotonic() - start
        sleep_for = max(0.0, FPING_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
