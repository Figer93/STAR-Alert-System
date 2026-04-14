"""
UniFi background reconciliation loop — Railway backend.

Outbound HTTP polling to the UniFi controller is DISABLED on this service.
All controller data (switch_port_metrics, device_registry, latency_metrics)
is written directly to Supabase by the on-premise Docker collector.

This loop:
  1. Reads enabled UniFi sources from the database every 60 s and logs their
     presence so the source list stays accurate in the UI.  No outbound HTTP.
  2. Marks device_registry rows as offline (is_online=false) when last_seen
     is older than 10 minutes — safety net on top of network_monitor's 5-min
     staleness check.
  3. Once per day, deletes device_registry rows not seen in the last 30 days.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

_RECONCILE_INTERVAL   = 60    # seconds between reconcile cycles
_DEVICE_STALE_MINUTES = 10    # mark is_online=false after this many minutes without last_seen update
_CLEANUP_DAYS         = 30    # delete device_registry rows older than this
_CLEANUP_INTERVAL     = 86_400  # run cleanup once per day (seconds)


async def unifi_polling_loop() -> None:
    """
    Long-running background task.

    Wakes every 60 s to:
      - Read enabled UniFi sources from the database and log them.
      - Mark stale devices (last_seen > 10 min) as offline.
      - Once per day: delete device_registry rows unseen for 30+ days.
    """
    logger.info(
        "UniFi polling disabled on backend — data expected from local collector"
    )

    _last_reconcile_ts: float = 0.0
    _last_cleanup_ts:   float = 0.0

    while True:
        now = time.monotonic()

        if now - _last_reconcile_ts >= _RECONCILE_INTERVAL:
            try:
                from sqlalchemy import select, text
                from backend.database import AsyncSessionLocal
                from backend.models import Source

                async with AsyncSessionLocal() as db:
                    # 1. Log enabled UniFi sources
                    result = await db.execute(
                        select(Source)
                        .where(Source.adapter == "unifi")
                        .where(Source.enabled == True)  # noqa: E712
                    )
                    sources = result.scalars().all()
                    slugs = [src.slug for src in sources]

                    if slugs:
                        logger.debug("UniFi sources registered (polled by collector): %s", slugs)
                    else:
                        logger.debug("No enabled UniFi sources found in database")

                    # 2. Mark stale devices offline
                    stale_result = await db.execute(text(f"""
                        UPDATE device_registry
                           SET is_online = false
                         WHERE is_online = true
                           AND last_seen < NOW() - INTERVAL '{_DEVICE_STALE_MINUTES} minutes'
                           AND NOT (ip::text LIKE '169.254.%%')
                    """))
                    stale_count = stale_result.rowcount
                    if stale_count:
                        logger.info(
                            "Marked %d stale device(s) offline (last_seen > %d min)",
                            stale_count, _DEVICE_STALE_MINUTES,
                        )

                    await db.commit()

                _last_reconcile_ts = time.monotonic()

            except Exception:
                logger.exception("UniFi reconciliation error")

        # 3. Daily cleanup: remove rows unseen for 30+ days
        if now - _last_cleanup_ts >= _CLEANUP_INTERVAL:
            try:
                from sqlalchemy import text
                from backend.database import AsyncSessionLocal

                async with AsyncSessionLocal() as db:
                    del_result = await db.execute(text(f"""
                        DELETE FROM device_registry
                         WHERE last_seen < NOW() - INTERVAL '{_CLEANUP_DAYS} days'
                    """))
                    del_count = del_result.rowcount
                    if del_count:
                        logger.info(
                            "Cleanup: deleted %d device_registry row(s) unseen for >%d days",
                            del_count, _CLEANUP_DAYS,
                        )
                    await db.commit()

                _last_cleanup_ts = time.monotonic()

            except Exception:
                logger.exception("UniFi cleanup error")

        await asyncio.sleep(_RECONCILE_INTERVAL)
