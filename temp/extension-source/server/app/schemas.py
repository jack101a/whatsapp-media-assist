from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class MessageResponse(BaseModel):
    ok: bool = True
    message: str


class RequestOtpRequest(BaseModel):
    email: EmailStr


class VerifyOtpRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r'^\d{6}$')
    device_id: str = Field(min_length=16, max_length=128)
    device_name: str = Field(default='Browser', min_length=1, max_length=160)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=32)
    device_id: str = Field(min_length=16, max_length=128)


class SignOutRequest(RefreshRequest):
    pass


class CheckoutRequest(BaseModel):
    currency: Literal['INR', 'USD'] = 'INR'
    plan_id: str | None = None


class SettingsSyncResponse(BaseModel):
    revision: int = 0
    updated_at: datetime | None = None
    settings: dict[str, Any] | None = None


class SettingsSyncRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    settings: dict[str, Any]

    @field_validator('settings')
    @classmethod
    def validate_settings(cls, value: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(value, separators=(',', ':'), ensure_ascii=False)
        if len(encoded.encode('utf-8')) > 262_144:
            raise ValueError('Settings are too large')
        profiles = value.get('profiles', [])
        if not isinstance(profiles, list) or len(profiles) > 50:
            raise ValueError('Too many pipelines')
        for profile in profiles:
            if not isinstance(profile, dict):
                raise ValueError('Invalid pipeline')
            if len(str(profile.get('name', ''))) > 48:
                raise ValueError('Pipeline name is too long')
            steps = profile.get('steps', [])
            if not isinstance(steps, list) or len(steps) > 20:
                raise ValueError('Pipeline has too many steps')
        return value


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = 'bearer'
    entitlement_token: str | None = None
    email: EmailStr
    settings_sync: SettingsSyncResponse | None = None


class EntitlementResponse(BaseModel):
    plan: Literal['free', 'pro']
    status: str
    expires_at: datetime | None = None
    refresh_after: datetime | None = None
    offline_until: datetime | None = None
    entitlement_token: str | None = None


class ProductPrice(BaseModel):
    currency: Literal['INR', 'USD']
    amount_minor: int
    label: str


class ProductResponse(BaseModel):
    name: str = 'Media Assist Pro'
    duration_days: int
    prices: list[ProductPrice]


class CheckoutResponse(BaseModel):
    checkout_url: str
    reference_id: str
    expires_at: datetime
    currency: Literal['INR', 'USD']
    amount_minor: int


class DeviceResponse(BaseModel):
    device_id: str
    name: str
    current: bool
    last_seen_at: datetime
    created_at: datetime


class AccountResponse(BaseModel):
    email: EmailStr
    devices: list[DeviceResponse]
    entitlement: EntitlementResponse
    settings_sync: SettingsSyncResponse


class TemplateCreate(BaseModel):
    id: str = Field(min_length=1, max_length=36)
    name: str = Field(min_length=1, max_length=100)
    category: str = Field(min_length=1, max_length=50)
    payload: dict[str, Any] | list[Any]


class TemplateResponse(BaseModel):
    id: str
    name: str
    category: str | None = None
    payload: dict[str, Any] | list[Any]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PlanCreate(BaseModel):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[a-z0-9][a-z0-9_-]*$')
    name: str = Field(min_length=1, max_length=100)
    tier: Literal['premium'] = 'premium'
    price_inr_minor: int = Field(default=50000, ge=0)
    price_usd_minor: int = Field(default=499, ge=0)
    duration_days: int = Field(default=365, ge=1)
    features: list[str] = Field(default_factory=list)


class PlanResponse(BaseModel):
    id: str
    name: str
    tier: str
    price_inr_minor: int
    price_usd_minor: int
    duration_days: int
    features: list[str]
    created_at: datetime
    updated_at: datetime


class AdminUserResponse(BaseModel):
    id: str
    email: EmailStr
    plan_id: str | None = None
    plan_name: str | None = None
    subscription_status: str | None = None
    subscription_expires_at: datetime | None = None
    device_count: int
    settings_revision: int
    created_at: datetime


class AdminUserSubscriptionUpdate(BaseModel):
    plan_id: str
    starts_at: datetime | None = None
    expires_at: datetime
    status: Literal['active', 'cancelled'] = 'active'
    amount_minor: int = Field(default=0, ge=0)
    currency: Literal['INR', 'USD'] = 'INR'


class BackupResponse(BaseModel):
    filename: str
    size_bytes: int
    created_at: datetime


class AuditLogResponse(BaseModel):
    id: str
    action: str
    details: str | None = None
    created_at: datetime


class StatsResponse(BaseModel):
    total_users: int
    active_subscriptions: int
    total_devices: int
    projected_arr: int
    db_size_bytes: int
    wal_size_bytes: int
    last_backup_at: datetime | None = None
