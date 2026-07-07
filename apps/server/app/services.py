from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import json
import time
import uuid
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import Device, RefreshToken, Subscription, User, Plan
from .security import EntitlementSigner, create_access_token, new_refresh_token, secure_token_hash
import logging

logger = logging.getLogger("media_assist.services")
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
    
    # Load dynamic plan configurations if linked
    tier = 'premium'
    features = ['pipelines', 'multi_input_pipelines', 'pinned_pipeline_buttons']
    
    if subscription.plan:
        tier = subscription.plan.tier
        try:
            plan_features = json.loads(subscription.plan.features_json)
            if isinstance(plan_features, list) and plan_features:
                features = plan_features
        except Exception:
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
    
    # Eager load the plan relationship to avoid N+1 queries during signature
    subscription = db.scalar(
        select(Subscription)
        .outerjoin(Subscription.plan)
        .where(Subscription.user_id == user.id, Subscription.status == 'active', Subscription.expires_at > utcnow())
        .order_by(Subscription.expires_at.desc())
    )
    
    entitlement_token, _ = create_entitlement(settings, signer, user=user, device=device, subscription=subscription)
    return access, raw_refresh, entitlement_token


def _step_with_id(step: dict) -> dict:
    return {**step, 'id': step.get('id') or str(uuid.uuid4())}


def _template_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _profile_from_template(template_id: str, template_name: str, payload: dict) -> dict:
    steps = payload.get('steps')
    if not isinstance(steps, list):
        steps = []
    input_count = _template_int(payload.get('inputCount'), 1)
    return {
        'id': template_id,
        'name': template_name,
        'tag': str(payload.get('tag', ''))[:8] or None,
        'pinned': bool(payload.get('pinned', True)),
        'inputCount': max(1, min(20, input_count)),
        'mergeLayout': payload.get('mergeLayout') if payload.get('mergeLayout') in {'vertical', 'horizontal', 'grid', 'pages'} else 'vertical',
        'background': payload.get('background') or '#ffffff',
        'steps': [_step_with_id(step) for step in steps if isinstance(step, dict)],
        'createdAt': int(time.time() * 1000),
        'updatedAt': int(time.time() * 1000),
    }


def sync_plan_templates_to_user(db: Session, user: User, plan: Plan) -> None:
    """Inject pipeline templates into the user's synced settings on plan upgrade/payment.
    Only 'pipelines' category templates are written into settings_json (as profiles[]).
    Image/merge/general templates are served on-demand via GET /v1/templates.
    """
    from .models import Template
    import json as _json

    pipeline_templates = db.scalars(
        select(Template)
        .where(
            Template.category == 'pipelines',
            Template.is_enabled.is_(True),
            or_(Template.user_email.is_(None), Template.user_email == user.email.lower()),
        )
        .order_by(Template.name)
    ).all()
    if not pipeline_templates:
        return

    try:
        settings = _json.loads(user.settings_json) if user.settings_json else {}
    except Exception:
        settings = {}

    existing_profiles: list = settings.get('profiles', [])
    existing_ids = {p.get('id') for p in existing_profiles if isinstance(p, dict)}

    added = False
    for t in pipeline_templates:
        if t.id in existing_ids:
            continue
        try:
            payload = _json.loads(t.payload_json) if t.payload_json else {}
        except Exception:
            continue
        existing_profiles.append(_profile_from_template(t.id, t.name, payload))
        added = True

    if added:
        settings['profiles'] = existing_profiles
        user.settings_json = _json.dumps(settings, separators=(',', ':'), ensure_ascii=False)
        user.settings_revision = (user.settings_revision or 0) + 1
        user.settings_updated_at = utcnow()

def seed_default_templates(db: Session) -> None:
    """Seeds recommended preconfigured templates for the extension categories."""
    from .models import Template
    import json

    defaults = [
        # --- RESIZE / CROP / COMPRESS PRESETS ---
        {
            "id": "img-ssc-photo",
            "name": "SSC Photo (160x200)",
            "category": "resize",
            "payload_json": json.dumps({
                "defaultWidth": 160,
                "defaultHeight": 200,
                "defaultResizeFit": "contain",
                "allowUpscale": True
            })
        },
        {
            "id": "img-ssc-sign",
            "name": "SSC Signature (256x64)",
            "category": "resize",
            "payload_json": json.dumps({
                "defaultWidth": 256,
                "defaultHeight": 64,
                "defaultResizeFit": "contain",
                "allowUpscale": True
            })
        },
        {
            "id": "img-pan-photo",
            "name": "PAN Card Photo (213x213)",
            "category": "resize",
            "payload_json": json.dumps({
                "defaultWidth": 213,
                "defaultHeight": 213,
                "defaultResizeFit": "contain",
                "allowUpscale": True
            })
        },
        {
            "id": "img-us-visa",
            "name": "US Visa / Passport (600x600)",
            "category": "resize",
            "payload_json": json.dumps({
                "defaultWidth": 600,
                "defaultHeight": 600,
                "defaultResizeFit": "contain",
                "allowUpscale": True
            })
        },
        {
            "id": "crop-square",
            "name": "Square crop (1:1)",
            "category": "crop",
            "payload_json": json.dumps({
                "defaultCropRatio": "1:1"
            })
        },
        {
            "id": "compress-20kb-jpeg",
            "name": "JPEG 10-20 KB",
            "category": "compress",
            "payload_json": json.dumps({
                "defaultFormat": "jpeg",
                "defaultMinKB": 10,
                "defaultMaxKB": 20,
                "defaultQuality": 85,
                "minimumQuality": 35
            })
        },
        {
            "id": "compress-240kb-jpeg",
            "name": "JPEG up to 240 KB",
            "category": "compress",
            "payload_json": json.dumps({
                "defaultFormat": "jpeg",
                "defaultMinKB": 50,
                "defaultMaxKB": 240,
                "defaultQuality": 90,
                "minimumQuality": 35
            })
        },
        # --- MERGE & PDF ---
        {
            "id": "merge-id-card",
            "name": "ID Card Front & Back (A4 Grid)",
            "category": "merge_pdf",
            "payload_json": json.dumps({
                "mergeDefaultLayout": "grid",
                "mergeDefaultFormat": "jpeg",
                "mergeDefaultMaxKB": 200,
                "mergeDefaultQuality": 90,
                "mergeDefaultGap": 20,
                "mergeDefaultPadding": 40,
                "mergeDefaultBorderWidth": 1,
                "mergeDefaultBorderColor": "#000000",
                "mergeDefaultBackground": "#ffffff",
                "mergeDefaultGridColumns": 2
            })
        },
        {
            "id": "merge-documents",
            "name": "Standard Documents (Vertical)",
            "category": "merge_pdf",
            "payload_json": json.dumps({
                "mergeDefaultLayout": "vertical",
                "mergeDefaultFormat": "jpeg",
                "mergeDefaultMaxKB": 450,
                "mergeDefaultQuality": 80,
                "mergeDefaultGap": 10,
                "mergeDefaultPadding": 10,
                "mergeDefaultBorderWidth": 0,
                "mergeDefaultBorderColor": "#ffffff",
                "mergeDefaultBackground": "#ffffff",
                "mergeDefaultGridColumns": 1
            })
        },
        {
            "id": "merge-original-pages-pdf",
            "name": "Original Pages PDF",
            "category": "merge_pdf",
            "payload_json": json.dumps({
                "mergeDefaultLayout": "pages",
                "mergeDefaultFormat": "pdf",
                "mergeDefaultMaxKB": 480,
                "mergeDefaultQuality": 90,
                "mergeDefaultGap": 0,
                "mergeDefaultPadding": 0,
                "mergeDefaultBorderWidth": 0,
                "mergeDefaultBorderColor": "#ffffff",
                "mergeDefaultBackground": "#ffffff",
                "mergeDefaultGridColumns": 1
            })
        },
        # --- PIPELINES ---
        {
            "id": "pipe-ssc-photo",
            "name": "1-Click SSC Photo",
            "category": "pipelines",
            "payload_json": json.dumps({
                "name": "1-Click SSC Photo",
                "pinned": True,
                "inputCount": 1,
                "steps": [
                    { "type": "crop", "mode": "ask", "ratio": "free" },
                    { "type": "resize", "width": 160, "height": 200, "fit": "contain", "allowUpscale": True },
                    { "type": "format", "format": "jpeg" },
                    { "type": "compress", "minKB": 10, "maxKB": 20 },
                    { "type": "filename", "preset": "datetime", "template": "ssc_photo_{datetime}_{count}" },
                    { "type": "download", "automatic": True }
                ]
            })
        },
        {
            "id": "pipe-webp-converter",
            "name": "Convert to WebP",
            "category": "pipelines",
            "payload_json": json.dumps({
                "name": "Convert to WebP",
                "pinned": True,
                "inputCount": 1,
                "steps": [
                    { "type": "format", "format": "webp" },
                    { "type": "filename", "preset": "original", "template": "{original}" },
                    { "type": "download", "automatic": True }
                ]
            })
        }
    ]

    for d in defaults:
        if not db.get(Template, d["id"]):
            t = Template(**d)
            db.add(t)

    db.commit()
