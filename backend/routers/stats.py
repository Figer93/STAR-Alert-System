from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, case
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import Alert, Source
from backend.schemas import StatsSummary, TimelineBucket, SourceStats

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("/summary", response_model=StatsSummary)
async def get_summary(db: AsyncSession = Depends(get_db)):
    # Alert severity counts (active only)
    severity_stmt = (
        select(Alert.severity, func.count().label("cnt"))
        .where(Alert.status == "active")
        .group_by(Alert.severity)
    )
    rows = (await db.execute(severity_stmt)).all()
    counts = {row.severity: row.cnt for row in rows}

    total_active = sum(counts.values())

    sources_online = (
        await db.execute(
            select(func.count()).select_from(Source).where(Source.status == "online")
        )
    ).scalar_one()

    sources_total = (
        await db.execute(select(func.count()).select_from(Source))
    ).scalar_one()

    return StatsSummary(
        critical=counts.get("critical", 0),
        warning=counts.get("warning", 0),
        info=counts.get("info", 0),
        ok=counts.get("ok", 0),
        total_active=total_active,
        sources_online=sources_online,
        sources_total=sources_total,
    )


@router.get("/timeline", response_model=list[TimelineBucket])
async def get_timeline(hours: int = Query(24, ge=1, le=168), db: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours)

    stmt = select(Alert).where(Alert.first_seen >= cutoff)
    alerts = (await db.execute(stmt)).scalars().all()

    # Bucket by hour
    buckets: dict[str, int] = {}
    for i in range(hours):
        bucket_time = cutoff + timedelta(hours=i)
        bucket_key = bucket_time.strftime("%Y-%m-%dT%H:00:00Z")
        buckets[bucket_key] = 0

    for alert in alerts:
        bucket_time = alert.first_seen.replace(minute=0, second=0, microsecond=0)
        bucket_key = bucket_time.strftime("%Y-%m-%dT%H:00:00Z")
        if bucket_key in buckets:
            buckets[bucket_key] += 1

    return [TimelineBucket(hour=k, count=v) for k, v in sorted(buckets.items())]


@router.get("/sources", response_model=list[SourceStats])
async def get_source_stats(db: AsyncSession = Depends(get_db)):
    sources = (await db.execute(select(Source))).scalars().all()
    results = []

    for source in sources:
        total_stmt = select(func.count()).select_from(Alert).where(Alert.source_id == source.id)
        active_stmt = (
            select(func.count())
            .select_from(Alert)
            .where(Alert.source_id == source.id)
            .where(Alert.status == "active")
        )
        total = (await db.execute(total_stmt)).scalar_one()
        active = (await db.execute(active_stmt)).scalar_one()

        results.append(
            SourceStats(
                source_id=source.id,
                source_name=source.name,
                source_slug=source.slug,
                status=source.status,
                last_seen=source.last_seen,
                alert_count_total=total,
                alert_count_active=active,
            )
        )

    return results
