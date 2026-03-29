import re
import logging
from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

logger = logging.getLogger(__name__)
_SYSLOG_RE = re.compile(r'^(?:<\d+>)?(?:\w{3}\s{1,2}\d{1,2}\s+\d+:\d+:\d+\s+)?(?:\S+\s+)?(\S+?)(?:\[\d+\])?:\s*(.*)', re.DOTALL)


class PfSenseAdapter(BaseAdapter):
    source_slug = "pfsense"

    def parse(self, raw_payload: dict) -> RawAlert:
        line = raw_payload.get('raw_line', '')
        m = _SYSLOG_RE.match(line)
        if not m:
            return self._unknown(raw_payload, line)
        process = m.group(1).lower().rstrip('/')
        msg = m.group(2).strip()
        lower = msg.lower()
        if process == 'filterlog':
            return self._firewall(msg, raw_payload)
        if 'dhcpd' in process:
            return RawAlert(source_slug=self.source_slug, event_type='dhcp_event', title=f'DHCP: {msg[:80]}', message=msg[:300], severity='info', fingerprint_key=f'dhcp:{msg[:40]}', raw_payload=raw_payload)
        if 'openvpn' in process:
            error = any(x in lower for x in ('error', 'failed', 'timeout', 'disconnected'))
            return RawAlert(source_slug=self.source_slug, event_type='vpn_error' if error else 'vpn_info', title=f'OpenVPN {"error" if error else "event"}', message=msg[:300], severity='critical' if error else 'info', fingerprint_key=f'vpn:{msg[:60]}', raw_payload=raw_payload)
        if any(x in lower for x in ('link up', 'link down', 'carrier lost')):
            down = 'link down' in lower or 'carrier lost' in lower
            iface_m = re.search(r'\b(em\d+|igb\d+|vtnet\d+|wan|lan)\b', msg, re.I)
            iface = iface_m.group(1).upper() if iface_m else 'unknown'
            return RawAlert(source_slug=self.source_slug, event_type='interface_down' if down else 'interface_up', title=f'Interface {iface} {"DOWN" if down else "UP"}', message=msg[:300], severity='critical' if down else 'info', fingerprint_key=f'iface:{iface}', raw_payload=raw_payload)
        if any(x in lower for x in ('authentication failure', 'failed password', 'invalid user')):
            return RawAlert(source_slug=self.source_slug, event_type='auth_failure', title='Authentication failure on pfSense', message=msg[:300], severity='warning', fingerprint_key='auth_failure:pfsense', raw_payload=raw_payload)
        return self._unknown(raw_payload, f'[{process}] {msg}')

    def _firewall(self, msg: str, raw: dict) -> RawAlert:
        parts = msg.split(',')
        if len(parts) >= 20:
            action, src, dport = parts[6], parts[18], parts[21] if len(parts) > 21 else '?'
            if action == 'block':
                return RawAlert(source_slug=self.source_slug, event_type='firewall_block', title=f'Firewall blocked {parts[16].upper()} {src} port {dport}', message=msg[:300], severity='info', fingerprint_key=f'fw_block:{src}:{dport}', raw_payload=raw)
        return self._unknown(raw, f'[filterlog] {msg}')

    def _unknown(self, raw: dict, line: str) -> RawAlert:
        short = line[:80]
        return RawAlert(source_slug=self.source_slug, event_type='syslog_event', title=f'pfSense: {short}', message=line[:300], severity='info', fingerprint_key=f'syslog:{short}', raw_payload=raw)
