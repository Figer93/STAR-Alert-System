import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketManager:
    def __init__(self):
        self._connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self._connections.append(websocket)
        logger.info("WS client connected. Total: %d", len(self._connections))

    def disconnect(self, websocket: WebSocket):
        self._connections.remove(websocket)
        logger.info("WS client disconnected. Total: %d", len(self._connections))

    async def broadcast(self, event: str, payload: dict[str, Any]):
        message = {
            "event": event,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
        dead: list[WebSocket] = []
        for ws in list(self._connections):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


ws_manager = WebSocketManager()
