# v1.1.3 — Network Monitor
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
from backend.network_monitor import run_network_checks
from backend.routers import alerts, ingest, maintenance, network, notifications, notification_settings, rules, sources, stats, ws
from backend.websocket_manager import ws_manager

# ── Logging ───────────────────────────────────────────────────────────────────

log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.handlers.RotatingFileHandler(
            log_dir / "app.log",
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=5,
        ),
    ],
)

logger = logging.getLogger(__name__)

# ── Background tasks ──────────────────────────────────────────────────────────

async def _stats_broadcaster():
    """Broadcast dashboard stats every 30 s to connected WebSocket clients."""
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
    """
    Periodically mark sources offline if they haven't sent a heartbeat within
    the threshold, and raise a critical alert so the team is notified.
    """
    OFFLINE_THRESHOLD_MINUTES = 5
    CHECK_INTERVAL_SECONDS    = 60

    while True:
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
        try:
            from sqlalchemy import select
            from backend.database import AsyncSessionLocal
            from backend.models import Source
            from backend.schemas import RawAlert
            from backend.alert_engine import process_alert

            cutoff = datetime.now(timezone.utc) - timedelta(minutes=OFFLINE_THRESHOLD_MINUTES)

            async with AsyncSessionLocal() as db:
                # Webhook sources only fire when events occur — silence is normal.
                # Only check syslog/poll/push sources where continuous traffic is expected.
                stmt = (
                    select(Source)
                    .where(Source.enabled == True)  # noqa: E712
                    .where(Source.type != "webhook")
                    .where(Source.status == "online")
                    .where(Source.last_seen < cutoff)
                )
                stale_sources = (await db.execute(stmt)).scalars().all()

                for source in stale_sources:
                    logger.warning(
                        "Source '%s' has not been seen since %s — marking offline",
                        source.slug,
                        source.last_seen,
                    )
                    old_status   = source.status
                    source.status = "offline"
                    await db.commit()

                    # Broadcast status change
                    await ws_manager.broadcast(
                        "source.status_change",
                        {"id": source.id, "slug": source.slug, "status": "offline"},
                    )

                    # Raise a critical alert
                    raw = RawAlert(
                        source_slug=source.slug,
                        event_type="source_offline",
                        title=f"{source.name} went offline",
                        message=(
                            f"No heartbeat received from {source.name} for "
                            f"over {OFFLINE_THRESHOLD_MINUTES} minutes. "
                            f"Last seen: {source.last_seen.strftime('%H:%M:%S UTC') if source.last_seen else 'never'}."
                        ),
                        severity="critical",
                        fingerprint_key=f"source_offline:{source.slug}",
                        raw_payload={
                            "source_slug": source.slug,
                            "event": "source_offline",
                            "last_seen": source.last_seen.isoformat() if source.last_seen else None,
                        },
                    )
                    await process_alert(raw, db)
        except Exception:
            logger.exception("Source offline checker error")


# ── Lifespan ──────────────────────────────────────────────────────────────────

async def _seed_channel_settings() -> None:
    """Insert default notification channel settings rows if they don't exist yet."""
    from backend.database import AsyncSessionLocal
    from backend.models import NotificationChannelSettings

    DEFAULTS = {
        "telegram": {
            "enabled": True,
            "send_resolutions": False,
            "severity_filter": "",           # all severities
            "message_template": "",          # use built-in default
            "resolution_template": "",
            "field_toggles": {"source": True, "timestamp": True, "count": False, "message": True},
            "parse_mode": "plain",
            "subject_template": "",
            "updated_at": datetime.now(timezone.utc),
        },
        "email": {
            "enabled": True,
            "send_resolutions": False,
            "severity_filter": "critical",   # preserve existing "critical only" default
            "message_template": "",
            "resolution_template": "",
            "field_toggles": {"source": True, "timestamp": True, "count": True, "message": True},
            "parse_mode": "plain",
            "subject_template": "",
            "updated_at": datetime.now(timezone.utc),
        },
    }

    async with AsyncSessionLocal() as db:
        for channel, defaults in DEFAULTS.items():
            existing = await db.get(NotificationChannelSettings, channel)
            if not existing:
                db.add(NotificationChannelSettings(channel=channel, **defaults))
        await db.commit()
    logger.info("Notification channel settings seeded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s...", settings.APP_NAME)
    await init_db()
    await _seed_channel_settings()
    logger.info("Database initialised")

    # pfSense UDP syslog listener
    syslog_transport = None
    try:
        from backend.adapters.syslog_listener import start_syslog_listener
        syslog_transport, _ = await start_syslog_listener()
    except Exception:
        logger.exception("Failed to start syslog listener")

    # Background tasks
    broadcast_task = asyncio.create_task(_stats_broadcaster())
    offline_task   = asyncio.create_task(_source_offline_checker())
    network_task   = asyncio.create_task(run_network_checks())

    # UniFi polling loop (no-op if no UniFi sources are configured)
    try:
        from backend.unifi_poller import unifi_polling_loop
        unifi_task = asyncio.create_task(unifi_polling_loop())
    except Exception:
        logger.exception("Failed to start UniFi polling loop")
        unifi_task = None

    yield

    broadcast_task.cancel()
    offline_task.cancel()
    network_task.cancel()
    if unifi_task:
        unifi_task.cancel()
    if syslog_transport:
        syslog_transport.close()
        logger.info("Syslog listener closed")
    logger.info("Shutdown complete")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(alerts.router)
app.include_router(sources.router)
app.include_router(stats.router)
app.include_router(rules.router)
app.include_router(ingest.router)
app.include_router(notifications.router)
app.include_router(notification_settings.router)
app.include_router(maintenance.router)
app.include_router(network.router)
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

    from backend.models import Source
    from sqlalchemy import select, func
    sources_online = 0
    sources_total  = 0
    try:
        async with AsyncSessionLocal() as db:
            sources_total  = (await db.execute(select(func.count()).select_from(Source))).scalar_one()
            sources_online = (await db.execute(
                select(func.count()).select_from(Source).where(Source.status == "online")
            )).scalar_one()
    except Exception:
        pass

    from backend.maintenance import maintenance
    return {
        "status": "ok" if db_ok else "degraded",
        "app":    settings.APP_NAME,
        "db":     "ok" if db_ok else "error",
        "ws_connections": ws_manager.connection_count,
        "sources_online": sources_online,
        "sources_total":  sources_total,
        "maintenance":    maintenance.status(),
    }
