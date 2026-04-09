import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class TestNotifRequest(BaseModel):
    channel: Literal["telegram", "email"]
    severity: Literal["critical", "warning", "info", "ok"] = "warning"


class TestNotifResponse(BaseModel):
    success: bool
    error: str | None = None


@router.post("/test", response_model=TestNotifResponse)
async def send_test_notification(body: TestNotifRequest) -> TestNotifResponse:
    """Send a test notification to verify channel configuration."""

    # Build a lightweight fake alert (no DB row needed)
    class _FakeSource:
        name = "ST&R Test"

    class _FakeAlert:
        id = 0
        severity = body.severity
        title = "Test Notification from ST&R"
        message = (
            "This is a test notification sent from the ST&R Alert Dashboard "
            "to verify your notification channel is configured correctly."
        )
        fingerprint = "test"
        status = "active"
        first_seen = datetime.now(timezone.utc)
        last_seen = datetime.now(timezone.utc)
        resolved_at = None
        occurrence_count = 1
        source = _FakeSource()

    fake_alert = _FakeAlert()

    try:
        if body.channel == "telegram":
            from backend.notifiers.telegram_notifier import TelegramNotifier
            success, error = await TelegramNotifier().send(fake_alert)  # type: ignore[arg-type]
        else:
            from backend.notifiers.email_notifier import EmailNotifier
            success, error = await EmailNotifier().send(fake_alert)  # type: ignore[arg-type]

        return TestNotifResponse(success=success, error=error)
    except Exception as e:
        logger.exception("Test notification error for channel=%s", body.channel)
        return TestNotifResponse(success=False, error=str(e))
