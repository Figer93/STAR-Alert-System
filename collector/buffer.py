"""
buffer.py — local SQLite write-ahead buffer for all collector metrics.

Every service writes metrics here first (write_local), then a background
flush thread sends them to the Railway backend API (flush_to_backend).
On internet outage the rows accumulate locally; when connectivity returns
flush_to_backend sends all buffered rows and logs a backfill summary.

Usage in each service:
    import sys
    sys.path.insert(0, '/app')
    from buffer import write_local, flush_to_backend
    import threading
    t = threading.Thread(target=_flush_loop, daemon=True)
    t.start()

    def _flush_loop():
        while True:
            time.sleep(60)
            flush_to_backend(BACKEND_URL)
"""

import json
import logging
import os
import sqlite3
import threading
import time
from typing import Optional

log = logging.getLogger(__name__)

_DB_PATH = os.environ.get("BUFFER_DB_PATH", "/data/buffer.db")
_MAX_ROWS = 50_000
_MAX_AGE_SECONDS = 86_400  # 24 hours
_BATCH_SIZE = 500

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def _get_conn() -> sqlite3.Connection:
    """Return the module-level SQLite connection, initialising if needed."""
    global _conn
    if _conn is None:
        _init_db()
    return _conn  # type: ignore[return-value]


def _init_db() -> None:
    """Create the buffer database and pending_metrics table if they don't exist."""
    global _conn
    db_dir = os.path.dirname(_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    _conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS pending_metrics (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint   TEXT    NOT NULL,
            payload    TEXT    NOT NULL,
            created_at REAL    NOT NULL,
            attempts   INTEGER NOT NULL DEFAULT 0
        )
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_pending_metrics_created_at
        ON pending_metrics (created_at ASC)
    """)
    _conn.commit()
    log.info("Buffer DB initialised at %s", _DB_PATH)


def write_local(endpoint: str, payload: dict) -> None:
    """
    Write a single metric row to the local SQLite buffer.
    Thread-safe. Returns immediately — never blocks on network.
    """
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO pending_metrics (endpoint, payload, created_at, attempts) "
            "VALUES (?, ?, ?, 0)",
            (endpoint, json.dumps(payload), time.time()),
        )
        conn.commit()


def _cleanup(conn: sqlite3.Connection) -> None:
    """
    Remove rows older than 24 h and cap total count at MAX_ROWS.
    Called at the start of each flush cycle.
    """
    cutoff = time.time() - _MAX_AGE_SECONDS
    deleted_old = conn.execute(
        "DELETE FROM pending_metrics WHERE created_at < ?", (cutoff,)
    ).rowcount
    if deleted_old:
        log.info("Buffer cleanup: removed %d rows older than 24h", deleted_old)

    count = conn.execute("SELECT COUNT(*) FROM pending_metrics").fetchone()[0]
    if count > _MAX_ROWS:
        excess = count - _MAX_ROWS
        conn.execute("""
            DELETE FROM pending_metrics
            WHERE id IN (
                SELECT id FROM pending_metrics
                ORDER BY created_at ASC
                LIMIT ?
            )
        """, (excess,))
        log.error(
            "Buffer overflow — collector may be disconnected from backend "
            "(dropped %d oldest rows, limit=%d)",
            excess, _MAX_ROWS,
        )

    conn.commit()


def flush_to_backend(backend_url: str) -> None:
    """
    Send buffered rows to the Railway backend, in batches of BATCH_SIZE.

    - Rows are sent to {backend_url}{endpoint} as POST {"rows": [...]}.
    - On HTTP 200 the rows are deleted from SQLite.
    - On failure the attempts counter is incremented and the row is retried
      on the next flush cycle.
    - When rows are successfully flushed after previous failures, a backfill
      log line is emitted with the gap duration.

    This function is synchronous and intended to run in a background thread.
    """
    try:
        import urllib.request
        import urllib.error
    except ImportError:
        log.error("urllib not available — cannot flush buffer")
        return

    with _lock:
        conn = _get_conn()
        _cleanup(conn)

        # Fetch the oldest BATCH_SIZE rows regardless of endpoint.
        rows = conn.execute(
            "SELECT id, endpoint, payload, created_at, attempts "
            "FROM pending_metrics "
            "ORDER BY created_at ASC "
            "LIMIT ?",
            (_BATCH_SIZE,),
        ).fetchall()

    if not rows:
        return

    # Group rows by endpoint so we POST one batch per endpoint.
    by_endpoint: dict[str, list] = {}
    for row_id, endpoint, payload_json, created_at, attempts in rows:
        by_endpoint.setdefault(endpoint, []).append(
            (row_id, payload_json, created_at, attempts)
        )

    for endpoint, endpoint_rows in by_endpoint.items():
        row_ids     = [r[0] for r in endpoint_rows]
        payloads    = [json.loads(r[1]) for r in endpoint_rows]
        oldest_time = min(r[2] for r in endpoint_rows)
        had_failed  = any(r[3] > 0 for r in endpoint_rows)

        url = f"{backend_url.rstrip('/')}{endpoint}"
        body = json.dumps({"rows": payloads}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status == 200:
                    with _lock:
                        conn = _get_conn()
                        placeholders = ",".join("?" * len(row_ids))
                        conn.execute(
                            f"DELETE FROM pending_metrics WHERE id IN ({placeholders})",
                            row_ids,
                        )
                        conn.commit()

                    if had_failed:
                        gap_minutes = (time.time() - oldest_time) / 60
                        log.info(
                            "Backfill: %d rows recovered from buffer for %s "
                            "(gap: %.1f minutes)",
                            len(row_ids), endpoint, gap_minutes,
                        )
                    else:
                        log.debug(
                            "Flushed %d rows to %s", len(row_ids), endpoint
                        )
                else:
                    _increment_attempts(row_ids)
                    log.warning(
                        "Backend returned HTTP %d for %s — will retry",
                        resp.status, endpoint,
                    )

        except urllib.error.URLError as exc:
            _increment_attempts(row_ids)
            log.warning(
                "Could not reach backend at %s: %s — %d rows buffered",
                url, exc.reason, len(row_ids),
            )
        except Exception as exc:
            _increment_attempts(row_ids)
            log.error("Unexpected flush error for %s: %s", endpoint, exc)


def _increment_attempts(row_ids: list[int]) -> None:
    """Increment attempts counter for the given row IDs."""
    with _lock:
        conn = _get_conn()
        placeholders = ",".join("?" * len(row_ids))
        conn.execute(
            f"UPDATE pending_metrics SET attempts = attempts + 1 "
            f"WHERE id IN ({placeholders})",
            row_ids,
        )
        conn.commit()


# Initialise on import so the DB file is created before any service tries to write.
_init_db()
