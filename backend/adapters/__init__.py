from backend.adapters.pfsense_adapter import PfSenseAdapter
from backend.adapters.ninjarmm_adapter import NinjaRMMAdapter
from backend.adapters.pingplotter_adapter import PingPlotterAdapter

ADAPTER_REGISTRY = {"pfsense": PfSenseAdapter, "ninjarmm": NinjaRMMAdapter, "pingplotter": PingPlotterAdapter}
__all__ = ["PfSenseAdapter", "NinjaRMMAdapter", "PingPlotterAdapter", "ADAPTER_REGISTRY"]
