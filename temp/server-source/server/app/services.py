from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import Device, RefreshToken, Subscription, User
from .security import EntitlementSigner, create_access_token, new_refresh_token, secure_token_hash
from .timeutils import as_utc


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def active_subscription(db: Session, user_id: str) -> Subscription | None:
    now = utcnow()
    return db.scalar(
        select(Subscription)
        .where(Subscription.user_id == user_id, Subscription.status == 'active', Subscription.expires_at > now)
        .order_by(Subscription.expires_at.desc())
    )


def create_entitlement(settings: Settings, signer: EntitlementSigner, *, user: User, device: Device, subscription: Subscription | None) -> tuple[str | None, dict]:
    now = utcnow()
    if not subscription:
        return None, {'plan': 'free', 'status': 'inactive', 'expires_at': None, 'refresh_after': None, 'offline_until': None}
    subscription_expires = as_utc(subscription.expires_at)
    refresh_after = min(subscription_expires, now + timedelta(hours=settings.entitlement_refresh_hours))
    offline_until = min(subscription_expires, now + timedelta(hours=settings.entitlement_grace_hours))
    payload = {
        'licenseId': subscription.id,
        'tier': 'premium',
        'issuedAt': int(now.timestamp() * 1000),
        'refreshAfter': int(refresh_after.timestamp() * 1000),
        'expiresAt': int(offline_until.timestamp() * 1000),
        'subscriptionExpiresAt': int(subscription_expires.timestamp() * 1000),
        'customer': user.email,
        'userId': user.id,
        'deviceId': device.device_id,
        'features': ['pipelines', 'multi_input_pipelines', 'pinned_pipeline_buttons'],
        'nonce': secrets.token_urlsafe(12),
    }
    token = signer.sign(payload)
    return token, {
        'plan': 'pro',
        'status': subscription.status,
        'expires_at': subscription_expires,
        'refresh_after': refresh_after,
        'offline_until': offline_until,
    }


def issue_session(db: Session, settings: Settings, signer: EntitlementSigner, *, user: User, device: Device) -> tuple[str, str, str | None]:
    access = create_access_token(settings, user_id=user.id, email=user.email, device_id=device.device_id)
    raw_refresh = new_refresh_token()
    db.add(RefreshToken(
        user_id=user.id,
        device_id=device.device_id,
        token_hash=secure_token_hash(raw_refresh),
        expires_at=utcnow() + timedelta(days=settings.refresh_token_days),
    ))
    subscription = active_subscription(db, user.id)
    entitlement_token, _ = create_entitlement(settings, signer, user=user, device=device, subscription=subscription)
    return access, raw_refresh, entitlement_token
