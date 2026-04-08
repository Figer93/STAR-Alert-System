"""
UniFi Network Controller background poller.

Discovers all enabled sources with adapter='unifi' from the database and
polls each controller on its configured interval.  For every source a
UniFiSourcePoller instance is kept alive so authentication cookies and
state-tracking (device states, seen event IDs) persist across poll cycles.

Monitored data:
  • Devices      — state transitions (connected ↔ disconnected / heartbeat missed)
  • Events log   — all event keys from the controller event stream
  • Alarms       — active (non-archived) alarms

Configuration keys stored in source.config (JSON):
  controller_url   str   https://192.168.1.1:8443
  username         str   view-only account username
  password         str   view-only account password
  site             str   "default" (or custom site name)
  is_unifios       bool  True for UDM / UDM-Pro / Dream Router (changes API paths)
  verify_ssl       bool  False to skip TLS certificate verification (typical for
                         self-signed certs on home controllers)
  poll_interval    int   Seconds between polls (default: 60)
  monitor_devices  bool  Track device offline / online transitions (default: True)
  monitor_events   bool  Ingest controller event log (default: True)
  monitor_alarms   bool  Ingest active alarms (default: True)
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import time
from datetime import datetime, timezone
from typing import Optional

import aiohttp

from backend.adapters.unifi_adapter import (
    UniFiAdapter,
    RESOLUTION_EVENT_KEYS,
    DEVICE_TYPE_LABELS,
)
from backend.schemas import RawAlert

logger = logging.getLogger(__name__)

# Device states considered "offline"
_OFFLINE_STATES: frozenset[int] = frozenset({0, 6})  # 0=disconnected, 6=heartbeat_missed
# States where a device is intentionally unavailable — don't alert
_TRANSIENT_STATES: frozenset[int] = frozenset({4, 5})  # 4=upgrading, 5=provisioning


class LoginFailedError(Exception):
    """Raised by fetch() when the UniFi controller login is unavailable.
    _run_poll_cycle catches this to skip the DB commit entirely."""


class UniFiSourcePoller:
    """
    Manages authentication and in-memory poll state for one UniFi source.

    Created once per source slug; lives for the lifetime of the process (or
    until the source is disabled/deleted).
    """

    def __init__(self, source_slug: str, config: dict) -> None:
        self.slug   = source_slug
        self.config = config

        self._session: Optional[aiohttp.ClientSession] = None
        self._authenticated: bool = False

        # Per-device last-known state (mac → UniFi state int)
        self._device_states: dict[str, int] = {}
        # First-poll flag: on the very first cycle we only record states, we
        # don't alert on already-offline devices to avoid a storm on startup.
        self._first_device_poll: bool = True

        # Event / alarm IDs seen this session (avoid re-processing)
        self._event_ids_seen:  set[str] = set()
        self._alarm_ids_seen:  set[str] = set()

        self._last_poll_ts: float = 0.0
        self._consecutive_failures: int = 0

        # Login-specific backoff — independent of poll-cycle failures.
        # _login_failures counts consecutive auth errors (HTTP or network).
        # _login_backoff_until is a monotonic timestamp; login is skipped until
        # this time passes.  Both reset to 0 on a successful authentication.
        self._login_failures: int = 0
        self._login_backoff_until: float = 0.0
        # Set to True inside _login() on any failure; read by fetch() to decide
        # whether to raise LoginFailedError and skip the DB commit.
        self._auth_failed_this_cycle: bool = False

    # ── Config helpers ────────────────────────────────────────────────────────

    @property
    def _controller_url(self) -> str:
        return self.config.get("controller_url", "").rstrip("/")

    @property
    def _api_root(self) -> str:
        if self.config.get("is_unifios", False):
            return f"{self._controller_url}/proxy/network"
        return self._controller_url

    @property
    def _site(self) -> str:
        return self.config.get("site", "default")

    @property
    def _api_prefix(self) -> str:
        return f"{self._api_root}/api/s/{self._site}"

    @property
    def _poll_interval(self) -> int:
        base = max(10, int(self.config.get("poll_interval", 60)))
        # Exponential backoff after consecutive failures (cap at 10 minutes)
        if self._consecutive_failures > 0:
            backoff = min(base * (2 ** (self._consecutive_failures - 1)), 600)
            return int(backoff)
        return base

    def _ssl_context(self) -> Optional[ssl.SSLContext]:
        if not self.config.get("verify_ssl", False):
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            return ctx
        return None

    # ── Session management ────────────────────────────────────────────────────

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            connector = aiohttp.TCPConnector(ssl=self._ssl_context())
            self._session = aiohttp.ClientSession(connector=connector)
            self._authenticated = False
        return self._session

    async def _login(self) -> bool:
        # Backoff gate — don't even send a request until the window clears.
        if time.monotonic() < self._login_backoff_until:
            self._auth_failed_this_cycle = True
            return False

        session = await self._get_session()

        login_url = (
            f"{self._controller_url}/api/auth/login"
            if self.config.get("is_unifios", False)
            else f"{self._controller_url}/api/login"
        )

        payload = {
            "username": self.config.get("username", ""),
            "password": self.config.get("password", ""),
        }

        try:
            async with session.post(
                login_url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status in (200, 201):
                    self._authenticated = True
                    self._login_failures = 0
                    self._login_backoff_until = 0.0
                    logger.info("UniFi [%s]: authenticated to %s", self.slug, self._controller_url)
                    return True
                body = await resp.text()
                self._login_failures += 1
                self._auth_failed_this_cycle = True
                delay = min(30 * (2 ** (self._login_failures - 1)), 300)
                self._login_backoff_until = time.monotonic() + delay
                logger.warning(
                    "UniFi [%s]: login failed (HTTP %d) — backoff %.0fs (failure #%d): %s",
                    self.slug, resp.status, delay, self._login_failures, body[:200],
                )
                return False
        except Exception as exc:
            self._login_failures += 1
            self._auth_failed_this_cycle = True
            delay = min(30 * (2 ** (self._login_failures - 1)), 300)
            self._login_backoff_until = time.monotonic() + delay
            if self._login_failures <= 2:
                logger.warning(
                    "UniFi [%s]: login error — backoff %.0fs — %s",
                    self.slug, delay, exc,
                )
            else:
                logger.debug(
                    "UniFi [%s]: login error (failure #%d, backoff %.0fs) — %s",
                    self.slug, self._login_failures, delay, exc,
                )
            return False

    async def _get(self, path: str) -> Optional[list[dict]]:
        """
        Authenticated GET to the UniFi API.  Retries once after re-auth on 401.
        Returns the ``data`` list from the JSON envelope, or None on failure.
        """
        session = await self._get_session()
        url = f"{self._api_prefix}{path}"

        for attempt in range(2):
            if not self._authenticated:
                if not await self._login():
                    return None

            try:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    if resp.status == 401:
                        self._authenticated = False
                        continue  # retry after re-auth
                    if resp.status != 200:
                        logger.warning(
                            "UniFi [%s]: GET %s returned HTTP %d",
                            self.slug, path, resp.status,
                        )
                        return None
                    data = await resp.json(content_type=None)
                    return data.get("data", [])
            except asyncio.TimeoutError:
                logger.warning("UniFi [%s]: GET %s timed out", self.slug, path)
                return None
            except Exception as exc:
                logger.warning("UniFi [%s]: GET %s error — %s", self.slug, path, exc)
                return None

        return None

    # ── Poll cycle ────────────────────────────────────────────────────────────

    async def fetch(self) -> list[RawAlert]:
        """
        Phase 1 — HTTP only.  Calls the UniFi controller and returns raw alerts.
        No DB session is held during this phase; network I/O can take up to 60 s.

        Raises LoginFailedError if authentication is unavailable (including when
        still within the exponential-backoff window).  _run_poll_cycle catches
        this to skip the DB commit entirely for the cycle.
        """
        self._auth_failed_this_cycle = False
        raw_alerts: list[RawAlert] = []

        if self.config.get("monitor_devices", True):
            raw_alerts.extend(await self._poll_devices())

        if self.config.get("monitor_events", True):
            raw_alerts.extend(await self._poll_events())

        if self.config.get("monitor_alarms", True):
            raw_alerts.extend(await self._poll_alarms())

        if self._auth_failed_this_cycle:
            raise LoginFailedError(self.slug)

        return raw_alerts

    async def commit(self, raw_alerts: list[RawAlert], db) -> None:
        """
        Phase 2 — DB only.  Writes collected alerts and the heartbeat.
        The session passed in should be opened immediately before this call
        so it is held for the minimum possible duration.
        """
        if raw_alerts:
            from backend.alert_engine import process_alert
            for raw in raw_alerts:
                try:
                    await process_alert(raw, db)
                except Exception:
                    logger.exception("UniFi [%s]: error processing alert", self.slug)

        self._last_poll_ts = time.monotonic()
        await self._update_heartbeat(db)

    async def poll(self, db) -> None:
        """Convenience wrapper — fetch then commit using an already-open session."""
        raw_alerts = await self.fetch()
        await self.commit(raw_alerts, db)

    # ── Device polling ────────────────────────────────────────────────────────

    async def _poll_devices(self) -> list[RawAlert]:
        devices = await self._get("/stat/device")
        if devices is None:
            return []

        alerts: list[RawAlert] = []

        for device in devices:
            mac   = device.get("mac", "")
            state = device.get("state", 0)
            name  = device.get("name") or device.get("hostname") or mac
            model = device.get("model", "")
            dtype = DEVICE_TYPE_LABELS.get(device.get("type", ""), device.get("type", "Device"))
            ip    = device.get("ip", "")

            if not mac:
                continue

            prev_state = self._device_states.get(mac)
            self._device_states[mac] = state

            if prev_state is None:
                # First time we've seen this device — record state, optionally alert
                if not self._first_device_poll and state in _OFFLINE_STATES:
                    alerts.append(self._offline_alert(name, mac, model, dtype, ip, state, device))
                continue

            # Skip purely transient states (firmware upgrade, provisioning)
            if state in _TRANSIENT_STATES:
                continue

            if prev_state not in _OFFLINE_STATES and state in _OFFLINE_STATES:
                # Online → offline
                alerts.append(self._offline_alert(name, mac, model, dtype, ip, state, device))

            elif prev_state in _OFFLINE_STATES and state == 1:
                # Offline → online (resolves existing alert)
                alerts.append(RawAlert(
                    source_slug=self.slug,
                    event_type="device_online",
                    title=f"{name} — Back Online",
                    message=(
                        f"{dtype} '{name}' ({model}) is back online."
                        + (f" IP: {ip}" if ip else "")
                    ),
                    severity="ok",
                    fingerprint_key=f"{name}:device_offline",
                    raw_payload={"mac": mac, "name": name, "model": model, "state": state, "ip": ip},
                ))

        self._first_device_poll = False
        return alerts

    def _offline_alert(
        self,
        name: str,
        mac: str,
        model: str,
        dtype: str,
        ip: str,
        state: int,
        raw: dict,
    ) -> RawAlert:
        state_label = "Disconnected" if state == 0 else "Heartbeat Missed"
        return RawAlert(
            source_slug=self.slug,
            event_type="device_offline",
            title=f"{name} — {state_label}",
            message=(
                f"{dtype} '{name}' ({model}) is {state_label.lower()}."
                + (f" IP: {ip}" if ip else "")
                + f" MAC: {mac}"
            ),
            severity="critical",
            fingerprint_key=f"{name}:device_offline",
            raw_payload=raw,
        )

    # ── Event log polling ─────────────────────────────────────────────────────

    async def _poll_events(self) -> list[RawAlert]:
        """Fetch the last 2 hours of controller events and ingest new ones."""
        events = await self._get("/stat/event?within=2")
        if not events:
            return []

        alerts: list[RawAlert] = []
        adapter = UniFiAdapter()
        adapter.source_slug = self.slug
        new_event_ids: set[str] = set()

        for event in events:
            eid = event.get("_id", "")
            if eid and eid in self._event_ids_seen:
                continue

            key = event.get("key", "")
            if not key:
                continue

            # Device online/offline transitions are handled by device poller
            if key in RESOLUTION_EVENT_KEYS or key in {
                "EVT_AP_Disconnected", "EVT_SW_Disconnected", "EVT_GW_Disconnected",
                "EVT_AP_LostContact", "EVT_SW_LostContact",
            }:
                if eid:
                    new_event_ids.add(eid)
                continue

            if eid:
                new_event_ids.add(eid)

            try:
                # Enrich payload with best available device name
                enriched = dict(event)
                enriched.setdefault("device",
                    event.get("hostname") or event.get("ap") or event.get("sw") or event.get("gw") or "Unknown"
                )
                raw = adapter.parse(enriched)
                alerts.append(raw)
            except Exception:
                logger.exception("UniFi [%s]: error parsing event %s", self.slug, eid)

        # Persist seen IDs (cap at 2 000 to prevent unbounded growth)
        self._event_ids_seen.update(new_event_ids)
        if len(self._event_ids_seen) > 2000:
            self._event_ids_seen = set(list(self._event_ids_seen)[-1000:])

        return alerts

    # ── Alarm polling ─────────────────────────────────────────────────────────

    async def _poll_alarms(self) -> list[RawAlert]:
        """Fetch active (non-archived) alarms and ingest new ones."""
        alarms = await self._get("/stat/alarm?archived=false")
        if not alarms:
            return []

        alerts: list[RawAlert] = []
        adapter = UniFiAdapter()
        adapter.source_slug = self.slug

        for alarm in alarms:
            aid = alarm.get("_id", "")
            if aid and aid in self._alarm_ids_seen:
                continue
            if aid:
                self._alarm_ids_seen.add(aid)

            try:
                enriched = dict(alarm)
                enriched.setdefault("device",
                    alarm.get("hostname") or alarm.get("ap") or alarm.get("sw") or "Unknown"
                )
                enriched.setdefault("key", "unifi_alarm")
                raw = adapter.parse(enriched)
                alerts.append(raw)
            except Exception:
                logger.exception("UniFi [%s]: error parsing alarm %s", self.slug, aid)

        return alerts

    # ── Heartbeat ─────────────────────────────────────────────────────────────

    async def _update_heartbeat(self, db) -> None:
        from sqlalchemy import update as sa_update
        from backend.models import Source

        try:
            await db.execute(
                sa_update(Source)
                .where(Source.slug == self.slug)
                .values(last_seen=datetime.now(timezone.utc), status="online")
            )
            await db.commit()
        except Exception:
            logger.exception("UniFi [%s]: heartbeat update failed", self.slug)

    # ── Cleanup ───────────────────────────────────────────────────────────────

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        logger.info("UniFi [%s]: poller closed", self.slug)


# ── Global poller registry ────────────────────────────────────────────────────

_pollers: dict[str, UniFiSourcePoller] = {}


async def _run_poll_cycle(slug: str, poller: UniFiSourcePoller) -> None:
    """
    Run one poll cycle for a source.

    The DB session is intentionally NOT open during the HTTP fetch phase so
    that slow or unresponsive UniFi controllers cannot exhaust the connection
    pool — connections are only checked out for the fast DB-write phase.

    LoginFailedError is handled separately from other exceptions:
      • _last_poll_ts is updated so the loop doesn't hammer a failing controller
        every 10 s while the backoff window runs.
      • No DB session is opened — nothing to commit.
      • _consecutive_failures is not incremented (the login backoff handles pacing).
    """
    try:
        # Phase 1: HTTP requests to UniFi controller (no DB connection held)
        raw_alerts = await poller.fetch()

        # Phase 2: DB writes only — session opened as late as possible
        from backend.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            await poller.commit(raw_alerts, db)

        poller._consecutive_failures = 0

    except LoginFailedError:
        # Auth is unavailable — backoff is already tracked inside _login().
        # Update _last_poll_ts so we don't re-trigger on every 10s loop tick.
        poller._last_poll_ts = time.monotonic()
        logger.debug("UniFi [%s]: poll cycle skipped — login unavailable (backoff active)", slug)

    except Exception:
        poller._consecutive_failures += 1
        logger.exception("UniFi [%s]: poll cycle error", slug)


async def unifi_polling_loop() -> None:
    """
    Long-running background task.

    Wakes every 10 s to fire off due poll cycles.  Source configs are refreshed
    from the DB at most once every 60 s (reconciliation interval) so that a DB
    session is not checked out on every tick — the previous bug was opening a
    connection every 10 s regardless of whether login was failing.
    """
    logger.info("UniFi polling loop started")

    _RECONCILE_INTERVAL = 60  # seconds between DB config reads
    _last_reconcile_ts: float = 0.0
    # Cached config from the last DB read; kept between reconciliations.
    _slug_to_config: dict[str, dict] = {}

    while True:
        now = time.monotonic()

        # ── Reconciliation (DB) — at most once per 60 s ───────────────────────
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
                    # Extract plain values before session closes
                    fetched: list[tuple[str, dict]] = [
                        (src.slug, dict(src.config or {})) for src in sources
                    ]
                # Session released here

                active_slugs: set[str] = {slug for slug, _ in fetched}
                _slug_to_config = {slug: cfg for slug, cfg in fetched}

                # Start pollers for new sources
                for slug, cfg in _slug_to_config.items():
                    if slug not in _pollers:
                        logger.info("UniFi: registering poller for source '%s'", slug)
                        _pollers[slug] = UniFiSourcePoller(slug, cfg)

                # Remove pollers for deleted / disabled sources
                for slug in list(_pollers.keys()):
                    if slug not in active_slugs:
                        logger.info("UniFi: removing poller for source '%s'", slug)
                        await _pollers[slug].close()
                        del _pollers[slug]

                _last_reconcile_ts = time.monotonic()

            except Exception:
                logger.exception("UniFi polling loop reconciliation error")

        # ── Poll trigger — every 10 s tick ────────────────────────────────────
        now = time.monotonic()
        for slug, poller in list(_pollers.items()):
            # Push any live config changes (e.g. updated password) to the poller
            if slug in _slug_to_config:
                poller.config = _slug_to_config[slug]
            interval = poller._poll_interval
            if now - poller._last_poll_ts >= interval:
                asyncio.create_task(_run_poll_cycle(slug, poller))

        await asyncio.sleep(10)
