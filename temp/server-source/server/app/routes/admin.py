from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..models import Subscription, User, utcnow
from ..schemas import MessageResponse
from ..timeutils import as_utc

router = APIRouter(prefix='/v1/admin', tags=['admin'])


def require_admin(x_admin_key: str | None = Header(default=None), settings: Settings = Depends(get_settings)) -> None:
    if not x_admin_key or x_admin_key != settings.admin_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid admin key')


@router.post('/grant/{email}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def grant(email: str, days: int = 365, db: Session = Depends(get_db)) -> MessageResponse:
    user = db.scalar(select(User).where(User.email == email.strip().lower()))
    if not user:
        raise HTTPException(status_code=404, detail='User not found')
    active = db.scalar(select(Subscription).where(Subscription.user_id == user.id, Subscription.status == 'active').order_by(Subscription.expires_at.desc()))
    start = max(utcnow(), as_utc(active.expires_at)) if active else utcnow()
    db.add(Subscription(user_id=user.id, status='active', starts_at=start, expires_at=start + timedelta(days=days), source='admin', source_payment_id=f'admin-{user.id}-{int(utcnow().timestamp())}', currency='INR', amount_minor=0))
    db.commit()
    return MessageResponse(message='Entitlement granted')
