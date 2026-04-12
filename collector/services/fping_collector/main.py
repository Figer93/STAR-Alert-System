"""
fping_collector — pings LAN targets every FPING_INTERVAL seconds and writes
rtt_ms / packet_loss_pct to the collector buffer (→ Railway backend).

LAN-only targets (Phase 0D):
  - INTERNAL_IPS  — comma-separated env var, e.g. 10.2.1.253,10.2.1.5,10.2.1.3,10.2.2.100

WAN targets (1.1.1.1, 8.8.8.8, WAN gateways) are monitored exclusively by the
Railway backend and must NOT be configured here.  See CLAUDE.md architecture section.

fping output format parsed:
  192.168.1.1 : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.33/0.40/0.54
"""

import sys
sys.path.insert(0, '/app')

import logging
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

from buffer import write_local, flush_to_backend

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

BACKEND_URL    = os.environ["BACKEND_URL"]
INTERNAL_IPS   = [
    ip.strip()
    for ip in os.environ.get("INTERNAL_IPS", "").split(",")
    if ip.strip()
]
FPING_INTERVAL = int(os.environ.get("FPING_INTERVAL", "30"))

# Regex for fping summary line:
#   192.168.1.1 : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.33/0.40/0.54
_FPING_RE = re.compile(
    r"^(\S+)\s*:\s*xmt/rcv/%loss\s*=\s*\d+/\d+/(\d+)%"
    r"(?:.*min/avg/max\s*=\s*[\d.]+/([\d.]+)/)?"
)


def _build_targets() -> dict[str, str]:
    """Return {ip: category} dict of all LAN targets."""
    targets: dict[str, str] = {}
    for ip in INTERNAL_IPS:
        targets[ip] = "internal"
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
        ip       = m.group(1)
        loss_pct = float(m.group(2))
        avg_rtt  = float(m.group(3)) if m.group(3) else None
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


def _flush_loop() -> None:
    """Background thread: flush buffer to backend every 60 seconds."""
    while True:
        time.sleep(60)
        try:
            flush_to_backend(BACKEND_URL)
        except Exception as exc:
            log.error("Flush error: %s", exc)


def main() -> None:
    log.info(
        "fping_collector starting — internal_ips=%s interval=%ds",
        INTERNAL_IPS, FPING_INTERVAL,
    )

    # Start background flush thread
    flush_thread = threading.Thread(target=_flush_loop, daemon=True)
    flush_thread.start()
    log.info("Buffer flush thread started (60s interval) → %s", BACKEND_URL)

    targets = _build_targets()
    if not targets:
        log.warning(
            "No targets configured — set INTERNAL_IPS env var "
            "(e.g. 10.2.1.253,10.2.1.5,10.2.1.3,10.2.2.100)"
        )
    else:
        log.info("LAN targets: %s", list(targets.keys()))

    while True:
        start = time.monotonic()

        if targets:
            now     = datetime.now(timezone.utc).isoformat()
            output  = _run_fping(list(targets.keys()))
            results = _parse_fping(output)
            rows    = _build_rows(targets, results, now)
            for row in rows:
                write_local("/api/collector/metrics/latency", row)
            log.debug("Buffered %d latency rows", len(rows))
        else:
            log.warning("No targets configured — check INTERNAL_IPS env var")

        elapsed  = time.monotonic() - start
        sleep_for = max(0.0, FPING_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
