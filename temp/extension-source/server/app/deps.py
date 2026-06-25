from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .db import get_db
from .models import Device, User
from .security import decode_access_token


class AuthContext:
    def __init__(self, user: User, device: Device):
        self.user = user
        self.device = device


def require_auth(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthContext:
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Authentication required')
    token = authorization.split(' ', 1)[1]
    try:
        payload = decode_access_token(settings, token)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid or expired access token') from exc
    user = db.get(User, payload['sub'])
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Account unavailable')
    device = db.scalar(select(Device).where(Device.user_id == user.id, Device.device_id == payload.get('device_id'), Device.revoked_at.is_(None)))
    if not device:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Device is not active')
    return AuthContext(user, device)
