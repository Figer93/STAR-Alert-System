import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.websocket_manager import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    ping_task = None

    async def send_pings():
        while True:
            await asyncio.sleep(30)
            try:
                await websocket.send_json({
                    "event": "ping",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": {},
                })
            except Exception:
                break

    try:
        ping_task = asyncio.create_task(send_pings())
        while True:
            data = await websocket.receive_text()
            if data == "pong":
                pass  # heartbeat response, ignore
    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected normally")
    except Exception:
        logger.exception("WebSocket error")
    finally:
        if ping_task:
            ping_task.cancel()
        try:
            ws_manager.disconnect(websocket)
        except ValueError:
            pass
