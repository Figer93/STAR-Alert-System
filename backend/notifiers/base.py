from abc import ABC, abstractmethod
from typing import Tuple

from backend.models import Alert


class BaseNotifier(ABC):
    @abstractmethod
    async def send(self, alert: Alert) -> Tuple[bool, str | None]:
        """Send notification. Returns (success, error_message)."""
        ...

    @abstractmethod
    async def send_resolution(self, alert: Alert) -> Tuple[bool, str | None]:
        """Send resolution notification."""
        ...
