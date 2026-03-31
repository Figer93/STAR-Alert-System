from backend.adapters.pfsense_adapter import PfSenseAdapter
from backend.adapters.ninjarmm_adapter import NinjaRMMAdapter
from backend.adapters.pingplotter_adapter import PingPlotterAdapter
from backend.adapters.unifi_adapter import UniFiAdapter

ADAPTER_REGISTRY = {
    "pfsense": PfSenseAdapter,
    "ninjarmm": NinjaRMMAdapter,
    "pingplotter": PingPlotterAdapter,
    "unifi": UniFiAdapter,
}

__all__ = ["PfSenseAdapter", "NinjaRMMAdapter", "PingPlotterAdapter", "UniFiAdapter", "ADAPTER_REGISTRY"]
