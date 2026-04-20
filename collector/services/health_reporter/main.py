"""
health_reporter — writes a heartbeat row to collector_heartbeat every
REPORT_INTERVAL seconds, and checks whether each data source has written
a row within the last 5 minutes.

Source liveness checks:
  goflow2   → latest row in local buffer for /api/collector/metrics/flows
  telegraf  → latest row in local buffer for /api/collector/metrics/ports
  fping     → latest row in local buffer for /api/collector/metrics/latency

If any source has been silent for more than SILENCE_THRESHOLD_SECONDS,
a warning is logged.

Heartbeat is sent to Railway backend POST /api/collector/heartbeat.
"""

import sys
sys.path.insert(0, '/app')

import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

BACKEND_URL               = os.environ["BACKEND_URL"].strip()
COLLECTOR_ID              = os.environ.get("COLLECTOR_ID", "office-main")
REPORT_INTERVAL           = int(os.environ.get("REPORT_INTERVAL", "60"))
SILENCE_THRESHOLD_SECONDS = 300   # 5 minutes
BUFFER_DB_PATH            = os.environ.get("BUFFER_DB_PATH", "/data/buffer.db")

# Map source name → buffer endpoint written by each collector service.
_SOURCE_ENDPOINTS = {
    "fping":    "/api/collector/metrics/latency",
    "goflow2":  "/api/collector/metrics/flows",
    "telegraf": "/api/collector/metrics/ports",
}


def _latest_buffer_time(endpoint: str) -> datetime | None:
    """Return the created_at of the most recent buffer row for the given endpoint."""
    try:
        conn = sqlite3.connect(BUFFER_DB_PATH, check_same_thread=False)
        row = conn.execute(
            "SELECT created_at FROM pending_metrics WHERE endpoint = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (endpoint,),
        ).fetchone()
        conn.close()
        if row:
            return datetime.fromtimestamp(row[0], tz=timezone.utc)
    except Exception as exc:
        log.warning("Could not query buffer for %s: %s", endpoint, exc)
    return None


def _check_sources() -> dict[str, bool]:
    """
    Check each source's last write timestamp in the local SQLite buffer.
    Returns {source: True} if the source wrote within the threshold.
    Logs a WARNING for any silent source.
    """
    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=SILENCE_THRESHOLD_SECONDS)
    statuses: dict[str, bool] = {}

    for source, endpoint in _SOURCE_ENDPOINTS.items():
        last = _latest_buffer_time(endpoint)
        if last is None:
            active = False
            log.warning("SOURCE SILENT: %s — no rows found in buffer", source)
        elif last < cutoff:
            active = False
            lag = int((now - last).total_seconds())
            log.warning(
                "SOURCE SILENT: %s — last row %ds ago (threshold %ds)",
                source, lag, SILENCE_THRESHOLD_SECONDS,
            )
        else:
            active = True
            log.debug("%s is active (last row at %s)", source, last.isoformat())

        statuses[source] = active

    return statuses


def _post_heartbeat(sources: dict[str, bool]) -> None:
    """POST heartbeat to Railway backend /api/collector/heartbeat."""
    url = f"{BACKEND_URL.rstrip('/')}/api/collector/heartbeat"
    payload = {
        "collector_id": COLLECTOR_ID,
        "last_seen":    datetime.now(timezone.utc).isoformat(),
        "version":      "0.1.0",
        "sources":      sources,
    }
    try:
        resp = requests.post(url, json=payload, timeout=10)
        if resp.ok:
            log.info(
                "Heartbeat posted — collector=%s sources=%s",
                COLLECTOR_ID,
                {k: ("ok" if v else "SILENT") for k, v in sources.items()},
            )
        else:
            log.warning("Backend heartbeat returned HTTP %d: %s", resp.status_code, resp.text)
    except requests.exceptions.RequestException as exc:
        log.warning("Could not post heartbeat to backend: %s", exc)


def main() -> None:
    log.info(
        "health_reporter starting — collector_id=%s interval=%ds backend=%s",
        COLLECTOR_ID, REPORT_INTERVAL, BACKEND_URL,
    )

    while True:
        start = time.monotonic()

        sources = _check_sources()
        _post_heartbeat(sources)

        elapsed   = time.monotonic() - start
        sleep_for = max(0.0, REPORT_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
