import asyncio
import logging
import threading
import time

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from backend.config import settings

_slow_query_logger = logging.getLogger("slow_query")

# Normalise the DATABASE_URL so create_async_engine always gets the asyncpg
# dialect.  Railway (and many PaaS providers) supply a bare postgresql:// URL
# which SQLAlchemy maps to the sync psycopg2 driver — not installed here.
def _normalise_db_url(url: str) -> str:
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url

_DATABASE_URL = _normalise_db_url(settings.DATABASE_URL)
logging.getLogger(__name__).info("Connecting to: %s", _DATABASE_URL.split("@")[-1])

_is_postgres = "postgresql" in _DATABASE_URL

_engine_kwargs: dict = {"echo": settings.DEBUG}

if _is_postgres:
    _engine_kwargs.update(
        # Pool sized to handle concurrent collector ingest + dashboard queries.
        # Total max connections = pool_size + max_overflow = 15.
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
        # Recycle connections every 5 min to avoid stale sockets.
        pool_recycle=300,
        # Test connections before use so stale/closed sockets are replaced
        # automatically rather than surfacing as errors in handlers.
        pool_pre_ping=True,
        connect_args={
            "server_settings": {"application_name": "star_alert"},
            # Railway internal network (railway.internal) does not expose SSL;
            # only add ssl="require" for public/external URLs.
            **({} if "railway.internal" in _DATABASE_URL else {"ssl": "require"}),
        },
    )
else:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(_DATABASE_URL, **_engine_kwargs)

# ── Slow-query logging ────────────────────────────────────────────────────────
# Fires on the underlying sync engine so it works with asyncpg.
# Queries taking longer than 500 ms are logged at WARNING level with the full
# SQL statement so they can be investigated with EXPLAIN ANALYZE.

if _is_postgres:
    _q_start: threading.local = threading.local()

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _before_cursor_execute(
        conn, cursor, statement, parameters, context, executemany
    ):
        _q_start.t = time.monotonic()

    @event.listens_for(engine.sync_engine, "after_cursor_execute")
    def _after_cursor_execute(
        conn, cursor, statement, parameters, context, executemany
    ):
        elapsed = time.monotonic() - getattr(_q_start, "t", time.monotonic())
        if elapsed >= 0.5:
            _slow_query_logger.warning(
                "Slow query (%.3fs) — run EXPLAIN ANALYZE to investigate:\n%s\nparams: %s",
                elapsed,
                statement.strip()[:2000],
                repr(parameters)[:500],
            )

# ─────────────────────────────────────────────────────────────────────────────

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


_log = logging.getLogger(__name__)


async def init_db() -> None:
    """Connect to the DB and ensure schema is present.

    Retries with back-off so Railway cold-starts (where Postgres may take
    10-30 s to be ready) don't crash the backend before it has a chance to
    connect.
    """
    import os
    _log.info("RAW DATABASE_URL host: %s", os.environ.get("DATABASE_URL", "NOT SET").split("@")[-1].split("/")[0])
    from backend import models  # noqa: F401 — ensure models are registered

    max_attempts = 8
    for attempt in range(1, max_attempts + 1):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            return
        except Exception as exc:
            if attempt == max_attempts:
                raise
            delay = min(5 * attempt, 30)
            _log.warning(
                "DB init attempt %d/%d failed (%s: %s) — retrying in %ds",
                attempt, max_attempts, type(exc).__name__, exc, delay,
            )
            await asyncio.sleep(delay)
