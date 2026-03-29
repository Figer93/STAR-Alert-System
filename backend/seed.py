import asyncio
import hashlib
from datetime import datetime, timezone, timedelta
from backend.database import init_db, AsyncSessionLocal
from backend.models import Source, Alert


def fp(source_slug: str, event_type: str, key: str) -> str:
    return hashlib.sha256(f"{source_slug}:{event_type}:{key}".encode()).hexdigest()


SOURCES = [
    Source(name="pfSense", slug="pfsense", adapter="PfSenseAdapter", type="syslog", enabled=True, status="online", config={"syslog_port": 514}),
    Source(name="NinjaRMM", slug="ninjarmm", adapter="NinjaRMMAdapter", type="webhook", enabled=True, status="online", config={}),
    Source(name="PingPlotter", slug="pingplotter", adapter="PingPlotterAdapter", type="webhook", enabled=True, status="online", config={}),
]


async def seed():
    await init_db()
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select, func
        count = (await db.execute(select(func.count()).select_from(Source))).scalar_one()
        if count > 0:
            print("Database already seeded.")
            return
        now = datetime.now(timezone.utc)
        pfsense, ninjarmm, pingplotter = SOURCES[0], SOURCES[1], SOURCES[2]
        db.add_all([pfsense, ninjarmm, pingplotter])
        await db.flush()
        alerts = [
            Alert(source_id=ninjarmm.id, severity="critical", title="SRV01 Device Offline", message="SRV01 has gone offline.", raw_payload={}, fingerprint=fp("ninjarmm", "device_offline", "SRV01"), status="active", first_seen=now-timedelta(minutes=5), last_seen=now, occurrence_count=1),
            Alert(source_id=pfsense.id, severity="warning", title="WAN Auth Failures", message="5 auth failures from 203.0.113.42.", raw_payload={}, fingerprint=fp("pfsense", "auth_failure", "admin"), status="active", first_seen=now-timedelta(minutes=30), last_seen=now, occurrence_count=2),
            Alert(source_id=pingplotter.id, severity="warning", title="Packet loss to 192.168.1.1", message="4.2% packet loss to gateway.", raw_payload={}, fingerprint=fp("pingplotter", "packet_loss", "192.168.1.1"), status="active", first_seen=now-timedelta(minutes=20), last_seen=now, occurrence_count=4),
        ]
        db.add_all(alerts)
        await db.commit()
        print(f"Seeded {len(SOURCES)} sources and {len(alerts)} alerts.")


if __name__ == "__main__":
    asyncio.run(seed())
