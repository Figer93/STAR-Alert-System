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

_CHANNEL_DEFAULTS = {
    "telegram": dict(
        enabled=True, send_resolutions=False, severity_filter="",
        message_template="", resolution_template="",
        field_toggles={"source": True, "timestamp": True, "count": False, "message": True},
        parse_mode="plain", subject_template="",
    ),
    "email": dict(
        enabled=True, send_resolutions=False, severity_filter="critical",
        message_template="", resolution_template="",
        field_toggles={"source": True, "timestamp": True, "count": True, "message": True},
        parse_mode="plain", subject_template="",
    ),
}


async def _get_or_create(channel: str, db: AsyncSession) -> NotificationChannelSettings:
    """Fetch the settings row, auto-creating it with defaults if missing."""
    obj = await db.get(NotificationChannelSettings, channel)
    if not obj:
        obj = NotificationChannelSettings(
            channel=channel,
            updated_at=datetime.now(timezone.utc),
            **_CHANNEL_DEFAULTS[channel],
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)
    return obj


@router.get("/{channel}", response_model=NotificationChannelSettingsRead)
async def get_channel_settings(channel: str, db: AsyncSession = Depends(get_db)):
    if channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Invalid channel '{channel}'")
    return await _get_or_create(channel, db)


@router.put("/{channel}", response_model=NotificationChannelSettingsRead)
async def update_channel_settings(
    channel: str,
    body: NotificationChannelSettingsUpdate,
    db: AsyncSession = Depends(get_db),
):
    if channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=400, detail=f"Invalid channel '{channel}'")
    obj = await _get_or_create(channel, db)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, field, value)
    obj.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(obj)

    # Bust the dispatcher's in-memory cache so changes take effect immediately
    from backend.notifiers import invalidate_channel_settings_cache
    invalidate_channel_settings_cache()

    return obj
