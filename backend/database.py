import logging
import threading
import time

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from backend.config import settings

_slow_query_logger = logging.getLogger("slow_query")

_is_postgres = "postgresql" in settings.DATABASE_URL

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
        },
    )
else:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

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


async def init_db():
    from backend import models  # noqa: F401 — ensure models are registered
    # create_all is idempotent (skips existing tables), so it is safe to run on
    # both SQLite and PostgreSQL.  On PostgreSQL, migrations are applied manually
    # via alembic upgrade head before deploying.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
