from fastapi import Header, HTTPException
from backend.config import settings


async def verify_api_key(x_api_key: str = Header(...)) -> None:
    if x_api_key != settings.API_SECRET_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


async def verify_collector_key(x_collector_key: str = Header(...)) -> None:
    if x_collector_key != settings.COLLECTOR_SECRET:
        raise HTTPException(status_code=401, detail="Invalid collector key")
