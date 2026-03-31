from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from backend.config import settings

_is_postgres = "postgresql" in settings.DATABASE_URL

_engine_kwargs: dict = {"echo": settings.DEBUG}

if _is_postgres:
    _engine_kwargs.update(
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        connect_args={"statement_cache_size": 0},
    )
else:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

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
    # both SQLite and PostgreSQL.  On PostgreSQL, alembic upgrade head in the
    # start command handles schema migrations, but create_all ensures all tables
    # exist even if migrations haven't been applied yet (e.g. first deploy).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
