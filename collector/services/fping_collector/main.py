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

import json as _json
import logging
import os
import queue
import re
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone

from buffer import write_local, flush_to_backend

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

BACKEND_URL      = os.environ["BACKEND_URL"]
COLLECTOR_SECRET = os.environ.get("COLLECTOR_SECRET", "")
INTERNAL_IPS     = [
    ip.strip()
    for ip in os.environ.get("INTERNAL_IPS", "").split(",")
    if ip.strip()
]
FPING_INTERVAL = int(os.environ.get("FPING_INTERVAL", "30"))

# pfSense LAN gateway must always be present — latency to it is used by the
# backend to distinguish PFSENSE vs WAN root causes.
_PFSENSE_IP = "10.2.1.253"

# Traceroute debounce: one run per target per 60 s maximum.
_tr_last: dict[str, float] = {}
_TR_COOLDOWN = 60.0
_tr_queue: queue.Queue = queue.Queue()

# Regex for fping summary line:
#   192.168.1.1 : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.33/0.40/0.54
_FPING_RE = re.compile(
    r"^(\S+)\s*:\s*xmt/rcv/%loss\s*=\s*\d+/\d+/(\d+)%"
    r"(?:.*min/avg/max\s*=\s*[\d.]+/([\d.]+)/)?"
)

# Traceroute output: " 1  10.2.1.253  1.234 ms" or " 2  * "
_TRACE_HOP_RE  = re.compile(r"^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+ms")
_TRACE_STAR_RE = re.compile(r"^\s*(\d+)\s+\*")


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


# ── Traceroute ────────────────────────────────────────────────────────────────

def _parse_traceroute(output: str) -> list[dict]:
    hops: list[dict] = []
    seen: set[int] = set()
    for line in output.splitlines():
        m = _TRACE_HOP_RE.match(line)
        if m:
            hop_num = int(m.group(1))
            if hop_num not in seen:
                hops.append({"hop_num": hop_num, "ip": m.group(2), "rtt_ms": float(m.group(3))})
                seen.add(hop_num)
            continue
        m = _TRACE_STAR_RE.match(line)
        if m:
            hop_num = int(m.group(1))
            if hop_num not in seen:
                hops.append({"hop_num": hop_num, "ip": None, "rtt_ms": None})
                seen.add(hop_num)
    return hops


def _post_traceroute(payload: dict) -> None:
    body = _json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}/api/collector/metrics/traceroute",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Collector-Key": COLLECTOR_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        log.info("Traceroute for %s posted — status=%s", payload["target_ip"], resp.status)


def _run_traceroute(target_ip: str, loss_pct: float) -> None:
    try:
        result = subprocess.run(
            ["traceroute", "-n", "-w", "2", "-q", "1", "-m", "20", target_ip],
            capture_output=True, text=True, timeout=60,
        )
        hops = _parse_traceroute(result.stdout)
        if not hops:
            log.warning("Traceroute for %s returned no hops", target_ip)
            return
        _post_traceroute({
            "target_ip":             target_ip,
            "target_name":           target_ip,
            "triggered_by_loss_pct": loss_pct,
            "hops":                  hops,
            "collected_at":          datetime.now(timezone.utc).isoformat(),
        })
    except subprocess.TimeoutExpired:
        log.warning("Traceroute for %s timed out after 60 s", target_ip)
    except Exception as exc:
        log.error("Traceroute error for %s: %s", target_ip, exc)


def _traceroute_worker() -> None:
    """Background thread: drains _tr_queue and runs traceroutes sequentially."""
    while True:
        item = _tr_queue.get()
        if item is None:
            break
        target_ip, loss_pct = item
        _run_traceroute(target_ip, loss_pct)


# ── Buffer flush loop ─────────────────────────────────────────────────────────

def _flush_loop() -> None:
    """Background thread: flush buffer to backend every 20 seconds."""
    while True:
        time.sleep(20)
        try:
            flush_to_backend(BACKEND_URL)
        except Exception as exc:
            log.error("Flush error: %s", exc)


def main() -> None:
    log.info(
        "fping_collector starting — internal_ips=%s interval=%ds",
        INTERNAL_IPS, FPING_INTERVAL,
    )

    # Start background threads
    flush_thread = threading.Thread(target=_flush_loop, daemon=True)
    flush_thread.start()
    log.info("Buffer flush thread started (20s interval) → %s", BACKEND_URL)

    tr_thread = threading.Thread(target=_traceroute_worker, daemon=True)
    tr_thread.start()
    log.info("Traceroute worker thread started (triggered on >10%% loss, debounced %ds)", _TR_COOLDOWN)

    targets = _build_targets()
    if not targets:
        log.warning(
            "No targets configured — set INTERNAL_IPS env var "
            "(e.g. 10.2.1.253,10.2.1.5,10.2.1.3,10.2.2.100)"
        )
    else:
        log.info("LAN targets: %s", list(targets.keys()))
        if _PFSENSE_IP not in targets:
            log.warning(
                "pfSense LAN gateway %s is missing from INTERNAL_IPS — "
                "add it so the backend can distinguish PFSENSE vs WAN root causes. "
                "Current INTERNAL_IPS: %s",
                _PFSENSE_IP, INTERNAL_IPS,
            )

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

            # Trigger traceroute for any target with significant packet loss
            now_mono = time.monotonic()
            for ip, stats in results.items():
                loss = stats.get("packet_loss_pct", 0.0)
                if loss > 10:
                    last = _tr_last.get(ip, 0.0)
                    if now_mono - last >= _TR_COOLDOWN:
                        _tr_last[ip] = now_mono
                        _tr_queue.put((ip, loss))
                        log.info("Traceroute queued for %s (loss=%.1f%%)", ip, loss)
        else:
            log.warning("No targets configured — check INTERNAL_IPS env var")

        elapsed  = time.monotonic() - start
        sleep_for = max(0.0, FPING_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
