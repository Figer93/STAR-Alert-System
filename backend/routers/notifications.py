import logging
from datetime import datetime, timezone
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class TestNotifRequest(BaseModel):
    channel: str
    severity: str = "warning"


class TestNotifResponse(BaseModel):
    success: bool
    error: str | None = None


@router.post("/test", response_model=TestNotifResponse)
async def send_test_notification(body: TestNotifRequest) -> TestNotifResponse:
    if body.channel not in ("telegram", "email"):
        return TestNotifResponse(success=False, error=f"Unknown channel: {body.channel}")

    class _FakeSource:
        name = "ST&R Test"

    class _FakeAlert:
        id = 0
        severity = body.severity
        title = "Test Notification from ST&R"
        message = "This is a test notification to verify your notification channel."
        fingerprint = "test"
        status = "active"
        first_seen = datetime.now(timezone.utc)
        last_seen = datetime.now(timezone.utc)
        resolved_at = None
        occurrence_count = 1
        source = _FakeSource()

    try:
        if body.channel == "telegram":
            from backend.notifiers.telegram_notifier import TelegramNotifier
            success, error = await TelegramNotifier().send(_FakeAlert())  # type: ignore
        else:
            from backend.notifiers.email_notifier import EmailNotifier
            success, error = await EmailNotifier().send(_FakeAlert())  # type: ignore
        return TestNotifResponse(success=success, error=error)
    except Exception as e:
        return TestNotifResponse(success=False, error=str(e))
