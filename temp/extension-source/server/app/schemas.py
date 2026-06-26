from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator


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
