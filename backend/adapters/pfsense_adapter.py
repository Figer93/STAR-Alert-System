"""
pfSense syslog adapter — Phase 4.
Parses RFC 3164 syslog lines emitted by pfSense and converts them into
normalised RawAlert objects for the alert engine.

Handled log types:
  filterlog   → firewall block / pass events
  dhcpd       → DHCP lease events
  openvpn     → VPN tunnel events
  php/nginx   → interface up/down, auth failures, WAN state
  ppp         → WAN disconnect / reconnect
"""
import re
import logging
from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert

logger = logging.getLogger(__name__)

# RFC 3164: optional <PRI>, optional timestamp, optional hostname, process[pid]: message
_SYSLOG_RE = re.compile(
    r'^(?:<\d+>)?'
    r'(?:\w{3}\s{1,2}\d{1,2}\s+\d+:\d+:\d+\s+)?'
    r'(?:\S+\s+)?'
    r'(\S+?)(?:\[\d+\])?:\s*(.*)',
    re.DOTALL,
)


def _parse_filterlog_csv(msg: str) -> dict | None:
    """
    pfSense filterlog CSV layout (IPv4 / IPv6 combined, 20+ fields):
      0  rule_num, 1 sub_rule, 2 anchor, 3 tracker,
      4  iface,    5 reason,   6 action, 7 direction,
      8  ip_ver,   9 tos,     10 ecn,   11 ttl,
     12  id,      13 offset,  14 flags, 15 proto_id,
     16  proto,   17 length,  18 src,   19 dst,
     20+ port / icmp fields  (protocol-dependent)
    """
    parts = msg.split(',')
    if len(parts) < 20:
        return None
    try:
        return {
            'iface':    parts[4],
            'action':   parts[6],   # block | pass
            'direction': parts[7],  # in | out
            'ip_ver':   parts[8],   # 4 | 6
            'proto':    parts[16],  # tcp | udp | icmp | ...
            'src_ip':   parts[18],
            'dst_ip':   parts[19],
            'src_port': parts[20] if len(parts) > 20 else '',
            'dst_port': parts[21] if len(parts) > 21 else '',
        }
    except (IndexError, ValueError):
        return None


class PfSenseAdapter(BaseAdapter):
    source_slug = "pfsense"

    def parse(self, raw_payload: dict) -> RawAlert:
        """
        raw_payload must contain:
          raw_line  : str   — the full syslog line as received over UDP
          source_ip : str   — sender IP address (optional, for logging)
        """
        line = raw_payload.get('raw_line', '')
        m = _SYSLOG_RE.match(line)
        if not m:
            return self._unknown(raw_payload, line)

        process = m.group(1).lower().rstrip('/')
        msg     = m.group(2).strip()
        lower   = msg.lower()

        # ── filterlog: firewall events ────────────────────────────────────
        if process == 'filterlog':
            return self._firewall(msg, raw_payload)

        # ── DHCP ──────────────────────────────────────────────────────────
        if 'dhcpd' in process or 'dhcp' in process:
            return self._dhcp(msg, raw_payload)

        # ── OpenVPN ───────────────────────────────────────────────────────
        if 'openvpn' in process:
            return self._vpn(msg, raw_payload)

        # ── WAN / PPP ─────────────────────────────────────────────────────
        if process in ('ppp', 'mpd') or (
            'ppp' in lower and any(x in lower for x in ('link down', 'disconnected', 'lcp'))
        ):
            return self._wan(msg, raw_payload)

        # ── Interface up/down (PHP, kernel messages) ─────────────────────
        if any(x in lower for x in ('link up', 'link down', 'link state', 'carrier lost')):
            return self._interface(msg, raw_payload)

        # ── Authentication failures ───────────────────────────────────────
        if any(x in lower for x in ('authentication failure', 'failed password', 'invalid user', 'bad password', 'login failed')):
            return self._auth_failure(msg, raw_payload)

        # ── Generic syslog fallthrough ────────────────────────────────────
        return self._unknown(raw_payload, f"[{process}] {msg}")

    # ── Parsers ───────────────────────────────────────────────────────────

    def _firewall(self, msg: str, raw: dict) -> RawAlert:
        parsed = _parse_filterlog_csv(msg)
        if not parsed:
            return self._unknown(raw, f"[filterlog] {msg}")

        if parsed['action'] == 'block':
            src = parsed['src_ip']
            dport = parsed['dst_port'] or '?'
            proto = parsed['proto'].upper()
            iface = parsed['iface']
            fp_key = f"fw_block:{src}:{dport}"
            return RawAlert(
                source_slug=self.source_slug,
                event_type='firewall_block',
                title=f"Firewall blocked {proto} {src} → port {dport}",
                message=(
                    f"Blocked {proto} from {parsed['src_ip']}:{parsed['src_port']} "
                    f"to {parsed['dst_ip']}:{dport} "
                    f"on {iface} ({parsed['direction']})"
                ),
                severity='info',
                fingerprint_key=fp_key,
                raw_payload={**raw, 'parsed': parsed},
            )

        # pass — very low interest, suppress by default
        return RawAlert(
            source_slug=self.source_slug,
            event_type='firewall_pass',
            title='Firewall pass',
            message=msg[:200],
            severity='info',
            fingerprint_key=f"fw_pass:{msg[:60]}",
            raw_payload=raw,
        )

    def _interface(self, msg: str, raw: dict) -> RawAlert:
        lower = msg.lower()
        down  = 'link down' in lower or 'carrier lost' in lower
        ev    = 'interface_down' if down else 'interface_up'
        sev   = 'critical' if down else 'info'

        iface_m = re.search(r'\b(em\d+|igb\d+|vtnet\d+|bge\d+|re\d+|wan|lan|opt\d*)\b', msg, re.I)
        iface = iface_m.group(1).upper() if iface_m else 'unknown'

        return RawAlert(
            source_slug=self.source_slug,
            event_type=ev,
            title=f"Interface {iface} {'went DOWN' if down else 'came UP'}",
            message=msg[:300],
            severity=sev,
            fingerprint_key=f"{ev}:{iface}",
            raw_payload=raw,
        )

    def _wan(self, msg: str, raw: dict) -> RawAlert:
        lower = msg.lower()
        down  = any(x in lower for x in ('link down', 'disconnected', 'lost', 'down', 'lcp down'))
        return RawAlert(
            source_slug=self.source_slug,
            event_type='wan_down' if down else 'wan_up',
            title=f"WAN {'connection lost' if down else 'connection restored'}",
            message=msg[:300],
            severity='critical' if down else 'info',
            fingerprint_key='wan_state',
            raw_payload=raw,
        )

    def _vpn(self, msg: str, raw: dict) -> RawAlert:
        lower = msg.lower()
        error = any(x in lower for x in ('error', 'failed', 'timeout', 'disconnected', 'tls key'))
        return RawAlert(
            source_slug=self.source_slug,
            event_type='vpn_error' if error else 'vpn_info',
            title=f"OpenVPN {'error' if error else 'event'}",
            message=msg[:300],
            severity='critical' if error else 'info',
            fingerprint_key=f"vpn:{msg[:60]}",
            raw_payload=raw,
        )

    def _dhcp(self, msg: str, raw: dict) -> RawAlert:
        ip_m = re.search(r'\b(\d{1,3}(?:\.\d{1,3}){3})\b', msg)
        ip = ip_m.group(1) if ip_m else 'unknown'
        return RawAlert(
            source_slug=self.source_slug,
            event_type='dhcp_event',
            title=f"DHCP: {msg[:80]}",
            message=msg[:300],
            severity='info',
            fingerprint_key=f"dhcp:{ip}",
            raw_payload=raw,
        )

    def _auth_failure(self, msg: str, raw: dict) -> RawAlert:
        return RawAlert(
            source_slug=self.source_slug,
            event_type='auth_failure',
            title='Authentication failure on pfSense',
            message=msg[:300],
            severity='warning',
            fingerprint_key='auth_failure:pfsense',
            raw_payload=raw,
        )

    def _unknown(self, raw: dict, line: str) -> RawAlert:
        short = line[:80]
        return RawAlert(
            source_slug=self.source_slug,
            event_type='syslog_event',
            title=f"pfSense: {short}",
            message=line[:300],
            severity='info',
            fingerprint_key=f"syslog:{short}",
            raw_payload=raw,
        )
