from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "ST&R Alert Dashboard"
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    DEBUG: bool = False

    DATABASE_URL: str = "sqlite+aiosqlite:///./alerts.db"

    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_CHAT_IDS: str = ""  # comma-separated

    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    EMAIL_FROM: str = ""
    EMAIL_TO: str = ""  # comma-separated

    PFSENSE_SYSLOG_PORT: int = 514
    PFSENSE_SYSLOG_ENABLED: bool = True

    NINJARMM_WEBHOOK_SECRET: str = ""
    PINGPLOTTER_WEBHOOK_SECRET: str = ""

    DEFAULT_DEDUP_WINDOW_MINUTES: int = 30
    DEFAULT_COOLDOWN_MINUTES: int = 15
    CRITICAL_COOLDOWN_MINUTES: int = 5

    VITE_API_URL: str = "http://localhost:8000"
    VITE_WS_URL: str = "ws://localhost:8000/ws"

    # Public-facing URL of the dashboard, used in Telegram alert messages.
    # Leave blank to omit links from notifications.
    STAR_URL: str = ""

    # LAN default gateway — pfSense router IP on the LAN segment.
    # Used by the Investigate page "Gateway Latency" chart to find the right
    # latency_metrics row (collector stores all LAN pings as target_type='internal').
    LAN_GATEWAY_IP: str = "10.2.1.253"

    # ISP gateway IPs (first WAN hop).  Set WAN1/WAN2 for dual-uplink sites.
    # WAN_GATEWAY_IP is kept for backward compatibility (single-uplink sites).
    WAN_GATEWAY_IP: str = ""   # legacy single-WAN — superseded by WAN1/WAN2 below
    WAN1_GATEWAY_IP: str = ""  # primary WAN gateway (WANGW)
    WAN2_GATEWAY_IP: str = ""  # secondary WAN gateway (WAN2_GATEWAY)

    # API authentication — both required; app refuses to start if not set.
    # API_SECRET_KEY:    sent as X-API-Key header by the frontend and any API client.
    # COLLECTOR_SECRET:  sent as X-Collector-Key header by the on-premise collector.
    API_SECRET_KEY:   str  # no default — raises ValidationError on startup if missing
    COLLECTOR_SECRET: str  # no default — raises ValidationError on startup if missing

    # UniFi Cloud API (api.ui.com)
    # Leave UNIFI_CLOUD_API_KEY blank to disable cloud polling.
    UNIFI_CLOUD_API_KEY: str = ""
    UNIFI_HOST_ID: str = "e70a1e78-a306-4df2-8e18-e212c14c7b5a:363267911"
    UNIFI_SITE_ID: str = "6176ab9954495f16906692ce"

    @property
    def telegram_chat_id_list(self) -> List[str]:
        return [cid.strip() for cid in self.TELEGRAM_CHAT_IDS.split(",") if cid.strip()]

    @property
    def email_to_list(self) -> List[str]:
        return [addr.strip() for addr in self.EMAIL_TO.split(",") if addr.strip()]


settings = Settings()
