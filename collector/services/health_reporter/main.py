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
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL             = os.environ["SUPABASE_URL"]
SUPABASE_KEY             = os.environ["SUPABASE_KEY"]
COLLECTOR_ID             = os.environ.get("COLLECTOR_ID", "office-main")
REPORT_INTERVAL          = int(os.environ.get("REPORT_INTERVAL", "60"))
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


def _write_heartbeat(client: Client, sources: dict[str, bool]) -> None:
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
            "Heartbeat written — collector=%s sources=%s",
            COLLECTOR_ID,
            {k: ("ok" if v else "SILENT") for k, v in sources.items()},
        )
    except Exception as exc:
        log.error("Failed to write heartbeat: %s", exc)


def main() -> None:
    log.info(
        "health_reporter starting — collector_id=%s interval=%ds",
        COLLECTOR_ID, REPORT_INTERVAL,
    )
    client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    while True:
        start = time.monotonic()

        sources = _check_sources(client)
        _write_heartbeat(client, sources)

        elapsed   = time.monotonic() - start
        sleep_for = max(0.0, REPORT_INTERVAL - elapsed)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
