from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import NotificationChannelSettings
from backend.schemas import (
    NotificationChannelSettingsRead,
    NotificationChannelSettingsUpdate,
)

router = APIRouter(prefix="/api/notification-settings", tags=["notification-settings"])

_VALID_CHANNELS = {"telegram", "email"}


@router.get("/{channel}", response_model=NotificationChannelSettingsRead)
async def get_channel_settings(channel: str, db: AsyncSession = Depends(get_db)):
    if channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Invalid channel '{channel}'")
    obj = await db.get(NotificationChannelSettings, channel)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Channel settings for '{channel}' not found")
    return obj


@router.put("/{channel}", response_model=NotificationChannelSettingsRead)
async def update_channel_settings(
    channel: str,
    body: NotificationChannelSettingsUpdate,
    db: AsyncSession = Depends(get_db),
):
    if channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Invalid channel '{channel}'")
    obj = await db.get(NotificationChannelSettings, channel)
    if not obj:
        raise HTTPException(status_code=404, detail=f"Channel settings for '{channel}' not found")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, field, value)
    obj.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(obj)

    # Bust the dispatcher's in-memory cache so changes take effect immediately
    from backend.notifiers import invalidate_channel_settings_cache
    invalidate_channel_settings_cache()

    return obj
