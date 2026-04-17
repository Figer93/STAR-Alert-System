# v1.1.5 — Network Monitor (latency overhaul + logging fix)
import asyncio
import json
import logging
import logging.handlers
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.database import init_db
from backend.network_monitor import run_network_checks, run_maintenance_loop
from backend.routers import ad, alerts, collector, ingest, m365, maintenance, network, ninja, notifications, notification_settings, rules, sources, stats, system, ws
from backend.websocket_manager import ws_manager

# ── Logging ───────────────────────────────────────────────────────────────────

log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)


class _RailwayJsonFormatter(logging.Formatter):
    """
    Emit each log record as a single-line JSON object with an explicit
    'severity' field that Railway / GCP Cloud Logging reads directly.

    Without this, GCP's plain-text auto-detection misclassifies any INFO
    message whose text contains the word 'error' (e.g. 'Interface error
    resolved', 'Retention cleanup error') as ERROR severity.  Setting the
    severity field explicitly from the Python log level prevents that mapping.
    """

    _LEVEL_MAP: dict[int, str] = {
        logging.DEBUG:    "DEBUG",
        logging.INFO:     "INFO",
        logging.WARNING:  "WARNING",
        logging.ERROR:    "ERROR",
        logging.CRITICAL: "CRITICAL",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "severity": self._LEVEL_MAP.get(record.levelno, "DEFAULT"),
            "message":  record.getMessage(),
            "logger":   record.name,
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


_plain_fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_log_level  = logging.DEBUG if settings.DEBUG else logging.INFO

# StreamHandler — JSON for Railway/GCP; plain text in debug (local dev)
_stream_handler = logging.StreamHandler()
if settings.DEBUG:
    _stream_handler.setFormatter(logging.Formatter(_plain_fmt))
else:
    _stream_handler.setFormatter(_RailwayJsonFormatter())

logging.basicConfig(
    level=_log_level,
    handlers=[
        _stream_handler,
        logging.handlers.RotatingFileHandler(
            log_dir / "app.log",
            maxBytes=10 * 1024 * 1024,  # 10 MB
            backupCount=5,
            encoding="utf-8",
        ),
    ],
)
# File handler always uses plain text for human-readable log files
logging.root.handlers[1].setFormatter(logging.Formatter(_plain_fmt))

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

    Each stale source is processed in its own short-lived DB session so that
    slow notification work (Telegram, email) inside process_alert cannot hold
    a connection idle for an extended period.
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

            # ── Phase 1: identify stale sources — short-lived read session ────
            stmt = (
                select(Source)
                .where(Source.enabled == True)  # noqa: E712
                .where(Source.type != "webhook")
                .where(Source.status == "online")
                .where(Source.last_seen < cutoff)
            )
            async with AsyncSessionLocal() as db:
                stale_sources = (await db.execute(stmt)).scalars().all()
                # Capture everything we need as plain values before closing session
                stale_data = [
                    {
                        "id":       s.id,
                        "slug":     s.slug,
                        "name":     s.name,
                        "last_seen": s.last_seen,
                    }
                    for s in stale_sources
                ]
            # Session released here — DB connection returned to pool

            # ── Phase 2: process each source in its own session ───────────────
            # process_alert may trigger Telegram/email; keep sessions short.
            for src in stale_data:
                try:
                    async with AsyncSessionLocal() as db:
                        # Re-fetch to get a managed ORM instance for the update
                        source = (await db.get(Source, src["id"]))
                        if source is None or source.status != "online":
                            continue  # already handled by another process

                        logger.warning(
                            "Source '%s' has not been seen since %s — marking offline",
                            source.slug, source.last_seen,
                        )
                        source.status = "offline"
                        await db.commit()

                        await ws_manager.broadcast(
                            "source.status_change",
                            {"id": source.id, "slug": source.slug, "status": "offline"},
                        )

                        last_seen_str = (
                            src["last_seen"].strftime("%H:%M:%S UTC")
                            if src["last_seen"] else "never"
                        )
                        raw = RawAlert(
                            source_slug=source.slug,
                            event_type="source_offline",
                            title=f"{source.name} went offline",
                            message=(
                                f"No heartbeat received from {source.name} for "
                                f"over {OFFLINE_THRESHOLD_MINUTES} minutes. "
                                f"Last seen: {last_seen_str}."
                            ),
                            severity="critical",
                            fingerprint_key=f"source_offline:{source.slug}",
                            raw_payload={
                                "source_slug": source.slug,
                                "event": "source_offline",
                                "last_seen": (
                                    src["last_seen"].isoformat()
                                    if src["last_seen"] else None
                                ),
                            },
                        )
                        await process_alert(raw, db)
                except Exception:
                    logger.exception("Source offline checker error for '%s'", src.get("slug"))

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


async def _retention_cleanup():
    """
    Purge stale time-series rows on startup, then once every hour.

    Retention policy:
      latency_metrics      — keep 2 days
      switch_port_metrics  — keep 24 hours
      network_incidents    — keep 30 days (resolved only; open incidents are kept forever)
    """
    from sqlalchemy import text
    from backend.database import AsyncSessionLocal
    _IS_POSTGRES = "postgresql" in settings.DATABASE_URL

    async def _run_cleanup() -> None:
        if not _IS_POSTGRES:
            return
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(text(
                    "DELETE FROM latency_metrics WHERE time < NOW() - INTERVAL '2 days'"
                ))
                await db.execute(text(
                    "DELETE FROM switch_port_metrics WHERE time < NOW() - INTERVAL '24 hours'"
                ))
                await db.execute(text(
                    "DELETE FROM network_incidents "
                    "WHERE resolved_at IS NOT NULL "
                    "  AND started_at < NOW() - INTERVAL '30 days'"
                ))
                await db.commit()
            logger.info("Retention cleanup complete")
        except Exception:
            logger.exception("Retention cleanup error")

    # Run immediately on startup to clear any backlog, then hourly
    await _run_cleanup()
    while True:
        await asyncio.sleep(3_600)
        await _run_cleanup()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s...", settings.APP_NAME)
    await init_db()
    await _seed_channel_settings()
    logger.info("Database initialised")

    # Pre-warm caches before serving traffic
    try:
        from backend.routers.network import warm_switch_names_cache
        await warm_switch_names_cache()
    except Exception:
        logger.exception("Cache pre-warm failed")

    # pfSense UDP syslog listener
    syslog_transport = None
    try:
        from backend.adapters.syslog_listener import start_syslog_listener
        syslog_transport, _ = await start_syslog_listener()
    except Exception:
        logger.exception("Failed to start syslog listener")

    # Background tasks
    broadcast_task   = asyncio.create_task(_stats_broadcaster())
    offline_task     = asyncio.create_task(_source_offline_checker())
    network_task     = asyncio.create_task(run_network_checks())
    maintenance_task = asyncio.create_task(run_maintenance_loop())
    retention_task   = asyncio.create_task(_retention_cleanup())

    # UniFi polling loop (no-op if no UniFi sources are configured)
    try:
        from backend.unifi_poller import unifi_polling_loop
        unifi_task = asyncio.create_task(unifi_polling_loop())
    except Exception:
        logger.exception("Failed to start UniFi polling loop")
        unifi_task = None

    # NinjaRMM sync loop (no-op if NINJA_CLIENT_ID / NINJA_CLIENT_SECRET not set)
    try:
        from backend.services.ninja_sync import ninja_sync_loop
        ninja_task = asyncio.create_task(ninja_sync_loop())
    except Exception:
        logger.exception("Failed to start NinjaRMM sync loop")
        ninja_task = None

    # Azure AD sync loop (no-op if AZURE_* env vars not set)
    try:
        from backend.services.ad_monitor import ad_sync_loop
        ad_task = asyncio.create_task(ad_sync_loop())
    except Exception:
        logger.exception("Failed to start Azure AD sync loop")
        ad_task = None

    # M365 health sync loop (no-op if AZURE_* env vars not set)
    try:
        from backend.services.m365_monitor import m365_sync_loop
        m365_task = asyncio.create_task(m365_sync_loop())
    except Exception:
        logger.exception("Failed to start M365 sync loop")
        m365_task = None

    yield

    broadcast_task.cancel()
    offline_task.cancel()
    network_task.cancel()
    maintenance_task.cancel()
    retention_task.cancel()
    if unifi_task:
        unifi_task.cancel()
    if ninja_task:
        ninja_task.cancel()
    if ad_task:
        ad_task.cancel()
    if m365_task:
        m365_task.cancel()
    if syslog_transport:
        syslog_transport.close()
        logger.info("Syslog listener closed")

    # Return all pooled connections to PgBouncer cleanly.
    # Without this, Railway deploy restarts leave ghost connections that count
    # against Supabase's connection limit until PgBouncer times them out.
    from backend.database import engine
    await engine.dispose()
    logger.info("Database engine disposed")
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
app.include_router(collector.router)
app.include_router(sources.router)
app.include_router(stats.router)
app.include_router(rules.router)
app.include_router(ingest.router)
app.include_router(notifications.router)
app.include_router(notification_settings.router)
app.include_router(maintenance.router)
app.include_router(ad.router)
app.include_router(m365.router)
app.include_router(network.router)
app.include_router(ninja.router)
app.include_router(system.router)
app.include_router(ws.router)


@app.get("/health")
async def health():
    from sqlalchemy import text, select, func
    from backend.database import AsyncSessionLocal
    from backend.models import Source
    from backend.maintenance import maintenance

    db_ok          = False
    sources_online = 0
    sources_total  = 0

    # Single session for all health-check queries — Railway polls this every ~10 s
    # so opening two sessions here was doubling the connection churn needlessly.
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            db_ok = True
            sources_total  = (
                await db.execute(select(func.count()).select_from(Source))
            ).scalar_one()
            sources_online = (
                await db.execute(
                    select(func.count()).select_from(Source).where(Source.status == "online")
                )
            ).scalar_one()
    except Exception:
        pass

    return {
        "status": "ok" if db_ok else "degraded",
        "app":    settings.APP_NAME,
        "db":     "ok" if db_ok else "error",
        "ws_connections": ws_manager.connection_count,
        "sources_online": sources_online,
        "sources_total":  sources_total,
        "maintenance":    maintenance.status(),
    }
