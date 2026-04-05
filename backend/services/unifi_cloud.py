"""
UniFi Cloud API service.

Talks to https://api.ui.com using an API key (not the on-premise controller).
Retrieves host state and site statistics for the Dashboard overview.

Authentication: x-api-key header.
All methods return plain dicts — callers are responsible for shaping the
response into Pydantic models.

Reference: https://developer.ui.com/reference
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.ui.com"


class UniFiCloudService:
    """Thin async wrapper around the UniFi Cloud REST API."""

    BASE_URL = _BASE_URL

    def __init__(self, api_key: str, host_id: str, site_id: str) -> None:
        self._api_key = api_key
        self._host_id = host_id
        self._site_id = site_id

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "Accept": "application/json",
        }

    async def _get(self, path: str) -> dict[str, Any]:
        """Execute a GET request and return the parsed JSON body."""
        url = f"{self.BASE_URL}{path}"
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=self._headers(), timeout=timeout, ssl=True) as resp:
                if resp.status == 401:
                    raise PermissionError("UniFi Cloud API key is invalid or expired")
                if resp.status == 404:
                    raise LookupError(f"Resource not found: {path}")
                resp.raise_for_status()
                return await resp.json()  # type: ignore[no-any-return]

    # ── Public API methods ─────────────────────────────────────────────────────

    async def get_host_status(self) -> dict[str, Any]:
        """
        GET /v1/hosts/{host_id}

        Returns a normalised dict with:
            state                    "connected" | "disconnected"
            controller_version       str | None
            ip_addrs                 list[str]
            last_connection_change   str (ISO-8601) | None
            total_devices            int
            online_devices           int
            offline_devices          int
            wired_clients            int
            wifi_clients             int
        """
        raw = await self._get(f"/v1/hosts/{self._host_id}")
        host: dict[str, Any] = raw.get("data") or {}

        # The reportedState sub-object contains most of the useful metrics.
        reported: dict[str, Any] = host.get("reportedState") or {}

        total    = int(reported.get("totalDevice")       or 0)
        online   = int(reported.get("connectedDevice")   or 0)
        offline  = max(0, total - online)

        return {
            "state":                  host.get("state", "disconnected"),
            "controller_version":     reported.get("version"),
            "ip_addrs":               reported.get("ipAddrs") or [],
            "last_connection_change": reported.get("lastConnectionStateChange"),
            "total_devices":          total,
            "online_devices":         online,
            "offline_devices":        offline,
            "wired_clients":          int(reported.get("wiredClientCount")    or 0),
            "wifi_clients":           int(reported.get("wirelessClientCount") or 0),
        }

    async def get_site_stats(self) -> dict[str, Any]:
        """
        GET /v1/sites

        Filters by self._site_id and returns a normalised dict with:
            total_devices            int
            online_devices           int
            offline_devices          int
            wired_clients            int
            wifi_clients             int
            critical_notifications   int
        """
        raw = await self._get("/v1/sites")
        sites: list[dict[str, Any]] = raw.get("data") or []

        site: dict[str, Any] = {}
        for s in sites:
            if s.get("siteId") == self._site_id or s.get("meta", {}).get("hostId") == self._host_id:
                site = s
                break

        # If no matching site found, try the first one
        if not site and sites:
            site = sites[0]
            logger.debug(
                "UniFi Cloud: site_id %s not matched; using first site (%s)",
                self._site_id,
                site.get("siteId"),
            )

        counts: dict[str, Any] = (site.get("statistics") or {}).get("counts") or {}

        return {
            "total_devices":          int(counts.get("totalDevice")          or 0),
            "online_devices":         int(counts.get("onlineDevice")         or 0),
            "offline_devices":        int(counts.get("offlineDevice")        or 0),
            "wired_clients":          int(counts.get("wiredClient")          or 0),
            "wifi_clients":           int(counts.get("wifiClient")           or 0),
            "critical_notifications": int(counts.get("criticalNotification") or 0),
        }

    async def get_status(self) -> dict[str, Any]:
        """
        Calls get_host_status() and get_site_stats() concurrently and merges
        the results into the shape expected by the /unifi-cloud-status endpoint.

        Falls back gracefully if one call succeeds and the other fails — the
        site stats from get_host_status() are used when get_site_stats() errors.
        """
        import asyncio

        host_task = asyncio.create_task(self.get_host_status())
        site_task = asyncio.create_task(self.get_site_stats())

        host_err: Exception | None = None
        site_err: Exception | None = None

        try:
            host = await host_task
        except Exception as exc:
            host_err = exc
            host = {}

        try:
            site = await site_task
        except Exception as exc:
            site_err = exc
            site = {}

        if host_err and site_err:
            raise host_err  # re-raise so callers see the real failure

        # Prefer site-level counts when available; fall back to host-level.
        site_stats = {
            "total_devices":          site.get("total_devices")          or host.get("total_devices",  0),
            "online_devices":         site.get("online_devices")         or host.get("online_devices", 0),
            "offline_devices":        site.get("offline_devices")        or host.get("offline_devices", 0),
            "wired_clients":          site.get("wired_clients")          or host.get("wired_clients",  0),
            "wifi_clients":           site.get("wifi_clients")           or host.get("wifi_clients",   0),
            "critical_notifications": site.get("critical_notifications", 0),
        }

        # controller_state reflects whether the hardware gateway has an active
        # cloud tunnel — it can be "disconnected" even when the API is fully
        # functional and returning real device/client data.  Use the presence of
        # real device data as the authoritative "are we connected?" signal.
        api_has_data = int(site_stats.get("total_devices") or 0) > 0
        connected    = api_has_data or host.get("state") == "connected"

        return {
            "connected":          connected,
            "controller_version": host.get("controller_version"),
            "controller_state":   host.get("state", "disconnected"),
            "last_seen":          host.get("last_connection_change"),
            "site_stats":         site_stats,
        }
