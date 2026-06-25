from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..deps import AuthContext, require_auth
from ..models import Device, RefreshToken, utcnow
from ..schemas import AccountResponse, DeviceResponse, EntitlementResponse, MessageResponse, SettingsResponse, SettingsUpdateRequest
from ..security import EntitlementSigner
from ..services import active_subscription, create_entitlement

router = APIRouter(prefix='/v1', tags=['account'])


@lru_cache(maxsize=1)
def _cached_signer(key_path: Path) -> EntitlementSigner:
    """Parse the P-256 private key once and cache the signer for the process lifetime.

    Avoids reading the PEM file from disk and running EC key deserialization on
    every request that issues or refreshes an entitlement token.
    """
    return EntitlementSigner(key_path)


def signer(settings: Settings = Depends(get_settings)) -> EntitlementSigner:
    return _cached_signer(settings.entitlement_private_key_path)


@router.get('/entitlement', response_model=EntitlementResponse)
def entitlement(auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> EntitlementResponse:
    subscription = active_subscription(db, auth.user.id)
    token, data = create_entitlement(settings, token_signer, user=auth.user, device=auth.device, subscription=subscription)
    return EntitlementResponse(**data, entitlement_token=token)


@router.get('/account', response_model=AccountResponse)
def account(auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> AccountResponse:
    devices = db.scalars(select(Device).where(Device.user_id == auth.user.id, Device.revoked_at.is_(None)).order_by(Device.created_at)).all()
    subscription = active_subscription(db, auth.user.id)
    token, data = create_entitlement(settings, token_signer, user=auth.user, device=auth.device, subscription=subscription)
    return AccountResponse(
        email=auth.user.email,
        devices=[DeviceResponse(device_id=item.device_id, name=item.name, current=item.device_id == auth.device.device_id, last_seen_at=item.last_seen_at, created_at=item.created_at) for item in devices],
        entitlement=EntitlementResponse(**data, entitlement_token=token),
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


@router.get('/settings', response_model=SettingsResponse)
def get_user_settings(auth: AuthContext = Depends(require_auth)) -> SettingsResponse:
    return SettingsResponse(settings_json=auth.user.settings_json)


@router.post('/settings', response_model=MessageResponse)
def update_user_settings(payload: SettingsUpdateRequest, auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db)) -> MessageResponse:
    auth.user.settings_json = payload.settings_json
    db.commit()
    return MessageResponse(message='Settings synced successfully')

