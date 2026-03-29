from datetime import datetime, timezone
from typing import Optional


class MaintenanceState:
    def __init__(self):
        self._until: Optional[datetime] = None

    def start(self, minutes: int) -> datetime:
        from datetime import timedelta
        self._until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
        return self._until

    def stop(self) -> None:
        self._until = None

    @property
    def active(self) -> bool:
        if self._until is None:
            return False
        if datetime.now(timezone.utc) >= self._until:
            self._until = None
            return False
        return True

    @property
    def until(self) -> Optional[datetime]:
        return self._until if self.active else None

    def status(self) -> dict:
        if self.active and self._until:
            remaining = int((self._until - datetime.now(timezone.utc)).total_seconds())
            return {"active": True, "until": self._until.isoformat(), "remaining_seconds": max(0, remaining)}
        return {"active": False, "until": None, "remaining_seconds": 0}


maintenance = MaintenanceState()
