from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.models import Alert, Source
from backend.schemas import StatsSummary, TimelineBucket, SourceStats

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("/summary", response_model=StatsSummary)
async def get_summary(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Alert.severity, func.count().label("cnt")).where(Alert.status == "active").group_by(Alert.severity))).all()
    counts = {row.severity: row.cnt for row in rows}
    sources_online = (await db.execute(select(func.count()).select_from(Source).where(Source.status == "online"))).scalar_one()
    sources_total = (await db.execute(select(func.count()).select_from(Source))).scalar_one()
    return StatsSummary(critical=counts.get("critical", 0), warning=counts.get("warning", 0), info=counts.get("info", 0), ok=counts.get("ok", 0), total_active=sum(counts.values()), sources_online=sources_online, sources_total=sources_total)


@router.get("/timeline", response_model=list[TimelineBucket])
async def get_timeline(hours: int = Query(24, ge=1, le=168), db: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours)
    alerts = (await db.execute(select(Alert).where(Alert.first_seen >= cutoff))).scalars().all()
    buckets: dict[str, int] = {}
    for i in range(hours):
        bucket_time = cutoff + timedelta(hours=i)
        buckets[bucket_time.strftime("%Y-%m-%dT%H:00:00Z")] = 0
    for alert in alerts:
        key = alert.first_seen.replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:00:00Z")
        if key in buckets:
            buckets[key] += 1
    return [TimelineBucket(hour=k, count=v) for k, v in sorted(buckets.items())]


@router.get("/sources", response_model=list[SourceStats])
async def get_source_stats(db: AsyncSession = Depends(get_db)):
    sources = (await db.execute(select(Source))).scalars().all()
    results = []
    for source in sources:
        total = (await db.execute(select(func.count()).select_from(Alert).where(Alert.source_id == source.id))).scalar_one()
        active = (await db.execute(select(func.count()).select_from(Alert).where(Alert.source_id == source.id).where(Alert.status == "active"))).scalar_one()
        results.append(SourceStats(source_id=source.id, source_name=source.name, source_slug=source.slug, status=source.status, last_seen=source.last_seen, alert_count_total=total, alert_count_active=active))
    return results
