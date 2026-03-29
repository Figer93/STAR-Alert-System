from abc import ABC, abstractmethod
from backend.schemas import RawAlert


class BaseAdapter(ABC):
    source_slug: str = ""

    @abstractmethod
    def parse(self, raw_payload: dict) -> RawAlert: ...
