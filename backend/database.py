from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from backend.config import settings

_is_postgres = "postgresql" in settings.DATABASE_URL
_engine_kwargs: dict = {"echo": settings.DEBUG}

if _is_postgres:
    _engine_kwargs.update(pool_size=5, max_overflow=10, pool_pre_ping=True)
else:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db():
    from backend import models  # noqa: F401
    if not _is_postgres:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
