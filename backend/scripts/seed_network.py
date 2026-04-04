"""
Seed script: inserts fake network monitoring data for UI development.
Run manually against a live database — never run in production.

Usage:
    python -m backend.scripts.seed_network
    # or with a specific DATABASE_URL:
    DATABASE_URL=postgresql+asyncpg://... python -m backend.scripts.seed_network
"""
import asyncio
import random
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from backend.config import settings

NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Fake data pools
# ---------------------------------------------------------------------------

DEVICES = [
    {"ip": "192.168.1.10", "mac": "aa:bb:cc:dd:ee:01", "hostname": "wkstn-alex",      "switch_id": "SW01", "port_id": "Gi0/1",  "device_type": "workstation"},
    {"ip": "192.168.1.11", "mac": "aa:bb:cc:dd:ee:02", "hostname": "wkstn-campbell",  "switch_id": "SW01", "port_id": "Gi0/2",  "device_type": "workstation"},
    {"ip": "192.168.1.20", "mac": "aa:bb:cc:dd:ee:03", "hostname": "srv-dc01",         "switch_id": "SW01", "port_id": "Gi0/24", "device_type": "server"},
    {"ip": "192.168.1.30", "mac": "aa:bb:cc:dd:ee:04", "hostname": "ap-floor1",        "switch_id": "SW02", "port_id": "Gi0/3",  "device_type": "ap"},
    {"ip": "192.168.1.50", "mac": "aa:bb:cc:dd:ee:05", "hostname": "prt-reception",    "switch_id": "SW02", "port_id": "Gi0/5",  "device_type": "printer"},
]

LATENCY_TARGETS = [
    {"name": "Gateway",  "ip": "192.168.1.1", "type": "gateway"},
    {"name": "Google DNS", "ip": "8.8.8.8",  "type": "wan"},
    {"name": "Cloudflare", "ip": "1.1.1.1",  "type": "dns"},
]

SWITCHES = [
    {"switch_id": "SW01", "switch_name": "Core Switch (MDF)"},
    {"switch_id": "SW02", "switch_name": "Access Switch (Floor 1)"},
]

PORTS = [
    {"switch_id": "SW01", "port_id": "Gi0/1",  "port_name": "wkstn-alex",     "device_name": "wkstn-alex",    "device_ip": "192.168.1.10", "is_uplink": False},
    {"switch_id": "SW01", "port_id": "Gi0/2",  "port_name": "wkstn-campbell", "device_name": "wkstn-campbell","device_ip": "192.168.1.11", "is_uplink": False},
    {"switch_id": "SW01", "port_id": "Gi0/24", "port_name": "srv-dc01",       "device_name": "srv-dc01",      "device_ip": "192.168.1.20", "is_uplink": False},
    {"switch_id": "SW01", "port_id": "Gi0/48", "port_name": "Uplink-SW02",    "device_name": None,            "device_ip": None,           "is_uplink": True},
    {"switch_id": "SW02", "port_id": "Gi0/3",  "port_name": "ap-floor1",      "device_name": "ap-floor1",     "device_ip": "192.168.1.30", "is_uplink": False},
]

FLOW_DIRECTIONS = ["inbound", "outbound", "internal"]
PROTOCOLS = [6, 17, 1]  # TCP, UDP, ICMP


def _ago(minutes: int) -> datetime:
    return NOW - timedelta(minutes=minutes)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def build_device_registry_rows() -> list[dict]:
    rows = []
    for d in DEVICES:
        rows.append({
            "ip":          d["ip"],
            "mac":         d["mac"],
            "hostname":    d["hostname"],
            "switch_id":   d["switch_id"],
            "port_id":     d["port_id"],
            "last_seen":   _ago(random.randint(0, 10)),
            "first_seen":  _ago(random.randint(1440, 10080)),
            "is_online":   random.choice([True, True, True, False]),
            "device_type": d["device_type"],
            "notes":       None,
        })
    return rows


def build_switch_port_metrics_rows(n: int = 50) -> list[dict]:
    rows = []
    for i in range(n):
        port = random.choice(PORTS)
        sw_info = next(s for s in SWITCHES if s["switch_id"] == port["switch_id"])
        t = _ago(random.randint(0, 120))
        multiplier = 10 if port["is_uplink"] else 1
        rows.append({
            "time":        t,
            "switch_id":   port["switch_id"],
            "switch_name": sw_info["switch_name"],
            "port_id":     port["port_id"],
            "port_name":   port["port_name"],
            "device_name": port["device_name"],
            "device_ip":   port["device_ip"],
            "rx_bytes":    random.randint(1_000_000, 500_000_000) * multiplier,
            "tx_bytes":    random.randint(500_000,   200_000_000) * multiplier,
            "rx_errors":   random.randint(0, 5),
            "tx_errors":   random.randint(0, 2),
            "rx_packets":  random.randint(10_000, 500_000) * multiplier,
            "tx_packets":  random.randint(5_000,  300_000) * multiplier,
            "poe_watts":   round(random.uniform(3.0, 15.4), 1) if not port["is_uplink"] else None,
            "is_uplink":   port["is_uplink"],
        })
    return rows


def build_latency_metrics_rows(n: int = 100) -> list[dict]:
    rows = []
    for i in range(n):
        target = random.choice(LATENCY_TARGETS)
        # Occasional packet loss spike
        loss = 0.0 if random.random() > 0.05 else round(random.uniform(1.0, 25.0), 1)
        rows.append({
            "time":           _ago(random.randint(0, 120)),
            "target_name":    target["name"],
            "target_ip":      target["ip"],
            "target_type":    target["type"],
            "rtt_ms":         round(random.uniform(0.8, 45.0), 2),
            "packet_loss_pct": loss,
        })
    return rows


def build_network_flows_rows(n: int = 200) -> list[dict]:
    internal_ips = [d["ip"] for d in DEVICES]
    external_ips = ["1.1.1.1", "8.8.8.8", "151.101.1.140", "93.184.216.34", "104.16.0.0"]
    rows = []
    for i in range(n):
        direction = random.choice(FLOW_DIRECTIONS)
        if direction == "inbound":
            src, dst = random.choice(external_ips), random.choice(internal_ips)
        elif direction == "outbound":
            src, dst = random.choice(internal_ips), random.choice(external_ips)
        else:
            src, dst = random.choice(internal_ips), random.choice(internal_ips)
            if src == dst:
                continue

        protocol = random.choice(PROTOCOLS)
        device = next((d for d in DEVICES if d["ip"] == src), None)
        rows.append({
            "time":        _ago(random.randint(0, 120)),
            "src_ip":      src,
            "dst_ip":      dst,
            "src_port":    random.randint(1024, 65535),
            "dst_port":    random.choice([80, 443, 53, 22, 3389, 445, 8080]),
            "protocol":    protocol,
            "bytes":       random.randint(64, 1_500_000),
            "packets":     random.randint(1, 1000),
            "device_name": device["hostname"] if device else None,
            "direction":   direction,
        })
    return rows


# ---------------------------------------------------------------------------
# Insert helpers
# ---------------------------------------------------------------------------

async def _insert(session: AsyncSession, table: str, rows: list[dict]) -> None:
    if not rows:
        return
    cols = list(rows[0].keys())
    col_list  = ", ".join(cols)
    val_list  = ", ".join(f":{c}" for c in cols)
    stmt = text(f"INSERT INTO {table} ({col_list}) VALUES ({val_list})")
    for row in rows:
        await session.execute(stmt, row)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    print(f"Connecting to: {settings.DATABASE_URL[:40]}...")
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with async_session() as session:
        async with session.begin():
            print("Clearing existing seed data...")
            for table in ["network_flows", "switch_port_metrics", "latency_metrics",
                          "collector_heartbeat", "network_incidents", "device_registry"]:
                await session.execute(text(f"DELETE FROM {table}"))

            print("Inserting device_registry (5 devices)...")
            await _insert(session, "device_registry", build_device_registry_rows())

            spm_rows = build_switch_port_metrics_rows(50)
            print(f"Inserting switch_port_metrics ({len(spm_rows)} rows)...")
            await _insert(session, "switch_port_metrics", spm_rows)

            lat_rows = build_latency_metrics_rows(100)
            print(f"Inserting latency_metrics ({len(lat_rows)} rows)...")
            await _insert(session, "latency_metrics", lat_rows)

            flow_rows = build_network_flows_rows(200)
            print(f"Inserting network_flows ({len(flow_rows)} rows)...")
            await _insert(session, "network_flows", flow_rows)

            # One heartbeat row so the UI can show collector status
            await _insert(session, "collector_heartbeat", [{
                "collector_id": "collector-01",
                "last_seen":    _ago(1),
                "version":      "0.1.0-dev",
                "sources":      '{"goflow2": true, "telegraf": true, "fping": true}',
            }])

            print("Done. Committed all seed data.")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
