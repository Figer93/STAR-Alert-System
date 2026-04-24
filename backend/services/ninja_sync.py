"""
NinjaRMM sync service.

Authenticates via OAuth2 client credentials and periodically enriches
device_registry rows with data from the NinjaRMM /v2/devices-detailed endpoint.

Also syncs:
  - OS patch compliance  → device_patch_status table
  - Software inventory   → device_software table (per device)
  - Disk free history    → disk_history table (for trend charts)

Matching is performed on hostname (case-insensitive). Columns updated:
  ninja_id, os_name, last_logged_in_user, serial, ninja_online,
  disk_free_pct, last_reboot

Requires env vars: NINJA_CLIENT_ID, NINJA_CLIENT_SECRET
Optional env var:  NINJA_BASE_URL (default: https://eu.ninjarmm.com)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

_BASE_URL       = os.getenv("NINJA_BASE_URL", "https://eu.ninjarmm.com")
_TOKEN_URL      = f"{_BASE_URL}/ws/oauth/token"
_DEVICES_URL    = f"{_BASE_URL}/v2/devices-detailed"
_OS_PATCHES_URL      = f"{_BASE_URL}/v2/queries/os-patches"
_OS_PATCH_REPORT_URL = f"{_BASE_URL}/v2/queries/os-patch-report"
_INTERVAL            = 600  # 10 minutes


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

        self._token      = body["access_token"]
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


async def _fetch_os_patches(token: str) -> list[dict[str, Any]]:
    """
    Fetch all OS patch records from /v2/queries/os-patches.
    NinjaRMM paginates this endpoint with a cursor; we follow until exhausted.
    Each record represents one patch on one device.
    """
    timeout = aiohttp.ClientTimeout(total=60)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    all_patches: list[dict[str, Any]] = []
    cursor: str | None = None

    async with aiohttp.ClientSession() as http:
        while True:
            params: dict[str, Any] = {"pageSize": 1000}
            if cursor:
                params["cursor"] = cursor
            async with http.get(
                _OS_PATCHES_URL, headers=headers, params=params, timeout=timeout, ssl=True
            ) as resp:
                if resp.status == 401:
                    raise PermissionError("NinjaRMM: token rejected by os-patches endpoint")
                resp.raise_for_status()
                data = await resp.json()

            if isinstance(data, dict):
                results = data.get("results") or data.get("data") or []
                cursor   = data.get("cursor") or data.get("nextCursor")
            else:
                results = data or []
                cursor   = None

            all_patches.extend(results)
            if not cursor or not results:
                break

    return all_patches


async def _fetch_os_patch_report(token: str) -> list[dict[str, Any]]:
    """
    Fetch all records from /v2/queries/os-patch-report (pending/failed patches).
    Same cursor-pagination pattern as _fetch_os_patches.
    """
    timeout = aiohttp.ClientTimeout(total=60)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    all_records: list[dict[str, Any]] = []
    cursor: str | None = None

    async with aiohttp.ClientSession() as http:
        while True:
            params: dict[str, Any] = {"pageSize": 1000}
            if cursor:
                params["cursor"] = cursor
            async with http.get(
                _OS_PATCH_REPORT_URL, headers=headers, params=params, timeout=timeout, ssl=True
            ) as resp:
                if resp.status == 401:
                    raise PermissionError("NinjaRMM: token rejected by os-patch-report endpoint")
                resp.raise_for_status()
                data = await resp.json()

            if isinstance(data, dict):
                results = data.get("results") or data.get("data") or []
                cursor   = data.get("cursor") or data.get("nextCursor")
            else:
                results = data or []
                cursor   = None

            all_records.extend(results)
            if not cursor or not results:
                break

    return all_records


async def _fetch_device_software(token: str, ninja_id: int) -> list[dict[str, Any]]:
    url = f"{_BASE_URL}/v2/device/{ninja_id}/software"
    timeout = aiohttp.ClientTimeout(total=20)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept":        "application/json",
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, timeout=timeout, ssl=True) as resp:
            if resp.status == 404:
                return []
            resp.raise_for_status()
            data = await resp.json()
    if isinstance(data, dict):
        return data.get("results") or data.get("data") or []
    return data  # type: ignore[return-value]


# ── Sync helpers ──────────────────────────────────────────────────────────────

def _parse_ts(raw: Any) -> datetime | None:
    """
    Parse a NinjaRMM timestamp into a UTC datetime.

    NinjaRMM returns timestamps in epoch-seconds for most fields
    (lastReboot, lastContact, lastUpdated on patches, etc.).
    A small number of endpoints use epoch-milliseconds.

    Heuristic: values > 1e10 are treated as milliseconds (divide by 1000);
    values <= 1e10 are treated as seconds.  Current epoch is ~1.74e9 s /
    ~1.74e12 ms, so this correctly separates the two cases with wide margin.
    """
    if not raw:
        return None
    try:
        if isinstance(raw, (int, float)):
            ts = raw / 1000 if raw > 1e10 else raw
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


async def _sync_patch_status(
    token: str,
    session: Any,
    devices_by_id: dict[int, dict[str, Any]],
) -> None:
    """
    Fetch /v2/queries/os-patches for approved count and /v2/queries/os-patch-report
    for pending/failed counts; upsert device_patch_status and fire reboot alerts.
    """
    from sqlalchemy import text
    from collections import defaultdict

    # ── Source 1: os-patches → approved count ─────────────────────────────────
    try:
        patch_rows = await _fetch_os_patches(token)
    except Exception:
        logger.exception("NinjaRMM: failed to fetch os-patches")
        return

    approved_by_device: dict[int, int] = defaultdict(int)
    last_ts_by_device: dict[int, datetime | None] = defaultdict(lambda: None)

    for patch in patch_rows:
        did = patch.get("deviceId") or patch.get("device_id")
        if not did:
            continue
        did = int(did)
        status = (patch.get("status") or "").upper()
        if status in ("APPROVED", "INSTALLED"):
            approved_by_device[did] += 1

        ts = _parse_ts(patch.get("lastUpdated") or patch.get("updatedAt") or patch.get("timestamp"))
        if ts and (last_ts_by_device[did] is None or ts > last_ts_by_device[did]):
            last_ts_by_device[did] = ts

    # ── Source 2: os-patch-report → pending / failed counts ───────────────────
    try:
        report_rows = await _fetch_os_patch_report(token)
    except Exception as exc:
        logger.info("NinjaRMM: os-patch-report fetch failed — %s", repr(exc))
        report_rows = []

    if report_rows:
        logger.info("PATCH REPORT sample: %s", report_rows[0])

    pending_by_device: dict[int, int] = defaultdict(int)
    failed_by_device: dict[int, int] = defaultdict(int)

    for record in report_rows:
        did = record.get("deviceId") or record.get("device_id")
        if not did:
            continue
        did = int(did)
        status = (record.get("status") or "").upper()
        if status in ("PENDING", "PENDING_APPROVAL"):
            pending_by_device[did] += 1
        elif status == "FAILED":
            failed_by_device[did] += 1

    all_device_ids = (
        set(approved_by_device.keys())
        | set(pending_by_device.keys())
        | set(failed_by_device.keys())
    )
    logger.info(
        "NinjaRMM: aggregated patch data for %d devices (%d from os-patches, %d from patch-report)",
        len(all_device_ids), len(approved_by_device), len(pending_by_device) + len(failed_by_device),
    )

    # ── Deduplicate by hostname ───────────────────────────────────────────────
    hostname_to_best_id: dict[str, int] = {}
    for ninja_id in all_device_ids:
        dev      = devices_by_id.get(ninja_id, {})
        hostname = (
            dev.get("dnsName") or dev.get("systemName") or dev.get("hostname") or ""
        ).split(".")[0].lower()
        if not hostname:
            continue
        existing = hostname_to_best_id.get(hostname)
        if existing is None or ninja_id > existing:
            hostname_to_best_id[hostname] = ninja_id

    canonical_ids = set(hostname_to_best_id.values())

    upserted     = 0
    alerts_fired = 0
    reboot_logged = 0

    for ninja_id in all_device_ids:
        if ninja_id not in canonical_ids:
            continue
        try:
            dev      = devices_by_id.get(ninja_id, {})
            hostname = (
                dev.get("dnsName") or dev.get("systemName") or dev.get("hostname") or ""
            ).split(".")[0]

            patches_approved = approved_by_device.get(ninja_id, 0)
            patches_pending  = pending_by_device.get(ninja_id, 0)
            patches_failed   = failed_by_device.get(ninja_id, 0)
            last_scan        = last_ts_by_device.get(ninja_id)

            # Log reboot-related fields for first 3 devices to aid diagnostics
            if reboot_logged < 3:
                logger.info(
                    "REBOOT FIELDS device %d: top=%s | os=%s | patches=%s | keys=%s",
                    ninja_id,
                    {k: v for k, v in dev.items()
                     if "reboot" in k.lower() or "pending" in k.lower()},
                    dev.get("os"),
                    dev.get("patches"),
                    list(dev.keys()),
                )
                reboot_logged += 1

            reboot_required = bool(
                dev.get("rebootRequired")
                or dev.get("pendingReboot")
                or dev.get("needsReboot")
                or (dev.get("os") or {}).get("pendingReboot")
                or (dev.get("patches") or {}).get("rebootRequired")
            )

            await session.execute(
                text("""
                    INSERT INTO device_patch_status
                        (ninja_id, hostname, patches_approved, patches_pending,
                         patches_failed, reboot_required, last_scan, updated_at)
                    VALUES
                        (:ninja_id, :hostname, :patches_approved, :patches_pending,
                         :patches_failed, :reboot_required, :last_scan, NOW())
                    ON CONFLICT (ninja_id) DO UPDATE SET
                        hostname         = EXCLUDED.hostname,
                        patches_approved = EXCLUDED.patches_approved,
                        patches_pending  = EXCLUDED.patches_pending,
                        patches_failed   = EXCLUDED.patches_failed,
                        reboot_required  = EXCLUDED.reboot_required,
                        last_scan        = COALESCE(EXCLUDED.last_scan, device_patch_status.last_scan),
                        updated_at       = NOW()
                """),
                {
                    "ninja_id":         ninja_id,
                    "hostname":         hostname,
                    "patches_approved": patches_approved,
                    "patches_pending":  patches_pending,
                    "patches_failed":   patches_failed,
                    "reboot_required":  reboot_required,
                    "last_scan":        last_scan,
                },
            )
            upserted += 1

            # ── Reboot alert ──────────────────────────────────────────────────
            if not reboot_required or not hostname:
                continue

            # Check last_reboot from device_registry
            dev_rows = await session.execute(
                text("SELECT last_reboot FROM device_registry WHERE ninja_id = :nid"),
                {"nid": ninja_id},
            )
            dev_reg = dev_rows.mappings().first()
            if dev_reg is None:
                continue  # Device not in our registry — skip

            last_reboot = dev_reg["last_reboot"]
            seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)
            if last_reboot:
                if last_reboot.tzinfo is None:
                    last_reboot = last_reboot.replace(tzinfo=timezone.utc)
                if last_reboot >= seven_days_ago:
                    continue  # Rebooted recently — no alert

            # Deduplicate: skip if an open alert with this title already exists
            alert_title = f"Reboot Required: {hostname}"
            existing = await session.execute(
                text("SELECT id FROM alerts WHERE title = :t AND status != 'resolved' LIMIT 1"),
                {"t": alert_title},
            )
            if existing.first() is not None:
                continue

            # Fire alert in its own session (avoids mid-loop commit on shared session)
            await session.commit()
            try:
                from backend.schemas import RawAlert
                from backend.alert_engine import process_alert
                from backend.database import AsyncSessionLocal

                raw = RawAlert(
                    source_slug="ninjarmm",
                    event_type="reboot_required",
                    title=alert_title,
                    message=(
                        f"{hostname} has pending Windows updates that require a reboot. "
                        f"Last reboot: {'never' if not last_reboot else last_reboot.strftime('%Y-%m-%d')}."
                    ),
                    severity="warning",
                    fingerprint_key=f"reboot_required:{hostname}",
                    raw_payload={"ninja_id": ninja_id, "hostname": hostname},
                )
                async with AsyncSessionLocal() as alert_session:
                    await process_alert(raw, alert_session)
                alerts_fired += 1
                logger.info("NinjaRMM: reboot alert fired for %s", hostname)
            except Exception:
                logger.exception("NinjaRMM: failed to fire reboot alert for %s", hostname)

        except Exception:
            logger.exception("NinjaRMM: error processing patch data for device %s", ninja_id)

    logger.info(
        "NinjaRMM: patch sync complete — %d upserted, %d reboot alerts fired",
        upserted, alerts_fired,
    )


async def _sync_software_standalone(token: str, ninja_id: int) -> None:
    """
    Delete and re-insert software inventory for one device.

    Runs in its own session so a failure cannot abort any shared transaction.
    HTTP fetch happens before opening the DB session.
    """
    from backend.database import engine
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    try:
        sw_list = await _fetch_device_software(token, ninja_id)
    except Exception:
        logger.exception("NinjaRMM: failed to fetch software for device %d", ninja_id)
        return

    now = datetime.now(timezone.utc)
    rows = []
    for sw in sw_list:
        name      = sw.get("name") or sw.get("productName") or ""
        version   = sw.get("version") or sw.get("productVersion")
        publisher = sw.get("publisher") or sw.get("vendor")
        install_raw = sw.get("installDate") or sw.get("installedDate")
        install_date = None
        if install_raw:
            try:
                install_date = datetime.fromisoformat(
                    str(install_raw).replace("Z", "+00:00")
                ).date()
            except Exception:
                pass
        if name:
            rows.append({
                "ninja_id":     ninja_id,
                "name":         name,
                "version":      version,
                "publisher":    publisher,
                "install_date": install_date,
                "updated_at":   now,
            })

    try:
        async with AsyncSession(engine) as session:
            async with session.begin():
                await session.execute(
                    text("DELETE FROM device_software WHERE ninja_id = :nid"),
                    {"nid": ninja_id},
                )
                for r in rows:
                    await session.execute(
                        text("""
                            INSERT INTO device_software
                                (ninja_id, name, version, publisher, install_date, updated_at)
                            VALUES
                                (:ninja_id, :name, :version, :publisher, :install_date, :updated_at)
                        """),
                        r,
                    )
    except Exception:
        logger.exception("NinjaRMM: DB error syncing software for device %d", ninja_id)


async def _sync_disk_history(session: Any) -> None:
    """Insert current disk_free_pct snapshot into disk_history; purge rows >30 days."""
    from sqlalchemy import text

    await session.execute(text("""
        INSERT INTO disk_history (ninja_id, hostname, disk_free_pct, recorded_at)
        SELECT ninja_id, COALESCE(hostname, ip::text), disk_free_pct, NOW()
        FROM device_registry
        WHERE ninja_id IS NOT NULL
          AND disk_free_pct IS NOT NULL
    """))

    await session.execute(text("""
        DELETE FROM disk_history
        WHERE recorded_at < NOW() - INTERVAL '30 days'
    """))


# ── Main sync cycle ───────────────────────────────────────────────────────────

def _parse_last_reboot(dev: dict[str, Any]) -> datetime | None:
    return _parse_ts(dev.get("lastReboot") or dev.get("last_reboot"))


async def _sync_once(client_id: str, client_secret: str) -> None:
    from backend.database import engine
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    token   = await _token_cache.get(client_id, client_secret)

    devices = await _fetch_devices(token)
    logger.info("NinjaRMM: fetched %d devices", len(devices))

    # Build id→device map for patch status enrichment (hostname, pendingReboot)
    devices_by_id: dict[int, dict[str, Any]] = {}
    for dev in devices:
        did = dev.get("id")
        if did is not None:
            devices_by_id[int(did)] = dev

    # ── Step 1: Update device_registry ───────────────────────────────────────
    # Pure DB work — no HTTP calls inside this transaction.
    # Collect (ninja_id, last_reboot) for matched devices so we can do
    # software sync and last_reboot update outside this transaction.
    updated = 0
    matched: list[tuple[int, datetime | None]] = []  # (ninja_id, last_reboot)

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

                    short_hostname = hostname.split(".")[0].lower()
                    ninja_id  = dev.get("id")
                    os_name   = (dev.get("os") or {}).get("name") or dev.get("operatingSystem")
                    last_user = (
                        dev.get("lastLoggedInUser")
                        or dev.get("last_logged_in_user")
                        or (dev.get("system") or {}).get("lastLoggedInUser")
                    )
                    serial = (
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
                                ninja_id            = :ninja_id,
                                os_name             = COALESCE(:os_name, os_name),
                                last_logged_in_user = COALESCE(:last_user, last_logged_in_user),
                                serial              = COALESCE(:serial, serial),
                                ninja_online        = :ninja_online,
                                disk_free_pct       = :disk_free_pct
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
                    if ninja_id and result.rowcount > 0:
                        matched.append((ninja_id, _parse_last_reboot(dev)))

                except Exception:
                    logger.exception(
                        "NinjaRMM: error processing device %s — rolling back transaction",
                        dev.get("id"),
                    )
                    await session.rollback()
                    raise

            # Disk history snapshot — inside same transaction (pure DB)
            try:
                await _sync_disk_history(session)
            except Exception:
                logger.exception("NinjaRMM: failed to record disk history")

    logger.info("NinjaRMM: device sync complete — %d updated, %d matched", updated, len(matched))

    # ── Step 2: Write last_reboot (best-effort — column may not exist yet) ────
    reboot_pairs = [(nid, lr) for nid, lr in matched if lr is not None]
    if reboot_pairs:
        try:
            async with AsyncSession(engine) as session:
                async with session.begin():
                    for ninja_id, last_reboot in reboot_pairs:
                        await session.execute(
                            text("""
                                UPDATE device_registry
                                SET last_reboot = :lr
                                WHERE ninja_id = :nid
                                  AND (last_reboot IS NULL OR last_reboot < :lr)
                            """),
                            {"lr": last_reboot, "nid": ninja_id},
                        )
        except Exception as exc:
            logger.debug("NinjaRMM: last_reboot update skipped (column may not exist yet): %s",
                         repr(exc))

    # ── Step 3: Software sync — each device in its own isolated session ───────
    for ninja_id, _ in matched:
        await _sync_software_standalone(token, ninja_id)

    # ── Step 4: Patch status sync ─────────────────────────────────────────────
    async with AsyncSession(engine) as session:
        async with session.begin():
            await _sync_patch_status(token, session, devices_by_id)


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
