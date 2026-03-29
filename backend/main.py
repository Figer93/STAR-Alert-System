import asyncio
import logging
import logging.handlers
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.database import init_db
from backend.routers import alerts, ingest, maintenance, notifications, rules, sources, stats, ws
from backend.websocket_manager import ws_manager

log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.handlers.RotatingFileHandler(log_dir / "app.log", maxBytes=10 * 1024 * 1024, backupCount=5),
    ],
)
logger = logging.getLogger(__name__)


async def _stats_broadcaster():
    while True:
        await asyncio.sleep(30)
        if ws_manager.connection_count > 0:
            try:
                from backend.database import AsyncSessionLocal
                from backend.routers.stats import get_summary
                async with AsyncSessionLocal() as db:
                    summary = await get_summary(db)
                    await ws_manager.broadcast("stats.update", summary.model_dump())
            except Exception:
                logger.exception("Stats broadcast error")


async def _source_offline_checker():
    OFFLINE_THRESHOLD_MINUTES = 5
    while True:
        await asyncio.sleep(60)
        try:
            from sqlalchemy import select
            from backend.database import AsyncSessionLocal
            from backend.models import Source
            from backend.schemas import RawAlert
            from backend.alert_engine import process_alert
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=OFFLINE_THRESHOLD_MINUTES)
            async with AsyncSessionLocal() as db:
                stmt = select(Source).where(Source.enabled == True).where(Source.status == "online").where(Source.last_seen < cutoff)  # noqa
                stale = (await db.execute(stmt)).scalars().all()
                for source in stale:
                    source.status = "offline"
                    await db.commit()
                    await ws_manager.broadcast("source.status_change", {"id": source.id, "slug": source.slug, "status": "offline"})
                    raw = RawAlert(source_slug=source.slug, event_type="source_offline", title=f"{source.name} went offline", message=f"No heartbeat from {source.name} for over {OFFLINE_THRESHOLD_MINUTES} minutes.", severity="critical", fingerprint_key=f"source_offline:{source.slug}", raw_payload={"source_slug": source.slug})
                    await process_alert(raw, db)
        except Exception:
            logger.exception("Source offline checker error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s...", settings.APP_NAME)
    await init_db()
    syslog_transport = None
    try:
        from backend.adapters.syslog_listener import start_syslog_listener
        syslog_transport, _ = await start_syslog_listener()
    except Exception:
        logger.exception("Failed to start syslog listener")
    broadcast_task = asyncio.create_task(_stats_broadcaster())
    offline_task = asyncio.create_task(_source_offline_checker())
    yield
    broadcast_task.cancel()
    offline_task.cancel()
    if syslog_transport:
        syslog_transport.close()


app = FastAPI(title=settings.APP_NAME, version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

app.include_router(alerts.router)
app.include_router(sources.router)
app.include_router(stats.router)
app.include_router(rules.router)
app.include_router(ingest.router)
app.include_router(notifications.router)
app.include_router(maintenance.router)
app.include_router(ws.router)


@app.get("/health")
async def health():
    from sqlalchemy import text
    from backend.database import AsyncSessionLocal
    db_ok = False
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        pass
    from backend.maintenance import maintenance
    return {"status": "ok" if db_ok else "degraded", "app": settings.APP_NAME, "db": "ok" if db_ok else "error", "ws_connections": ws_manager.connection_count, "maintenance": maintenance.status()}
