import asyncio
import logging
from backend.config import settings

logger = logging.getLogger(__name__)


class _SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, callback):
        self._callback = callback
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport
        addr = transport.get_extra_info('sockname')
        logger.info("pfSense syslog listener ready on UDP %s:%d", addr[0], addr[1])

    def datagram_received(self, data: bytes, addr):
        try:
            line = data.decode('utf-8', errors='replace').strip()
            if line:
                asyncio.ensure_future(self._callback(line, addr))
        except Exception:
            logger.exception("syslog datagram_received error from %s", addr)

    def error_received(self, exc):
        logger.error("Syslog listener OS error: %s", exc)


async def start_syslog_listener(host: str = '0.0.0.0', port: int | None = None):
    if not settings.PFSENSE_SYSLOG_ENABLED:
        return None, None
    if port is None:
        port = settings.PFSENSE_SYSLOG_PORT
    from backend.database import AsyncSessionLocal
    from backend.adapters.pfsense_adapter import PfSenseAdapter
    from backend.alert_engine import process_alert

    async def _callback(line: str, addr: tuple) -> None:
        adapter = PfSenseAdapter()
        try:
            raw = adapter.parse({'raw_line': line, 'source_ip': addr[0]})
        except Exception:
            return
        async with AsyncSessionLocal() as db:
            try:
                await process_alert(raw, db)
            except Exception:
                logger.exception("process_alert failed for pfSense syslog")

    loop = asyncio.get_event_loop()
    try:
        transport, protocol = await loop.create_datagram_endpoint(lambda: _SyslogProtocol(_callback), local_addr=(host, port))
        return transport, protocol
    except (PermissionError, OSError) as exc:
        logger.error("Failed to start syslog listener on port %d: %s", port, exc)
        return None, None
