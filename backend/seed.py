"""
Seed script — populates the DB with 3 sources and 6 realistic mock alerts.
Run: python -m backend.seed
"""
import asyncio
import hashlib
from datetime import datetime, timezone, timedelta

from backend.database import init_db, AsyncSessionLocal
from backend.models import Source, Alert


def fp(source_slug: str, event_type: str, key: str) -> str:
    raw = f"{source_slug}:{event_type}:{key}"
    return hashlib.sha256(raw.encode()).hexdigest()


SOURCES = [
    Source(
        name="pfSense",
        slug="pfsense",
        adapter="PfSenseAdapter",
        type="syslog",
        enabled=True,
        status="online",
        config={"syslog_port": 514},
    ),
    Source(
        name="NinjaRMM",
        slug="ninjarmm",
        adapter="NinjaRMMAdapter",
        type="webhook",
        enabled=True,
        status="online",
        config={},
    ),
    Source(
        name="PingPlotter",
        slug="pingplotter",
        adapter="PingPlotterAdapter",
        type="webhook",
        enabled=True,
        status="online",
        config={},
    ),
]


def make_alerts(pfsense_id: int, ninjarmm_id: int, pingplotter_id: int) -> list[Alert]:
    now = datetime.now(timezone.utc)

    return [
        Alert(
            source_id=ninjarmm_id,
            severity="critical",
            title="SRV01 — Device Offline",
            message="NinjaRMM reports SRV01 (192.168.1.10) has gone offline. Last check-in: 5 minutes ago.",
            raw_payload={
                "eventType": "DEVICE_OFFLINE",
                "deviceId": 101,
                "deviceName": "SRV01",
                "organizationName": "ST&R Limited",
                "timestamp": now.isoformat(),
                "details": {"lastSeen": (now - timedelta(minutes=5)).isoformat()},
            },
            fingerprint=fp("ninjarmm", "device_offline", "SRV01:DEVICE_OFFLINE"),
            status="active",
            first_seen=now - timedelta(minutes=5),
            last_seen=now - timedelta(minutes=1),
            occurrence_count=1,
        ),
        Alert(
            source_id=ninjarmm_id,
            severity="warning",
            title="PC-ACCOUNTS — CPU Sustained Above 80%",
            message="CPU usage has been above 80% for the past 15 minutes on PC-ACCOUNTS.",
            raw_payload={
                "eventType": "CPU_USAGE_HIGH",
                "deviceId": 204,
                "deviceName": "PC-ACCOUNTS",
                "organizationName": "ST&R Limited",
                "timestamp": (now - timedelta(minutes=15)).isoformat(),
                "details": {"cpuPercent": 87, "durationMinutes": 15},
            },
            fingerprint=fp("ninjarmm", "cpu_usage_high", "PC-ACCOUNTS:CPU_USAGE_HIGH"),
            status="active",
            first_seen=now - timedelta(minutes=15),
            last_seen=now - timedelta(minutes=2),
            occurrence_count=3,
        ),
        Alert(
            source_id=pfsense_id,
            severity="critical",
            title="WAN Interface Down",
            message="WAN interface (em0) has gone down. External connectivity is unavailable.",
            raw_payload={
                "facility": "local0",
                "hostname": "pfsense.local",
                "event_type": "interface_down",
                "interface": "em0",
                "message": "DEVD: interface em0 link down",
            },
            fingerprint=fp("pfsense", "interface_down", "em0"),
            status="acknowledged",
            first_seen=now - timedelta(hours=1),
            last_seen=now - timedelta(minutes=45),
            occurrence_count=1,
            acknowledged_by="alex",
            acknowledged_at=now - timedelta(minutes=50),
        ),
        Alert(
            source_id=pfsense_id,
            severity="warning",
            title="Multiple Auth Failures — admin",
            message="5 authentication failures for user 'admin' from 203.0.113.42 within 1 minute.",
            raw_payload={
                "facility": "auth",
                "hostname": "pfsense.local",
                "event_type": "auth_failure",
                "user": "admin",
                "source_ip": "203.0.113.42",
                "count": 5,
            },
            fingerprint=fp("pfsense", "auth_failure", "admin:203.0.113.42"),
            status="active",
            first_seen=now - timedelta(minutes=30),
            last_seen=now - timedelta(minutes=28),
            occurrence_count=2,
        ),
        Alert(
            source_id=pingplotter_id,
            severity="critical",
            title="Network issue — 8.8.8.8",
            message="Target 8.8.8.8 unreachable. Packet loss: 100%. Avg latency: N/A.",
            raw_payload={
                "target": "8.8.8.8",
                "event_type": "unreachable",
                "packet_loss_pct": 100,
                "avg_latency_ms": None,
                "hop_count": 4,
            },
            fingerprint=fp("pingplotter", "unreachable", "8.8.8.8:unreachable"),
            status="resolved",
            first_seen=now - timedelta(hours=2),
            last_seen=now - timedelta(hours=1, minutes=45),
            occurrence_count=1,
            resolved_at=now - timedelta(hours=1, minutes=40),
        ),
        Alert(
            source_id=pingplotter_id,
            severity="warning",
            title="Network issue — 192.168.1.1",
            message="Target 192.168.1.1 (gateway) reporting elevated packet loss: 4.2%. Avg latency: 38ms.",
            raw_payload={
                "target": "192.168.1.1",
                "event_type": "packet_loss",
                "packet_loss_pct": 4.2,
                "avg_latency_ms": 38,
                "hop_count": 1,
            },
            fingerprint=fp("pingplotter", "packet_loss", "192.168.1.1:packet_loss"),
            status="active",
            first_seen=now - timedelta(minutes=20),
            last_seen=now - timedelta(minutes=5),
            occurrence_count=4,
        ),
    ]


async def seed():
    await init_db()

    async with AsyncSessionLocal() as db:
        # Check if already seeded
        from sqlalchemy import select, func
        count = (await db.execute(select(func.count()).select_from(Source))).scalar_one()
        if count > 0:
            print("Database already seeded — skipping.")
            return

        # Insert sources
        pfsense = SOURCES[0]
        ninjarmm = SOURCES[1]
        pingplotter = SOURCES[2]
        db.add_all([pfsense, ninjarmm, pingplotter])
        await db.flush()

        # Insert alerts
        alerts = make_alerts(pfsense.id, ninjarmm.id, pingplotter.id)
        db.add_all(alerts)
        await db.commit()

        print(f"Seeded {len(SOURCES)} sources and {len(alerts)} alerts.")


if __name__ == "__main__":
    asyncio.run(seed())
