"""
Azure AD endpoints — /api/ad/*

Serves user account data synced from Microsoft Graph by ad_monitor.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ad", tags=["ad"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _iso(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    return v


# ── Pydantic models ────────────────────────────────────────────────────────────

class AdUserRow(BaseModel):
    id:                  int
    azure_id:            str
    display_name:        Optional[str] = None
    upn:                 Optional[str] = None
    account_enabled:     Optional[bool] = None
    mfa_registered:      Optional[bool] = None
    last_sign_in:        Optional[str] = None
    created_at_azure:    Optional[str] = None
    is_deleted:          bool = False
    updated_at:          Optional[str] = None
    department:          Optional[str] = None
    license_names:       Optional[str] = None
    password_expires_at: Optional[str] = None
    profile_country:     Optional[str] = None
    is_foreign_signin:   bool = False
    manager_name:        Optional[str] = None


class AdSummary(BaseModel):
    total:                int
    enabled:              int
    disabled:             int
    no_mfa:               int
    inactive_30d:         int
    deleted_7d:           int
    foreign_signin_count: int
    expiring_soon_count:  int


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/users", response_model=list[AdUserRow])
async def get_ad_users(
    enabled:  Optional[bool] = Query(None, description="Filter by account_enabled"),
    mfa:      Optional[bool] = Query(None, description="Filter by mfa_registered"),
    inactive: Optional[bool] = Query(None, description="No sign-in in last 30 days (enabled accounts only)"),
    db: AsyncSession = Depends(get_db),
):
    """Return AD users, ordered by display_name. Supports optional server-side filters."""
    conditions: list[str] = []
    params: dict[str, Any] = {}

    if enabled is not None:
        conditions.append("account_enabled = :enabled")
        params["enabled"] = enabled

    if mfa is not None:
        conditions.append("mfa_registered = :mfa")
        params["mfa"] = mfa

    if inactive:
        conditions.append("account_enabled = TRUE")
        conditions.append(
            "(last_sign_in IS NULL OR last_sign_in < NOW() - INTERVAL '30 days')"
        )

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = f"SELECT * FROM ad_user_status {where} ORDER BY display_name ASC NULLS LAST"

    result = await db.execute(text(sql), params)
    rows = result.mappings().all()

    return [
        AdUserRow(
            id                  = r["id"],
            azure_id            = r["azure_id"],
            display_name        = r.get("display_name"),
            upn                 = r.get("upn"),
            account_enabled     = r.get("account_enabled"),
            mfa_registered      = r.get("mfa_registered"),
            last_sign_in        = _iso(r.get("last_sign_in")),
            created_at_azure    = _iso(r.get("created_at_azure")),
            is_deleted          = bool(r.get("is_deleted", False)),
            updated_at          = _iso(r.get("updated_at")),
            department          = r.get("department"),
            license_names       = r.get("license_names"),
            password_expires_at = _iso(r.get("password_expires_at")),
            profile_country     = r.get("sign_in_country"),
            is_foreign_signin   = bool(r.get("is_foreign_signin", False)),
            manager_name        = r.get("manager_name"),
        )
        for r in rows
    ]


@router.get("/summary", response_model=AdSummary)
async def get_ad_summary(db: AsyncSession = Depends(get_db)):
    """Aggregate counts for the AD Monitor summary cards."""
    result = await db.execute(text("""
        SELECT
            COUNT(*)                                                                            AS total,
            COUNT(*) FILTER (WHERE account_enabled = TRUE  AND is_deleted = FALSE)             AS enabled,
            COUNT(*) FILTER (WHERE account_enabled = FALSE AND is_deleted = FALSE)             AS disabled,
            COUNT(*) FILTER (
                WHERE mfa_registered = FALSE
                  AND account_enabled = TRUE
                  AND is_deleted = FALSE
            )                                                                                   AS no_mfa,
            COUNT(*) FILTER (
                WHERE account_enabled = TRUE
                  AND is_deleted = FALSE
                  AND (last_sign_in IS NULL OR last_sign_in < NOW() - INTERVAL '30 days')
            )                                                                                   AS inactive_30d,
            COUNT(*) FILTER (
                WHERE is_deleted = TRUE
                  AND updated_at >= NOW() - INTERVAL '7 days'
            )                                                                                   AS deleted_7d,
            COUNT(*) FILTER (
                WHERE is_foreign_signin = TRUE
                  AND account_enabled = TRUE
                  AND is_deleted = FALSE
            )                                                                                   AS foreign_signin_count,
            COUNT(*) FILTER (
                WHERE password_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
                  AND account_enabled = TRUE
                  AND is_deleted = FALSE
            )                                                                                   AS expiring_soon_count
        FROM ad_user_status
    """))
    row = result.mappings().first()
    if not row:
        return AdSummary(
            total=0, enabled=0, disabled=0, no_mfa=0, inactive_30d=0,
            deleted_7d=0, foreign_signin_count=0, expiring_soon_count=0,
        )

    return AdSummary(
        total                = int(row["total"] or 0),
        enabled              = int(row["enabled"] or 0),
        disabled             = int(row["disabled"] or 0),
        no_mfa               = int(row["no_mfa"] or 0),
        inactive_30d         = int(row["inactive_30d"] or 0),
        deleted_7d           = int(row["deleted_7d"] or 0),
        foreign_signin_count = int(row["foreign_signin_count"] or 0),
        expiring_soon_count  = int(row["expiring_soon_count"] or 0),
    )
