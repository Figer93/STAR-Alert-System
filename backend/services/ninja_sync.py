"""
NinjaRMM sync service.

Authenticates via OAuth2 client credentials and periodically enriches
device_registry rows with data from the NinjaRMM /v2/devices-detailed endpoint.

Matching is performed on hostname (case-insensitive). Columns updated:
  ninja_id, os_name, last_logged_in_user, serial, ninja_online, disk_free_pct

Requires env vars: NINJA_CLIENT_ID, NINJA_CLIENT_SECRET
Optional env var:  NINJA_BASE_URL (default: https://eu.ninjarmm.com)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

_BASE_URL    = os.getenv("NINJA_BASE_URL", "https://eu.ninjarmm.com")
_TOKEN_URL   = f"{_BASE_URL}/ws/oauth/token"
_DEVICES_URL = f"{_BASE_URL}/v2/devices-detailed"
_INTERVAL    = 600  # 10 minutes


class _TokenCache:
    """Holds a cached access token and refreshes it when near-expiry."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._expires_at: float = 0.0

    async def get(self, client_id: str, client_secret: str) -> str:
        if self._token and time.monotonic() < self._expires_at - 60:
            return self._token
        return await self._fetch(client_id, client_secret)

    async def _fetch(self, client_id: str, client_secret: str) -> str:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                _TOKEN_URL,
                data={
                    "grant_type":    "client_credentials",
                    "client_id":     client_id,
                    "client_secret": client_secret,
                    "scope":         "monitoring",
                },
                timeout=timeout,
                ssl=True,
            ) as resp:
                if resp.status == 401:
                    raise PermissionError("NinjaRMM: invalid client credentials")
                resp.raise_for_status()
                body = await resp.json()

        self._token     = body["access_token"]
        self._expires_at = time.monotonic() + int(body.get("expires_in", 3600))
        logger.debug("NinjaRMM: token refreshed, expires in %ds", body.get("expires_in", 3600))
        return self._token  # type: ignore[return-value]


_token_cache = _TokenCache()


def _lowest_disk_free_pct(device: dict[str, Any]) -> float | None:
    """Return the lowest free-disk percentage across all volumes, or None."""
    volumes: list[dict[str, Any]] = []
    try:
        volumes = (
            device.get("volumes")
            or device.get("disks")
            or device.get("system", {}).get("volumes", [])
            or []
        )
    except Exception:
        return None

    pcts: list[float] = []
    for vol in volumes:
        try:
            free  = float(vol.get("freeSpace") or vol.get("free_space") or 0)
            total = float(vol.get("capacity") or vol.get("size") or 0)
            if total > 0:
                pcts.append(free / total * 100)
        except (TypeError, ValueError):
            continue
    return min(pcts) if pcts else None


async def _fetch_devices(token: str) -> list[dict[str, Any]]:
    timeout = aiohttp.ClientTimeout(total=30)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept":        "application/json",
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(_DEVICES_URL, headers=headers, timeout=timeout, ssl=True) as resp:
            if resp.status == 401:
                raise PermissionError("NinjaRMM: token rejected by devices endpoint")
            resp.raise_for_status()
            return await resp.json()  # type: ignore[return-value]


async def _sync_once(client_id: str, client_secret: str) -> None:
    from backend.database import engine
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    token   = await _token_cache.get(client_id, client_secret)
    devices = await _fetch_devices(token)
    logger.info("NinjaRMM: fetched %d devices", len(devices))

    updated = 0
    async with AsyncSession(engine) as session:
        async with session.begin():
            for dev in devices:
                try:
                    hostname: str | None = (
                        dev.get("dnsName")
                        or dev.get("systemName")
                        or dev.get("hostname")
                    )
                    if not hostname:
                        continue

                    # Strip domain suffix so "pc01.corp.local" matches "pc01"
                    short_hostname = hostname.split(".")[0].lower()

                    ninja_id    = dev.get("id")
                    os_name     = (dev.get("os") or {}).get("name") or dev.get("operatingSystem")
                    last_user   = (
                        dev.get("lastLoggedInUser")
                        or dev.get("last_logged_in_user")
                        or (dev.get("system") or {}).get("lastLoggedInUser")
                    )
                    serial      = (
                        dev.get("serialNumber")
                        or dev.get("serial")
                        or (dev.get("system") or {}).get("serialNumber")
                    )
                    ninja_online_raw = dev.get("online") or dev.get("nodeOnlineStatus")
                    if isinstance(ninja_online_raw, str):
                        ninja_online: bool | None = ninja_online_raw.upper() == "ONLINE"
                    elif isinstance(ninja_online_raw, bool):
                        ninja_online = ninja_online_raw
                    else:
                        ninja_online = None

                    disk_free_pct = _lowest_disk_free_pct(dev)

                    result = await session.execute(
                        text("""
                            UPDATE device_registry
                            SET
                                ninja_id             = :ninja_id,
                                os_name              = COALESCE(:os_name, os_name),
                                last_logged_in_user  = COALESCE(:last_user, last_logged_in_user),
                                serial               = COALESCE(:serial, serial),
                                ninja_online         = :ninja_online,
                                disk_free_pct        = :disk_free_pct
                            WHERE LOWER(hostname) = :hostname
                               OR LOWER(SPLIT_PART(hostname, '.', 1)) = :hostname
                        """),
                        {
                            "ninja_id":      ninja_id,
                            "os_name":       os_name,
                            "last_user":     last_user,
                            "serial":        serial,
                            "ninja_online":  ninja_online,
                            "disk_free_pct": disk_free_pct,
                            "hostname":      short_hostname,
                        },
                    )
                    updated += result.rowcount
                except Exception:
                    logger.exception("NinjaRMM: error processing device %s", dev.get("id"))

    logger.info("NinjaRMM: sync complete, updated %d device_registry rows", updated)


async def ninja_sync_loop() -> None:
    """Background task: sync NinjaRMM data every 10 minutes."""
    client_id     = os.getenv("NINJA_CLIENT_ID")
    client_secret = os.getenv("NINJA_CLIENT_SECRET")

    if not client_id or not client_secret:
        logger.info("NinjaRMM: NINJA_CLIENT_ID / NINJA_CLIENT_SECRET not set — sync disabled")
        return

    logger.info("NinjaRMM: starting sync loop (interval=%ds)", _INTERVAL)
    while True:
        try:
            await _sync_once(client_id, client_secret)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("NinjaRMM: sync error (will retry next cycle)")
        await asyncio.sleep(_INTERVAL)
