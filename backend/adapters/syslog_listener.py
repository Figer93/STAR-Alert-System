"""
Async UDP syslog listener for pfSense — Phase 4.
Starts a DatagramProtocol on the configured port and pipes each received
line through the pfSense adapter into the alert engine.
"""
import asyncio
import logging

from backend.config import settings

logger = logging.getLogger(__name__)


class _SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, callback):
        self._callback = callback
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.DatagramTransport):
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

    def error_received(self, exc: Exception):
        logger.error("Syslog listener OS error: %s", exc)

    def connection_lost(self, exc: Exception | None):
        if exc:
            logger.warning("Syslog listener connection lost: %s", exc)


async def _handle_line(line: str, addr: tuple, db_factory) -> None:
    from backend.adapters.pfsense_adapter import PfSenseAdapter
    from backend.alert_engine import process_alert

    adapter = PfSenseAdapter()
    try:
        raw = adapter.parse({'raw_line': line, 'source_ip': addr[0]})
    except Exception:
        logger.exception("pfSense adapter parse error for line: %.120s", line)
        return

    async with db_factory() as db:
        try:
            await process_alert(raw, db)
        except Exception:
            logger.exception("process_alert failed for pfSense syslog event")


async def start_syslog_listener(
    host: str = '0.0.0.0',
    port: int | None = None,
) -> tuple[asyncio.DatagramTransport | None, _SyslogProtocol | None]:
    """
    Start the UDP syslog listener.
    Returns (transport, protocol) — call transport.close() to stop.
    Returns (None, None) if disabled or if binding fails.
    """
    if not settings.PFSENSE_SYSLOG_ENABLED:
        logger.info("pfSense syslog listener disabled (PFSENSE_SYSLOG_ENABLED=false)")
        return None, None

    if port is None:
        port = settings.PFSENSE_SYSLOG_PORT

    from backend.database import AsyncSessionLocal

    async def _callback(line: str, addr: tuple) -> None:
        await _handle_line(line, addr, AsyncSessionLocal)

    loop = asyncio.get_event_loop()
    try:
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _SyslogProtocol(_callback),
            local_addr=(host, port),
        )
        return transport, protocol
    except PermissionError:
        logger.error(
            "Permission denied binding syslog port %d. "
            "Run as administrator or set PFSENSE_SYSLOG_PORT to a value > 1024 (e.g. 5140).",
            port,
        )
    except OSError as exc:
        logger.error("Failed to start syslog listener on port %d: %s", port, exc)

    return None, None
