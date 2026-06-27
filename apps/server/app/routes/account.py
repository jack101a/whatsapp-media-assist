from __future__ import annotations

import json
from pathlib import Path
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..deps import AuthContext, require_auth
from ..models import Device, RefreshToken, Template, utcnow
from ..schemas import AccountResponse, DeviceResponse, EntitlementResponse, MessageResponse, SettingsSyncRequest, SettingsSyncResponse
from ..security import EntitlementSigner
from ..services import active_subscription, create_entitlement

router = APIRouter(prefix='/v1', tags=['account'])


@lru_cache(maxsize=2)
def cached_signer(path: str) -> EntitlementSigner:
    return EntitlementSigner(Path(path))


def signer(settings: Settings = Depends(get_settings)) -> EntitlementSigner:
    return cached_signer(str(settings.entitlement_private_key_path))


def user_settings_response(auth: AuthContext) -> SettingsSyncResponse:
    data = None
    if auth.user.settings_json:
        try:
            parsed = json.loads(auth.user.settings_json)
            if isinstance(parsed, dict):
                data = parsed
        except json.JSONDecodeError:
            data = None
    return SettingsSyncResponse(
        revision=auth.user.settings_revision or 0,
        updated_at=auth.user.settings_updated_at,
        settings=data,
    )


@router.get('/entitlement', response_model=EntitlementResponse)
def entitlement(auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> EntitlementResponse:
    subscription = active_subscription(db, auth.user.id)
    token, data = create_entitlement(settings, token_signer, user=auth.user, device=auth.device, subscription=subscription)
    return EntitlementResponse(**data, entitlement_token=token)


@router.get('/settings', response_model=SettingsSyncResponse)
def get_synced_settings(auth: AuthContext = Depends(require_auth)) -> SettingsSyncResponse:
    return user_settings_response(auth)


@router.put('/settings', response_model=SettingsSyncResponse)
def put_synced_settings(payload: SettingsSyncRequest, auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> SettingsSyncResponse:
    current_revision = auth.user.settings_revision or 0
    if payload.expected_revision != current_revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={'message': 'Settings changed on another device', 'current_revision': current_revision},
        )
    encoded = json.dumps(payload.settings, separators=(',', ':'), ensure_ascii=False)
    if len(encoded.encode('utf-8')) > settings.max_settings_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail='Settings are too large')
    auth.user.settings_json = encoded
    auth.user.settings_revision = current_revision + 1
    auth.user.settings_updated_at = utcnow()
    db.commit()
    return user_settings_response(auth)


@router.get('/account', response_model=AccountResponse)
def account(auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> AccountResponse:
    devices = db.scalars(select(Device).where(Device.user_id == auth.user.id, Device.revoked_at.is_(None)).order_by(Device.created_at)).all()
    subscription = active_subscription(db, auth.user.id)
    token, data = create_entitlement(settings, token_signer, user=auth.user, device=auth.device, subscription=subscription)
    return AccountResponse(
        email=auth.user.email,
        devices=[DeviceResponse(device_id=item.device_id, name=item.name, current=item.device_id == auth.device.device_id, last_seen_at=item.last_seen_at, created_at=item.created_at) for item in devices],
        entitlement=EntitlementResponse(**data, entitlement_token=token),
        settings_sync=user_settings_response(auth),
    )


@router.delete('/devices/{device_id}', response_model=MessageResponse)
def remove_device(device_id: str, auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db)) -> MessageResponse:
    if device_id == auth.device.device_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Sign out instead of removing the current device')
    device = db.scalar(select(Device).where(Device.user_id == auth.user.id, Device.device_id == device_id, Device.revoked_at.is_(None)))
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Device not found')
    now = utcnow()
    device.revoked_at = now
    db.execute(update(RefreshToken).where(RefreshToken.user_id == auth.user.id, RefreshToken.device_id == device_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
    db.commit()
    return MessageResponse(message='Device removed')


@router.get('/templates')
def get_global_templates(auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db)) -> list[dict]:
    """Returns globally seeded templates for active Pro users."""
    subscription = active_subscription(db, auth.user.id)
    if not subscription:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Pro is required to sync preset templates')
    from sqlalchemy import select as sa_select
    templates = db.scalars(sa_select(Template).order_by(Template.category, Template.name)).all()
    result = []
    for t in templates:
        import json
        try:
            payload = json.loads(t.payload_json) if t.payload_json else {}
        except Exception:
            payload = {}
        result.append({
            'id': t.id,
            'name': t.name,
            'category': t.category,
            'payload': payload,
        })
    return result
