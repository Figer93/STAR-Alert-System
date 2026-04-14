import os

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/db-health")
async def db_health(db: AsyncSession = Depends(get_db)):
    size_row = await db.execute(text("SELECT pg_database_size(current_database())"))
    size_bytes = size_row.scalar_one()

    tables_rows = await db.execute(text(
        "SELECT tablename, pg_total_relation_size('public.' || tablename) AS size_bytes"
        " FROM pg_tables WHERE schemaname = 'public'"
        " ORDER BY size_bytes DESC LIMIT 3"
    ))
    top_tables = [{"name": r.tablename, "size_bytes": r.size_bytes} for r in tables_rows]

    conn_row = await db.execute(text(
        "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"
    ))
    connections = conn_row.scalar_one()

    return {
        "size_bytes": size_bytes,
        "limit_bytes": 5_368_709_120,
        "top_tables": top_tables,
        "connections": connections,
    }


@router.get("/railway-status")
async def railway_status():
    sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA")
    deployment = sha[-7:] if sha else "unknown"
    return {
        "status": "healthy",
        "deployment": deployment,
        "deployed_at": None,
        "memory_mb": None,
    }
