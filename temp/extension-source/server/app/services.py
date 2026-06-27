from __future__ import annotations

import secrets
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import Device, Plan, RefreshToken, Subscription, Template, User
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
    refresh_after = min(subscription_expires, now + timedelta(minutes=settings.entitlement_refresh_minutes))
    offline_until = min(subscription_expires, now + timedelta(minutes=settings.entitlement_grace_minutes))
    features = ['pipelines', 'multi_input_pipelines', 'pinned_pipeline_buttons']
    tier = 'premium'
    if subscription.plan:
        tier = subscription.plan.tier
        try:
            configured_features = json.loads(subscription.plan.features_json)
            if isinstance(configured_features, list) and configured_features:
                features = [str(item) for item in configured_features]
        except json.JSONDecodeError:
            pass
    payload = {
        'licenseId': subscription.id,
        'tier': tier,
        'issuedAt': int(now.timestamp() * 1000),
        'refreshAfter': int(refresh_after.timestamp() * 1000),
        'expiresAt': int(offline_until.timestamp() * 1000),
        'subscriptionExpiresAt': int(subscription_expires.timestamp() * 1000),
        'customer': user.email,
        'userId': user.id,
        'deviceId': device.device_id,
        'features': features,
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


def sync_plan_templates_to_user(db: Session, user: User, plan: Plan) -> None:
    """Reserved hook for applying admin presets to user settings."""
    return None


def seed_default_catalog(db: Session, settings: Settings) -> None:
    features = ['pipelines', 'multi_input_pipelines', 'pinned_pipeline_buttons']
    if not db.get(Plan, 'pro'):
        db.add(Plan(
            id='pro',
            name='Media Assist Pro',
            tier='premium',
            price_inr_minor=settings.price_inr_minor,
            price_usd_minor=settings.price_usd_minor,
            duration_days=settings.annual_license_days,
            features_json=json.dumps(features),
        ))

    defaults = [
        {
            'id': 'img-ssc-photo',
            'name': 'SSC Photo 160x200',
            'category': 'image_defaults',
            'payload': {
                'defaultFilenameTemplate': 'ssc_photo_{datetime}',
                'defaultFormat': 'jpeg',
                'defaultWidth': 160,
                'defaultHeight': 200,
                'defaultMinKB': 10,
                'defaultMaxKB': 20,
                'defaultQuality': 85,
                'minimumQuality': 40,
                'allowDimensionReduction': True,
                'allowUpscale': False,
                'defaultResizeFit': 'contain',
                'defaultCropRatio': 'free',
                'removeSpacesByDefault': True,
                'removeSpecialCharactersByDefault': True,
            },
        },
        {
            'id': 'img-ssc-sign',
            'name': 'SSC Signature 256x64',
            'category': 'image_defaults',
            'payload': {
                'defaultFilenameTemplate': 'ssc_sign_{datetime}',
                'defaultFormat': 'jpeg',
                'defaultWidth': 256,
                'defaultHeight': 64,
                'defaultMinKB': 10,
                'defaultMaxKB': 20,
                'defaultQuality': 85,
                'minimumQuality': 40,
                'allowDimensionReduction': True,
                'allowUpscale': False,
                'defaultResizeFit': 'contain',
                'defaultCropRatio': 'free',
                'removeSpacesByDefault': True,
                'removeSpecialCharactersByDefault': True,
            },
        },
        {
            'id': 'img-email-photo',
            'name': 'Email Photo Under 180KB',
            'category': 'image_defaults',
            'payload': {
                'defaultFilenameTemplate': 'email_photo_{datetime}',
                'defaultFormat': 'jpeg',
                'defaultMaxKB': 180,
                'defaultQuality': 90,
                'minimumQuality': 35,
                'allowDimensionReduction': True,
                'allowUpscale': False,
                'defaultResizeFit': 'contain',
                'removeSpacesByDefault': True,
                'removeSpecialCharactersByDefault': True,
            },
        },
        {
            'id': 'img-high-quality',
            'name': 'High Quality JPEG',
            'category': 'image_defaults',
            'payload': {
                'defaultFilenameTemplate': 'high_quality_{datetime}',
                'defaultFormat': 'jpeg',
                'defaultMaxKB': 480,
                'defaultQuality': 95,
                'minimumQuality': 70,
                'allowDimensionReduction': False,
                'allowUpscale': False,
                'defaultResizeFit': 'contain',
                'removeSpacesByDefault': True,
                'removeSpecialCharactersByDefault': True,
            },
        },
        {
            'id': 'merge-a4-standard',
            'name': 'A4 Merge Standard',
            'category': 'merge_pdf',
            'payload': {
                'mergeDefaultLayout': 'vertical',
                'mergeDefaultFormat': 'jpeg',
                'mergeDefaultMaxKB': 480,
                'mergeDefaultQuality': 90,
                'mergeDefaultGap': 36,
                'mergeDefaultPadding': 72,
                'mergeDefaultBorderWidth': 3,
                'mergeDefaultBorderColor': '#d6d9dc',
                'mergeDefaultBackground': '#ffffff',
                'mergeDefaultGridColumns': 2,
            },
        },
        {
            'id': 'merge-id-card',
            'name': 'ID Card Front Back',
            'category': 'merge_pdf',
            'payload': {
                'mergeDefaultLayout': 'grid',
                'mergeDefaultFormat': 'jpeg',
                'mergeDefaultMaxKB': 480,
                'mergeDefaultQuality': 90,
                'mergeDefaultGap': 20,
                'mergeDefaultPadding': 40,
                'mergeDefaultBorderWidth': 1,
                'mergeDefaultBorderColor': '#000000',
                'mergeDefaultBackground': '#ffffff',
                'mergeDefaultGridColumns': 2,
            },
        },
        {
            'id': 'pipe-ssc-photo',
            'name': '1-Click SSC Photo',
            'category': 'pipelines',
            'payload': {
                'name': '1-Click SSC Photo',
                'pinned': True,
                'inputCount': 1,
                'steps': [
                    {'type': 'crop', 'mode': 'ask', 'ratio': 'free'},
                    {'type': 'resize', 'width': 160, 'height': 200, 'fit': 'contain', 'allowUpscale': False},
                    {'type': 'format', 'format': 'jpeg'},
                    {'type': 'compress', 'minKB': 10, 'maxKB': 20},
                    {'type': 'filename', 'preset': 'datetime', 'template': 'ssc_photo_{datetime}_{count}'},
                    {'type': 'download', 'automatic': True},
                ],
            },
        },
    ]

    for item in defaults:
        if not db.get(Template, item['id']):
            db.add(Template(
                id=item['id'],
                name=item['name'],
                category=item['category'],
                payload_json=json.dumps(item['payload'], separators=(',', ':')),
            ))
    db.commit()
