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

    @property
    def telegram_chat_id_list(self) -> List[str]:
        return [cid.strip() for cid in self.TELEGRAM_CHAT_IDS.split(",") if cid.strip()]

    @property
    def email_to_list(self) -> List[str]:
        return [addr.strip() for addr in self.EMAIL_TO.split(",") if addr.strip()]


settings = Settings()
