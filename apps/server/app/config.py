from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import EmailStr, Field, HttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    environment: str = 'development'
    app_name: str = 'WhatsApp Media Assist'
    api_base_url: HttpUrl = 'http://localhost:8787'
    frontend_success_url: HttpUrl = 'http://localhost:8787/payment-complete'
    database_url: str = 'sqlite:////data/media-assist.db'

    jwt_secret: str = Field(min_length=32)
    otp_pepper: str = Field(min_length=32)
    admin_api_key: str = Field(min_length=6)
    entitlement_private_key_path: Path = Path('/run/secrets/entitlement_private_key.pem')

    access_token_minutes: int = 15
    refresh_token_days: int = 30
    otp_ttl_minutes: int = 10
    otp_cooldown_seconds: int = 60
    otp_max_attempts: int = 5
    otp_ip_hourly_limit: int = 12
    otp_email_daily_limit: int = 12
    max_devices: int = 1
    entitlement_refresh_minutes: int = 10
    entitlement_grace_minutes: int = 15
    annual_license_days: int = 365
    max_settings_bytes: int = 262_144

    price_inr_minor: int = 50000
    price_usd_minor: int = 499
    enable_inr_checkout: bool = True
    enable_usd_checkout: bool = False

    razorpay_key_id: str = ''
    razorpay_key_secret: str = ''
    razorpay_webhook_secret: str = ''
    razorpay_api_url: str = 'https://api.razorpay.com/v1'

    brevo_api_key: str = ''
    brevo_sender_email: EmailStr = 'no-reply.mediaassit@002529.xyz'
    brevo_sender_name: str = 'WhatsApp Media Assist'
    brevo_sandbox: bool = False

    allowed_origins: str = ''

    @field_validator('environment')
    @classmethod
    def validate_environment(cls, value: str) -> str:
        if value not in {'development', 'test', 'production'}:
            raise ValueError('environment must be development, test, or production')
        return value

    @property
    def origin_list(self) -> list[str]:
        return [item.strip() for item in self.allowed_origins.split(',') if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
