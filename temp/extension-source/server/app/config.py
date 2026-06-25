from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import EmailStr, Field, HttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    environment: str = 'development'
    app_name: str = 'Media Assist'
    api_base_url: HttpUrl = 'http://localhost:8787'
    frontend_success_url: HttpUrl = 'http://localhost:8787/payment-complete'

    # SQLite by default — lightweight, zero-config, perfectly adequate for this
    # scale. Override via DATABASE_URL env var to use PostgreSQL in production
    # if needed, but SQLite on a single server is strongly preferred.
    database_url: str = 'sqlite:///./mediaassist.db'

    jwt_secret: str = Field(min_length=32)
    otp_pepper: str = Field(min_length=32)
    admin_api_key: str = Field(min_length=24)
    entitlement_private_key_path: Path = Path('/run/secrets/entitlement_private_key.pem')

    access_token_minutes: int = 15
    refresh_token_days: int = 30
    otp_ttl_minutes: int = 10
    otp_cooldown_seconds: int = 60
    otp_max_attempts: int = 5
    otp_ip_hourly_limit: int = 12
    otp_email_daily_limit: int = 12

    # Single-device policy: logging in on a new device automatically signs out
    # the previous one. max_devices is kept for the DB query logic but is always 1.
    max_devices: int = 1

    entitlement_refresh_hours: int = 24
    entitlement_grace_hours: int = 72
    annual_license_days: int = 365

    # Pricing — one plan, two currencies.
    # INR: ₹499 / year  (Razorpay amount in paise:  49900)
    # USD: $7.99 / year (Razorpay amount in cents:    799)
    price_inr_minor: int = 49900
    price_usd_minor: int = 799
    enable_inr_checkout: bool = True
    enable_usd_checkout: bool = True  # International payments enabled

    razorpay_key_id: str = ''
    razorpay_key_secret: str = ''
    razorpay_webhook_secret: str = ''
    razorpay_api_url: str = 'https://api.razorpay.com/v1'

    brevo_api_key: str = ''
    brevo_sender_email: EmailStr = 'no-reply@002529.xyz'
    brevo_sender_name: str = 'Media Assist'
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
