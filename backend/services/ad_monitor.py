"""
Azure AD monitor service.

Authenticates against Microsoft Graph API via OAuth2 client credentials
and periodically syncs user accounts into ad_user_status.

Fetches:
  1. Active users (display name, UPN, enabled state, created date)
  2. MFA registration via /users/{id}/authentication/methods — $batch, 20/call
     A user has MFA if they have any method other than passwordAuthenticationMethod.
     Requires: UserAuthenticationMethod.Read.All
     Gracefully skips (mfa_registered=null) if 403 is returned.
  3. Sign-in activity via $batch — /users/{id}?$select=signInActivity, 20/call
     Requires: AuditLog.Read.All
  4. Deleted users via directory/deletedItems

Fires alerts via the existing alert pipeline (source_slug="azure_ad").

Requires env vars: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET

Required Graph app permissions:
  User.Read.All                      — list users
  AuditLog.Read.All                  — sign-in activity
  UserAuthenticationMethod.Read.All  — authentication methods (MFA check)
  Directory.Read.All                 — deleted items
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

_GRAPH_BASE          = "https://graph.microsoft.com/v1.0"
_TOKEN_URL_TEMPLATE  = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
_INTERVAL            = 900  # 15 minutes


# ── Token cache ───────────────────────────────────────────────────────────────

class _TokenCache:
    """Caches a Graph API access token and refreshes it 60 s before expiry."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._expires_at: float = 0.0

    async def get(self, tenant_id: str, client_id: str, client_secret: str) -> str:
        if self._token and time.monotonic() < self._expires_at - 60:
            return self._token
        return await self._fetch(tenant_id, client_id, client_secret)

    async def _fetch(self, tenant_id: str, client_id: str, client_secret: str) -> str:
        token_url = _TOKEN_URL_TEMPLATE.format(tenant_id=tenant_id)
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                token_url,
                data={
                    "client_id":     client_id,
                    "client_secret": client_secret,
                    "scope":         "https://graph.microsoft.com/.default",
                    "grant_type":    "client_credentials",
                },
                timeout=timeout,
                ssl=True,
            ) as resp:
                if resp.status in (400, 401, 403):
                    body_text = await resp.text()
                    raise PermissionError(
                        f"Azure AD: token fetch failed ({resp.status}): {body_text[:300]}"
                    )
                resp.raise_for_status()
                body = await resp.json()

        self._token      = body["access_token"]
        self._expires_at = time.monotonic() + int(body.get("expires_in", 3600))
        logger.debug("Azure AD: token refreshed, expires in %ds", body.get("expires_in", 3600))
        return self._token  # type: ignore[return-value]


_token_cache = _TokenCache()


async def _get_token() -> str:
    return await _token_cache.get(
        os.environ["AZURE_TENANT_ID"],
        os.environ["AZURE_CLIENT_ID"],
        os.environ["AZURE_CLIENT_SECRET"],
    )


# ── Graph API helpers ─────────────────────────────────────────────────────────

async def _graph_get_all(token: str, url: str) -> list[dict[str, Any]]:
    """Fetch a paginated Graph endpoint, following @odata.nextLink until exhausted."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    timeout = aiohttp.ClientTimeout(total=60)
    all_items: list[dict[str, Any]] = []

    async with aiohttp.ClientSession() as session:
        next_url: str | None = url
        while next_url:
            async with session.get(next_url, headers=headers, timeout=timeout, ssl=True) as resp:
                if resp.status == 401:
                    raise PermissionError(f"Azure AD: 401 fetching {url}")
                resp.raise_for_status()
                data = await resp.json()

            all_items.extend(data.get("value", []))
            next_url = data.get("@odata.nextLink")

    return all_items


async def _batch_sign_in(token: str, user_ids: list[str]) -> dict[str, str | None]:
    """
    Fetch lastSignInDateTime for each user via the $batch endpoint.
    Sends batches of 20 to stay within Graph API limits.
    Returns {azure_id: lastSignInDateTime | None}.
    Requires: AuditLog.Read.All
    """
    if not user_ids:
        return {}

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
        "Accept":        "application/json",
    }
    timeout = aiohttp.ClientTimeout(total=120)
    result: dict[str, str | None] = {}

    async with aiohttp.ClientSession() as session:
        for i in range(0, len(user_ids), 20):
            chunk = user_ids[i : i + 20]
            requests_body = [
                {
                    "id":     uid,
                    "method": "GET",
                    "url":    f"/users/{uid}?$select=id,signInActivity",
                }
                for uid in chunk
            ]
            async with session.post(
                f"{_GRAPH_BASE}/$batch",
                headers=headers,
                json={"requests": requests_body},
                timeout=timeout,
                ssl=True,
            ) as resp:
                if resp.status == 401:
                    raise PermissionError("Azure AD: 401 on $batch endpoint")
                resp.raise_for_status()
                data = await resp.json()

            for response in data.get("responses", []):
                uid  = response.get("id")
                body = response.get("body") or {}
                if response.get("status") == 200 and body:
                    sign_in = body.get("signInActivity") or {}
                    result[uid] = sign_in.get("lastSignInDateTime")
                else:
                    result[uid] = None

    return result


async def _batch_mfa_check(token: str, user_ids: list[str]) -> dict[str, bool | None]:
    """
    Check MFA registration for each user via /users/{id}/authentication/methods,
    batched in groups of 20 using the $batch endpoint.

    A user has MFA registered if they have at least one authentication method
    whose @odata.type is NOT #microsoft.graph.passwordAuthenticationMethod.

    Returns {azure_id: True | False | None}.
      True  — has at least one MFA method
      False — only password method found (no MFA)
      None  — could not be determined (403 / error)

    Requires: UserAuthenticationMethod.Read.All
    Gracefully degrades to None for any 403 responses and logs a clear
    permission error so the missing grant is visible in Railway logs.
    """
    if not user_ids:
        return {}

    _PASSWORD_METHOD = "#microsoft.graph.passwordAuthenticationMethod"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
        "Accept":        "application/json",
    }
    timeout = aiohttp.ClientTimeout(total=120)
    result: dict[str, bool | None] = {}
    _permission_warned = False

    async with aiohttp.ClientSession() as session:
        for i in range(0, len(user_ids), 20):
            chunk = user_ids[i : i + 20]
            requests_body = [
                {
                    "id":     uid,
                    "method": "GET",
                    "url":    f"/users/{uid}/authentication/methods",
                }
                for uid in chunk
            ]
            async with session.post(
                f"{_GRAPH_BASE}/$batch",
                headers=headers,
                json={"requests": requests_body},
                timeout=timeout,
                ssl=True,
            ) as resp:
                if resp.status == 401:
                    raise PermissionError("Azure AD: 401 on $batch MFA check")
                if resp.status == 403:
                    if not _permission_warned:
                        logger.error(
                            "Azure AD: 403 on authentication/methods $batch — "
                            "add UserAuthenticationMethod.Read.All to the app registration. "
                            "MFA data will be unavailable until the permission is granted."
                        )
                        _permission_warned = True
                    for uid in chunk:
                        result[uid] = None
                    continue
                resp.raise_for_status()
                data = await resp.json()

            for response in data.get("responses", []):
                uid    = response.get("id")
                status = response.get("status")
                body   = response.get("body") or {}

                if status == 403:
                    if not _permission_warned:
                        logger.error(
                            "Azure AD: 403 on /users/%s/authentication/methods — "
                            "add UserAuthenticationMethod.Read.All to the app registration. "
                            "MFA data will be unavailable until the permission is granted.",
                            uid,
                        )
                        _permission_warned = True
                    result[uid] = None
                elif status == 200:
                    methods = body.get("value", [])
                    result[uid] = any(
                        m.get("@odata.type") != _PASSWORD_METHOD
                        for m in methods
                    )
                else:
                    result[uid] = None

    return result


# ── Parsing helpers ───────────────────────────────────────────────────────────

def _parse_dt(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


# ── Sync logic ────────────────────────────────────────────────────────────────

async def _sync_once() -> None:
    from backend.database import engine
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    token = await _get_token()

    # ── Step 1: Active users ──────────────────────────────────────────────────
    logger.info("Azure AD: fetching active users")
    users = await _graph_get_all(
        token,
        f"{_GRAPH_BASE}/users"
        "?$select=id,displayName,userPrincipalName,accountEnabled,createdDateTime"
        "&$top=999",
    )
    logger.info("Azure AD: fetched %d active users", len(users))

    # ── Step 2: MFA registration via authentication/methods $batch ───────────
    mfa_by_id: dict[str, bool | None] = {}
    try:
        user_ids_for_mfa = [u["id"] for u in users if u.get("id")]
        mfa_by_id = await _batch_mfa_check(token, user_ids_for_mfa)
        has_data  = sum(1 for v in mfa_by_id.values() if v is not None)
        logger.info("Azure AD: MFA data for %d/%d users", has_data, len(mfa_by_id))
    except Exception:
        import traceback
        logger.error("Azure AD: MFA batch check failed — continuing without MFA data — %s",
                     traceback.format_exc())

    # ── Step 3: Sign-in activity via $batch ───────────────────────────────────
    sign_in_map: dict[str, str | None] = {}
    try:
        user_ids = [u["id"] for u in users if u.get("id")]
        sign_in_map = await _batch_sign_in(token, user_ids)
        logger.info("Azure AD: sign-in data for %d users", len(sign_in_map))
    except Exception:
        logger.exception("Azure AD: sign-in batch fetch failed — continuing without sign-in data")

    # ── Step 4: Deleted users ─────────────────────────────────────────────────
    deleted_users: list[dict[str, Any]] = []
    try:
        deleted_users = await _graph_get_all(
            token,
            f"{_GRAPH_BASE}/directory/deletedItems/microsoft.graph.user"
            "?$select=id,displayName,userPrincipalName,deletedDateTime"
            "&$top=100",
        )
        logger.info("Azure AD: fetched %d deleted users", len(deleted_users))
    except Exception:
        logger.exception("Azure AD: deleted users fetch failed — continuing")

    # ── Step 5: Upsert active users ───────────────────────────────────────────
    upserted = 0
    async with AsyncSession(engine) as session:
        async with session.begin():
            for user in users:
                try:
                    azure_id = user.get("id")
                    if not azure_id:
                        continue
                    upn          = user.get("userPrincipalName") or ""
                    mfa_reg      = mfa_by_id.get(azure_id)
                    sign_in_raw  = sign_in_map.get(azure_id)
                    last_sign_in = _parse_dt(sign_in_raw)
                    created_at   = _parse_dt(user.get("createdDateTime"))

                    await session.execute(
                        text("""
                            INSERT INTO ad_user_status
                                (azure_id, display_name, upn, account_enabled, mfa_registered,
                                 last_sign_in, created_at_azure, is_deleted, updated_at)
                            VALUES
                                (:azure_id, :display_name, :upn, :account_enabled, :mfa_registered,
                                 :last_sign_in, :created_at_azure, FALSE, NOW())
                            ON CONFLICT (azure_id) DO UPDATE SET
                                display_name     = EXCLUDED.display_name,
                                upn              = EXCLUDED.upn,
                                account_enabled  = EXCLUDED.account_enabled,
                                mfa_registered   = COALESCE(EXCLUDED.mfa_registered, ad_user_status.mfa_registered),
                                last_sign_in     = COALESCE(EXCLUDED.last_sign_in, ad_user_status.last_sign_in),
                                created_at_azure = COALESCE(EXCLUDED.created_at_azure, ad_user_status.created_at_azure),
                                is_deleted       = FALSE,
                                updated_at       = NOW()
                        """),
                        {
                            "azure_id":         azure_id,
                            "display_name":     user.get("displayName"),
                            "upn":              upn,
                            "account_enabled":  user.get("accountEnabled"),
                            "mfa_registered":   mfa_reg,
                            "last_sign_in":     last_sign_in,
                            "created_at_azure": created_at,
                        },
                    )
                    upserted += 1
                except Exception:
                    logger.exception("Azure AD: error upserting user %s", user.get("id"))

    logger.info("Azure AD: upserted %d active users", upserted)

    # ── Step 6: Upsert deleted users, track newly deleted ─────────────────────
    newly_deleted: list[dict[str, str]] = []  # [{azure_id, display_name, upn}]

    if deleted_users:
        async with AsyncSession(engine) as session:
            async with session.begin():
                for user in deleted_users:
                    try:
                        azure_id = user.get("id")
                        if not azure_id:
                            continue

                        # Check previous state before upsert
                        existing = (
                            await session.execute(
                                text("SELECT is_deleted FROM ad_user_status WHERE azure_id = :id"),
                                {"id": azure_id},
                            )
                        ).mappings().first()

                        if existing is None or not existing["is_deleted"]:
                            newly_deleted.append({
                                "azure_id":     azure_id,
                                "display_name": user.get("displayName") or "",
                                "upn":          user.get("userPrincipalName") or "",
                            })

                        await session.execute(
                            text("""
                                INSERT INTO ad_user_status
                                    (azure_id, display_name, upn, is_deleted, updated_at)
                                VALUES
                                    (:azure_id, :display_name, :upn, TRUE, NOW())
                                ON CONFLICT (azure_id) DO UPDATE SET
                                    display_name = COALESCE(EXCLUDED.display_name, ad_user_status.display_name),
                                    upn          = COALESCE(EXCLUDED.upn, ad_user_status.upn),
                                    is_deleted   = TRUE,
                                    updated_at   = NOW()
                            """),
                            {
                                "azure_id":     azure_id,
                                "display_name": user.get("displayName"),
                                "upn":          user.get("userPrincipalName"),
                            },
                        )
                    except Exception:
                        logger.exception("Azure AD: error upserting deleted user %s", user.get("id"))

    # ── Step 7: Evaluate alert conditions ─────────────────────────────────────
    now               = datetime.now(timezone.utc)
    seven_days_ago    = now - timedelta(days=7)
    thirty_days_ago   = now - timedelta(days=30)
    twenty_four_ago   = now - timedelta(hours=24)

    # Fetch current DB state of non-deleted users for alert evaluation
    async with AsyncSession(engine) as session:
        rows_result = await session.execute(text("""
            SELECT azure_id, display_name, upn, account_enabled, mfa_registered,
                   last_sign_in, created_at_azure
            FROM ad_user_status
            WHERE is_deleted = FALSE
        """))
        db_users = rows_result.mappings().all()

        # Pre-load existing alert titles to avoid N+1 dedup queries
        r7d = await session.execute(
            text("SELECT title FROM alerts WHERE first_seen >= NOW() - INTERVAL '7 days'")
        )
        titles_7d: set[str] = {row[0] for row in r7d.all()}

        r24h = await session.execute(
            text("SELECT title FROM alerts WHERE first_seen >= NOW() - INTERVAL '24 hours'")
        )
        titles_24h: set[str] = {row[0] for row in r24h.all()}

    def _skip(title: str, severity: str) -> bool:
        """Return True if this alert was already fired within the dedup window."""
        if severity == "info":
            return title in titles_7d
        return title in titles_24h

    # Collect alerts to fire
    pending: list[tuple[str, str, str, str, str]] = []  # (title, message, severity, event_type, azure_id)

    for u in db_users:
        azure_id     = u["azure_id"]
        display_name = u["display_name"] or u["upn"] or azure_id
        upn          = u["upn"] or ""
        enabled      = u["account_enabled"]
        mfa_reg      = u["mfa_registered"]
        last_sign_in = u["last_sign_in"]
        created_at   = u["created_at_azure"]

        # Ensure tz-aware
        if last_sign_in and last_sign_in.tzinfo is None:
            last_sign_in = last_sign_in.replace(tzinfo=timezone.utc)
        if created_at and created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)

        # Disabled account + sign-in within 7 days
        if enabled is False and last_sign_in and last_sign_in >= seven_days_ago:
            title = f"AD Account Disabled: {display_name} — recent activity detected"
            if not _skip(title, "warning"):
                pending.append((
                    title,
                    f"Account {upn} is disabled but had sign-in at "
                    f"{last_sign_in.strftime('%Y-%m-%d %H:%M UTC')}.",
                    "warning",
                    "ad_account_disabled_recent",
                    azure_id,
                ))

        # Enabled + no sign-in for 30+ days
        if enabled is True and (last_sign_in is None or last_sign_in < thirty_days_ago):
            title = f"Inactive AD Account: {display_name} — no sign-in 30+ days"
            if not _skip(title, "warning"):
                pending.append((
                    title,
                    f"Account {upn} has not signed in for over 30 days. "
                    f"Last sign-in: {last_sign_in.strftime('%Y-%m-%d') if last_sign_in else 'never'}.",
                    "warning",
                    "ad_account_inactive",
                    azure_id,
                ))

        # Enabled + no MFA
        if enabled is True and mfa_reg is False:
            title = f"No MFA: {display_name} ({upn})"
            if not _skip(title, "info"):
                pending.append((
                    title,
                    f"Account {upn} is enabled but has no MFA method registered.",
                    "info",
                    "ad_no_mfa",
                    azure_id,
                ))

        # New account created in last 24h
        if created_at and created_at >= twenty_four_ago:
            title = f"New AD Account Created: {display_name} ({upn})"
            if not _skip(title, "info"):
                pending.append((
                    title,
                    f"New Azure AD account created for {upn} at "
                    f"{created_at.strftime('%Y-%m-%d %H:%M UTC')}.",
                    "info",
                    "ad_account_created",
                    azure_id,
                ))

    # Newly deleted users
    for nd in newly_deleted:
        display_name = nd["display_name"] or nd["upn"] or nd["azure_id"]
        title = f"AD Account Deleted: {display_name}"
        if not _skip(title, "warning"):
            pending.append((
                title,
                f"Azure AD account {nd['upn'] or nd['azure_id']} has been deleted.",
                "warning",
                "ad_account_deleted",
                nd["azure_id"],
            ))

    # Fire all pending alerts, each in its own session
    alerts_fired = 0
    if pending:
        from backend.schemas import RawAlert
        from backend.alert_engine import process_alert
        from backend.database import AsyncSessionLocal

        for title, message, severity, event_type, azure_id in pending:
            try:
                raw = RawAlert(
                    source_slug="azure_ad",
                    event_type=event_type,
                    title=title,
                    message=message,
                    severity=severity,
                    fingerprint_key=f"{event_type}:{azure_id}",
                    raw_payload={"azure_id": azure_id},
                )
                async with AsyncSessionLocal() as db:
                    await process_alert(raw, db)
                alerts_fired += 1
            except Exception:
                logger.exception("Azure AD: failed to fire alert '%s'", title)

    logger.info(
        "Azure AD: sync complete — %d active users, %d deleted, %d alerts fired",
        upserted, len(newly_deleted), alerts_fired,
    )


# ── Entry point ───────────────────────────────────────────────────────────────

async def ad_sync_loop() -> None:
    """Background task: sync Azure AD data every 15 minutes."""
    tenant_id     = os.getenv("AZURE_TENANT_ID")
    client_id     = os.getenv("AZURE_CLIENT_ID")
    client_secret = os.getenv("AZURE_CLIENT_SECRET")

    if not tenant_id or not client_id or not client_secret:
        logger.info(
            "Azure AD: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET not set — sync disabled"
        )
        return

    logger.info(
        "Azure AD: starting sync loop (interval=%ds) — required Graph permissions: "
        "User.Read.All, AuditLog.Read.All, UserAuthenticationMethod.Read.All, Directory.Read.All",
        _INTERVAL,
    )
    while True:
        try:
            await _sync_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            import traceback
            logger.error("Azure AD: sync error (will retry next cycle) — %s", traceback.format_exc())
        await asyncio.sleep(_INTERVAL)
