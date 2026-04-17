"""
Microsoft 365 service health monitor.

Syncs M365 service health and active incidents from Microsoft Graph API
every 5 minutes.  Token handling is shared with ad_monitor (same tenant /
client credentials).

Requires env vars: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
Required Graph permission: ServiceHealth.Read.All
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import aiohttp

from backend.services.ad_monitor import _get_token

logger = logging.getLogger(__name__)

_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_INTERVAL   = 300  # 5 minutes

_OPERATIONAL_STATUSES: frozenset[str] = frozenset({"serviceOperational", "informational"})


# ── Graph helpers ─────────────────────────────────────────────────────────────

async def _graph_get_all(token: str, url: str) -> list[dict[str, Any]]:
    """Fetch a paginated Graph endpoint, following @odata.nextLink."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    timeout = aiohttp.ClientTimeout(total=30)
    all_items: list[dict[str, Any]] = []

    async with aiohttp.ClientSession() as session:
        next_url: str | None = url
        while next_url:
            async with session.get(next_url, headers=headers, timeout=timeout, ssl=True) as resp:
                if resp.status == 401:
                    raise PermissionError(f"M365: 401 fetching {url}")
                resp.raise_for_status()
                data = await resp.json()

            all_items.extend(data.get("value", []))
            next_url = data.get("@odata.nextLink")

    return all_items


# ── Alert helpers ─────────────────────────────────────────────────────────────

async def _open_alert_exists(session: Any, title: str) -> bool:
    """Return True if an unresolved alert with this exact title already exists."""
    from sqlalchemy import text

    result = await session.execute(
        text("SELECT id FROM alerts WHERE title = :t AND status != 'resolved' LIMIT 1"),
        {"t": title},
    )
    return result.first() is not None


async def _auto_resolve_alert(title: str) -> None:
    """
    Resolve any open alert with this exact title.
    Runs in its own session so it can commit immediately.
    """
    from sqlalchemy import text
    from backend.database import AsyncSessionLocal
    from backend.websocket_manager import ws_manager

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            text("""
                UPDATE alerts
                SET status = 'resolved', resolved_at = NOW()
                WHERE title = :title AND status != 'resolved'
                RETURNING id
            """),
            {"title": title},
        )
        resolved_ids = [row[0] for row in result.all()]
        await db.commit()

    for rid in resolved_ids:
        await ws_manager.broadcast("alert.updated", {"id": rid, "status": "resolved"})
        logger.info("M365: auto-resolved alert id=%d (%s)", rid, title)


async def _fire_alert(title: str, message: str, severity: str, event_type: str, ref_id: str) -> None:
    """Fire a new alert via the existing pipeline."""
    from backend.schemas import RawAlert
    from backend.alert_engine import process_alert
    from backend.database import AsyncSessionLocal

    raw = RawAlert(
        source_slug="m365",
        event_type=event_type,
        title=title,
        message=message,
        severity=severity,
        fingerprint_key=f"{event_type}:{ref_id}",
        raw_payload={"ref_id": ref_id, "title": title},
    )
    async with AsyncSessionLocal() as db:
        await process_alert(raw, db)


# ── Sync helpers ──────────────────────────────────────────────────────────────

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


def _human_status(status: str) -> str:
    """Convert camelCase Graph status to a readable label."""
    mapping = {
        "serviceOperational":          "Operational",
        "informational":               "Informational",
        "serviceDegraded":             "Degraded",
        "serviceInterruption":         "Interruption",
        "extendedRecovery":            "Extended Recovery",
        "serviceRestored":             "Restored",
        "falsePositive":               "False Positive",
        "investigationSuspended":      "Investigation Suspended",
        "postIncidentReviewPublished": "Post-Incident Review",
    }
    return mapping.get(status, status)


# ── Main sync ─────────────────────────────────────────────────────────────────

async def _sync_once() -> None:
    from backend.database import engine
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    token = await _get_token()

    # ── Step 1: Service health overviews ──────────────────────────────────────
    logger.info("M365: fetching service health overviews")
    health_raw = await _graph_get_all(
        token,
        f"{_GRAPH_BASE}/admin/serviceAnnouncement/healthOverviews",
    )
    logger.info("M365: fetched %d service health entries", len(health_raw))

    # Read previous latest status per service (for change detection)
    async with AsyncSession(engine) as session:
        prev_result = await session.execute(text("""
            SELECT DISTINCT ON (service_id)
                service_id, service_name, status
            FROM m365_service_health
            ORDER BY service_id, recorded_at DESC
        """))
        prev_statuses: dict[str, dict[str, str]] = {
            row["service_id"]: {"status": row["status"], "service_name": row["service_name"]}
            for row in prev_result.mappings().all()
        }

    # Insert new rows, prune old ones
    inserted = 0
    async with AsyncSession(engine) as session:
        async with session.begin():
            for svc in health_raw:
                service_id   = svc.get("id") or svc.get("service")
                service_name = svc.get("service") or svc.get("displayName") or service_id
                status       = svc.get("status", "")
                if not service_id:
                    continue

                await session.execute(
                    text("""
                        INSERT INTO m365_service_health (service_id, service_name, status, recorded_at)
                        VALUES (:service_id, :service_name, :status, NOW())
                    """),
                    {"service_id": service_id, "service_name": service_name, "status": status},
                )
                inserted += 1

            # Prune rows older than 7 days
            await session.execute(text(
                "DELETE FROM m365_service_health WHERE recorded_at < NOW() - INTERVAL '7 days'"
            ))

    logger.info("M365: inserted %d service health rows", inserted)

    # ── Step 2: Service health alerts + auto-resolves ─────────────────────────
    alerts_fired   = 0
    alerts_resolved = 0

    async with AsyncSession(engine) as session:
        for svc in health_raw:
            service_id   = svc.get("id") or svc.get("service")
            service_name = svc.get("service") or svc.get("displayName") or service_id
            new_status   = svc.get("status", "")
            if not service_id:
                continue

            prev       = prev_statuses.get(service_id, {})
            old_status = prev.get("status", "")
            was_bad    = old_status and old_status not in _OPERATIONAL_STATUSES
            is_good    = new_status in _OPERATIONAL_STATUSES

            # Auto-resolve: service recovered
            if was_bad and is_good:
                old_title = f"M365 {service_name} — {_human_status(old_status)}"
                await _auto_resolve_alert(old_title)
                alerts_resolved += 1

            # Fire: service is degraded/interrupted
            if not is_good:
                title = f"M365 {service_name} — {_human_status(new_status)}"
                exists = await _open_alert_exists(session, title)
                if not exists:
                    await _fire_alert(
                        title=title,
                        message=(
                            f"Microsoft 365 service '{service_name}' has a non-operational "
                            f"status: {_human_status(new_status)}."
                        ),
                        severity="critical",
                        event_type="m365_service_status",
                        ref_id=f"{service_id}:{new_status}",
                    )
                    alerts_fired += 1

    # ── Step 3: Open incidents ────────────────────────────────────────────────
    logger.info("M365: fetching open incidents")
    incidents_raw = await _graph_get_all(
        token,
        f"{_GRAPH_BASE}/admin/serviceAnnouncement/issues?$filter=isResolved eq false",
    )
    logger.info("M365: fetched %d open incidents", len(incidents_raw))

    graph_open_ids: set[str] = {i["id"] for i in incidents_raw if i.get("id")}

    # Find DB incidents that are no longer open in Graph → they were resolved
    async with AsyncSession(engine) as session:
        db_open_result = await session.execute(text("""
            SELECT incident_id, title, service_name, classification
            FROM m365_incidents
            WHERE is_resolved = FALSE
        """))
        db_open = db_open_result.mappings().all()

    newly_resolved_incidents = [i for i in db_open if i["incident_id"] not in graph_open_ids]

    # Mark those resolved in DB and auto-resolve their alerts
    if newly_resolved_incidents:
        async with AsyncSession(engine) as session:
            async with session.begin():
                for inc in newly_resolved_incidents:
                    await session.execute(
                        text("""
                            UPDATE m365_incidents
                            SET is_resolved = TRUE, end_time = NOW(), updated_at = NOW()
                            WHERE incident_id = :iid
                        """),
                        {"iid": inc["incident_id"]},
                    )
        # Auto-resolve matching alerts (outside the transaction)
        for inc in newly_resolved_incidents:
            svc   = inc["service_name"] or ""
            t     = inc["title"] or ""
            label = "Incident" if (inc["classification"] or "").lower() == "incident" else "Advisory"
            old_title = f"M365 {label}: {t} ({svc})"
            await _auto_resolve_alert(old_title)
            alerts_resolved += 1

    logger.info("M365: %d incidents newly resolved", len(newly_resolved_incidents))

    # Upsert open incidents from Graph
    upserted_incidents = 0
    async with AsyncSession(engine) as session:
        async with session.begin():
            for inc in incidents_raw:
                incident_id    = inc.get("id")
                if not incident_id:
                    continue
                service_name   = inc.get("service") or ""
                title          = inc.get("title") or ""
                status         = inc.get("status") or ""
                classification = inc.get("classification") or ""
                severity       = inc.get("severity") or ""
                start_time     = _parse_dt(inc.get("startDateTime"))
                end_time       = _parse_dt(inc.get("endDateTime"))
                is_resolved    = bool(inc.get("isResolved", False))

                await session.execute(
                    text("""
                        INSERT INTO m365_incidents
                            (incident_id, service_name, title, status, classification,
                             severity, start_time, end_time, is_resolved, updated_at)
                        VALUES
                            (:incident_id, :service_name, :title, :status, :classification,
                             :severity, :start_time, :end_time, :is_resolved, NOW())
                        ON CONFLICT (incident_id) DO UPDATE SET
                            service_name   = EXCLUDED.service_name,
                            title          = EXCLUDED.title,
                            status         = EXCLUDED.status,
                            classification = EXCLUDED.classification,
                            severity       = EXCLUDED.severity,
                            start_time     = COALESCE(EXCLUDED.start_time, m365_incidents.start_time),
                            end_time       = COALESCE(EXCLUDED.end_time,   m365_incidents.end_time),
                            is_resolved    = EXCLUDED.is_resolved,
                            updated_at     = NOW()
                    """),
                    {
                        "incident_id":    incident_id,
                        "service_name":   service_name,
                        "title":          title,
                        "status":         status,
                        "classification": classification,
                        "severity":       severity,
                        "start_time":     start_time,
                        "end_time":       end_time,
                        "is_resolved":    is_resolved,
                    },
                )
                upserted_incidents += 1

    logger.info("M365: upserted %d open incidents", upserted_incidents)

    # ── Step 4: Incident alerts ───────────────────────────────────────────────
    # Fire alert for any incident/advisory with no open alert yet
    async with AsyncSession(engine) as session:
        for inc in incidents_raw:
            incident_id    = inc.get("id")
            service_name   = inc.get("service") or ""
            title          = inc.get("title") or ""
            classification = (inc.get("classification") or "").lower()
            status         = inc.get("status") or ""

            if not incident_id:
                continue

            if classification == "incident":
                alert_title    = f"M365 Incident: {title} ({service_name})"
                alert_severity = "critical"
                event_type     = "m365_incident"
            else:
                alert_title    = f"M365 Advisory: {title} ({service_name})"
                alert_severity = "warning"
                event_type     = "m365_advisory"

            exists = await _open_alert_exists(session, alert_title)
            if not exists:
                await _fire_alert(
                    title=alert_title,
                    message=(
                        f"M365 {classification.title()} affecting {service_name}: {title}. "
                        f"Status: {status}."
                    ),
                    severity=alert_severity,
                    event_type=event_type,
                    ref_id=incident_id,
                )
                alerts_fired += 1

    logger.info(
        "M365: sync complete — %d alerts fired, %d auto-resolved",
        alerts_fired, alerts_resolved,
    )


# ── Entry point ───────────────────────────────────────────────────────────────

async def m365_sync_loop() -> None:
    """Background task: sync M365 service health every 5 minutes."""
    import os
    if not (os.getenv("AZURE_TENANT_ID") and os.getenv("AZURE_CLIENT_ID") and os.getenv("AZURE_CLIENT_SECRET")):
        logger.info("M365: AZURE_* env vars not set — sync disabled")
        return

    logger.info("M365: starting sync loop (interval=%ds)", _INTERVAL)
    while True:
        try:
            await _sync_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            import traceback
            logger.error("M365: sync error (will retry next cycle) — %s", traceback.format_exc())
        await asyncio.sleep(_INTERVAL)
