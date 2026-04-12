"""
health_reporter — writes a heartbeat row to collector_heartbeat every
REPORT_INTERVAL seconds, and checks whether each data source has written
a row within the last 5 minutes.

Source liveness checks:
  goflow2   → latest row in network_flows
  telegraf  → latest row in switch_port_metrics
  fping     → latest row in latency_metrics

If any source has been silent for more than SILENCE_THRESHOLD_SECONDS,
a warning is logged (future: raise an alert via the main STAR backend).

Heartbeat is sent to BOTH:
  1. Supabase directly via supabase-py (kept as fallback)
  2. Railway backend POST /api/collector/heartbeat
"""

import sys
sys.path.insert(0, '/app')

import json
import logging
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL              = os.environ["SUPABASE_URL"]
SUPABASE_KEY              = os.environ["SUPABASE_KEY"]
BACKEND_URL               = os.environ.get("BACKEND_URL", "").strip()
COLLECTOR_ID              = os.environ.get("COLLECTOR_ID", "office-main")
REPORT_INTERVAL           = int(os.environ.get("REPORT_INTERVAL", "60"))
SILENCE_THRESHOLD_SECONDS = 300   # 5 minutes

# Map source name → table to query for its latest row.
_SOURCE_TABLES = {
    "goflow2":  "network_flows",
    "telegraf": "switch_port_metrics",
    "fping":    "latency_metrics",
}


def _latest_row_time(client: Client, table: str) -> datetime | None:
    """Return the `time` of the most recent row in the given table, or None."""
    try:
        resp = (
            client.table(table)
            .select("time")
            .order("time", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            raw = resp.data[0]["time"]
            # Supabase returns ISO-8601 strings; parse to aware datetime.
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
    except Exception as exc:
        log.warning("Could not query %s: %s", table, exc)
    return None


def _check_sources(client: Client) -> dict[str, bool]:
    """
    Check each source's last write timestamp.
    Returns {source: True} if the source wrote within the threshold.
    Logs a WARNING for any silent source.
    """
    now     = datetime.now(timezone.utc)
    cutoff  = now - timedelta(seconds=SILENCE_THRESHOLD_SECONDS)
    statuses: dict[str, bool] = {}

    for source, table in _SOURCE_TABLES.items():
        last = _latest_row_time(client, table)
        if last is None:
            active = False
            log.warning(
                "SOURCE SILENT: %s — no rows found in %s", source, table
            )
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


def _write_heartbeat_supabase(client: Client, sources: dict[str, bool]) -> None:
    """Write heartbeat directly to Supabase (kept as fallback)."""
    now = datetime.now(timezone.utc).isoformat()
    row = {
        "collector_id": COLLECTOR_ID,
        "last_seen":    now,
        "version":      "0.1.0",
        "sources":      json.dumps(sources),
    }
    try:
        # Upsert on primary key (collector_id) so there is always exactly
        # one row per collector instance, not a growing history.
        client.table("collector_heartbeat").upsert(row).execute()
        log.info(
            "Heartbeat written to Supabase — collector=%s sources=%s",
            COLLECTOR_ID,
            {k: ("ok" if v else "SILENT") for k, v in sources.items()},
        )
    except Exception as exc:
        log.error("Failed to write heartbeat to Supabase: %s", exc)


def _post_heartbeat_backend(sources: dict[str, bool]) -> None:
    """POST heartbeat to Railway backend /api/collector/heartbeat."""
    if not BACKEND_URL:
        return

    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "collector_id": COLLECTOR_ID,
        "last_seen":    now,
        "version":      "0.1.0",
        "sources":      sources,
    }
    body = json.dumps(payload).encode("utf-8")
    url  = f"{BACKEND_URL.rstrip('/')}/api/collector/heartbeat"
    req  = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                log.debug("Heartbeat posted to backend OK")
            else:
                log.warning(
                    "Backend heartbeat returned HTTP %d", resp.status
                )
    except urllib.error.URLError as exc:
        log.warning("Could not post heartbeat to backend: %s", exc.reason)
    except Exception as exc:
        log.error("Unexpected error posting heartbeat to backend: %s", exc)


def main() -> None:
    log.info(
        "health_reporter starting — collector_id=%s interval=%ds",
        COLLECTOR_ID, REPORT_INTERVAL,
    )
    client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    while True:
        start = time.monotonic()

        sources = _check_sources(client)
        _write_heartbeat_supabase(client, sources)
        _post_heartbeat_backend(sources)

        elapsed   = time.monotonic() - start
        sleep_for = max(0.0, REPORT_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
