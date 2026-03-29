from backend.adapters.base import BaseAdapter
from backend.schemas import RawAlert


class PingPlotterAdapter(BaseAdapter):
    source_slug = "pingplotter"

    def parse(self, raw_payload: dict) -> RawAlert:
        target = raw_payload.get("target", "unknown")
        packet_loss = float(raw_payload.get("packet_loss_pct", 0))
        latency = float(raw_payload.get("avg_latency_ms", 0))
        event_type = raw_payload.get("event_type", "latency_spike")
        if event_type == "unreachable" or packet_loss >= 100:
            severity = "critical"
        elif packet_loss > 5:
            severity = "critical"
        elif packet_loss > 1 or latency > 200:
            severity = "warning"
        elif latency > 100:
            severity = "warning"
        elif event_type == "resolved":
            severity = "ok"
        else:
            severity = "info"
        if event_type == "unreachable":
            title = f"Target unreachable: {target}"
        elif event_type == "resolved":
            title = f"Network restored: {target}"
        elif packet_loss > 0:
            title = f"Packet loss {packet_loss:.1f}% to {target}"
        else:
            title = f"Latency spike {latency:.0f}ms to {target}"
        parts = [f"Target: {target}"]
        if packet_loss > 0: parts.append(f"Packet loss: {packet_loss:.1f}%")
        if latency > 0: parts.append(f"Avg latency: {latency:.0f}ms")
        return RawAlert(source_slug=self.source_slug, event_type=event_type, title=title, message=" | ".join(parts), severity=severity, fingerprint_key=f"{target}:{event_type}", raw_payload=raw_payload)
