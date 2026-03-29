import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.maintenance import maintenance

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


class MaintenanceStart(BaseModel):
    minutes: int = Field(default=30, ge=1, le=480)


@router.get("/status")
async def get_status():
    return maintenance.status()


@router.post("/start")
async def start_maintenance(body: MaintenanceStart):
    until = maintenance.start(body.minutes)
    logger.info("Maintenance mode started for %d minutes (until %s)", body.minutes, until.isoformat())
    return maintenance.status()


@router.post("/stop")
async def stop_maintenance():
    maintenance.stop()
    logger.info("Maintenance mode stopped")
    return maintenance.status()
