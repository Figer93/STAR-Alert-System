"""
UniFi background reconciliation loop — Railway backend.

Outbound HTTP polling to the UniFi controller is DISABLED on this service.
All controller data (switch_port_metrics, device_registry, latency_metrics)
is written directly to Supabase by the on-premise Docker collector.

This loop only performs DB reconciliation: it reads enabled UniFi sources
from the database every 60 s and logs their presence so the source list
stays accurate in the UI.  It does not open any connections to UniFi.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

_RECONCILE_INTERVAL = 60  # seconds


async def unifi_polling_loop() -> None:
    """
    Long-running background task.

    Wakes every 60 s to read enabled UniFi sources from the database and log
    them.  No outbound HTTP calls are made — UniFi data arrives via the local
    collector writing directly to Supabase.
    """
    logger.info(
        "UniFi polling disabled on backend — data expected from local collector"
    )

    _last_reconcile_ts: float = 0.0

    while True:
        now = time.monotonic()

        if now - _last_reconcile_ts >= _RECONCILE_INTERVAL:
            try:
                from sqlalchemy import select
                from backend.database import AsyncSessionLocal
                from backend.models import Source

                async with AsyncSessionLocal() as db:
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

                _last_reconcile_ts = time.monotonic()

            except Exception:
                logger.exception("UniFi reconciliation error")

        await asyncio.sleep(_RECONCILE_INTERVAL)
