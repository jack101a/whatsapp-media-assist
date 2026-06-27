from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..email_client import EmailDeliveryError, send_otp
from ..models import Device, OtpCode, RefreshToken, User, Subscription, utcnow
from ..schemas import MessageResponse, RefreshRequest, RequestOtpRequest, SettingsSyncResponse, SignOutRequest, TokenResponse, VerifyOtpRequest
from ..security import EntitlementSigner, hash_otp, normalize_email, privacy_hash, secure_token_hash
from ..services import issue_session, active_subscription, sync_plan_templates_to_user
from ..timeutils import as_utc

router = APIRouter(prefix='/v1/auth', tags=['auth'])


@lru_cache(maxsize=2)
def cached_signer(path: str) -> EntitlementSigner:
    return EntitlementSigner(Path(path))


def signer(settings: Settings = Depends(get_settings)) -> EntitlementSigner:
    return cached_signer(str(settings.entitlement_private_key_path))


@router.post('/request-otp', response_model=MessageResponse)
async def request_otp(payload: RequestOtpRequest, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> MessageResponse:
    email = normalize_email(str(payload.email))
    now = utcnow()
    latest = db.scalar(select(OtpCode).where(OtpCode.email == email).order_by(OtpCode.created_at.desc()))
    if latest and (now - as_utc(latest.created_at)).total_seconds() < settings.otp_cooldown_seconds:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail='Wait before requesting another code')

    client_ip = request.client.host if request.client else 'unknown'
    ip_hash = privacy_hash(settings, client_ip)
    hourly_ip_count = db.scalar(select(func.count(OtpCode.id)).where(OtpCode.request_ip_hash == ip_hash, OtpCode.created_at >= now - timedelta(hours=1))) or 0
    daily_email_count = db.scalar(select(func.count(OtpCode.id)).where(OtpCode.email == email, OtpCode.created_at >= now - timedelta(days=1))) or 0
    if hourly_ip_count >= settings.otp_ip_hourly_limit or daily_email_count >= settings.otp_email_daily_limit:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail='Too many code requests. Try again later.')

    code = f'{secrets.randbelow(1_000_000):06d}'
    db.execute(update(OtpCode).where(OtpCode.email == email, OtpCode.consumed_at.is_(None)).values(consumed_at=now))
    record = OtpCode(email=email, code_hash=hash_otp(settings, email, code), request_ip_hash=ip_hash, expires_at=now + timedelta(minutes=settings.otp_ttl_minutes))
    db.add(record)
    db.commit()
    try:
        await send_otp(settings, email=email, code=code)
    except EmailDeliveryError as exc:
        db.execute(delete(OtpCode).where(OtpCode.id == record.id))
        db.commit()
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail='Could not send sign-in code') from exc
    return MessageResponse(message='Code sent')


@router.post('/verify-otp', response_model=TokenResponse)
def verify_otp(payload: VerifyOtpRequest, db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> TokenResponse:
    email = normalize_email(str(payload.email))
    now = utcnow()
    otp = db.scalar(select(OtpCode).where(OtpCode.email == email, OtpCode.consumed_at.is_(None)).order_by(OtpCode.created_at.desc()))
    if not otp or as_utc(otp.expires_at) <= now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Code is expired or unavailable')
    if otp.attempts >= settings.otp_max_attempts:
        otp.consumed_at = now
        db.commit()
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail='Too many attempts')
    otp.attempts += 1
    if not secrets.compare_digest(otp.code_hash, hash_otp(settings, email, payload.code)):
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Incorrect code')
    otp.consumed_at = now

    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(email=email)
        db.add(user)
        db.flush()

    # One active device per account. A successful OTP sign-in atomically revokes
    # all older devices and refresh sessions before activating this browser.
    db.execute(update(Device).where(Device.user_id == user.id, Device.device_id != payload.device_id, Device.revoked_at.is_(None)).values(revoked_at=now))
    db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.device_id != payload.device_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))

    device = db.scalar(select(Device).where(Device.user_id == user.id, Device.device_id == payload.device_id))
    if not device:
        device = Device(user_id=user.id, device_id=payload.device_id, name=payload.device_name)
        db.add(device)
    device.revoked_at = None
    device.name = payload.device_name
    device.last_seen_at = now

    # Revoke older sessions on this same device too. The newly issued refresh
    # token is the only valid session after OTP verification.
    db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.device_id == payload.device_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
    access, refresh, entitlement = issue_session(db, settings, token_signer, user=user, device=device)
    
    # Eagerly sync plan templates to the logging-in user's settings if they have an active plan
    sub = db.scalar(
        select(Subscription)
        .outerjoin(Subscription.plan)
        .where(Subscription.user_id == user.id, Subscription.status == 'active', Subscription.expires_at > utcnow())
        .order_by(Subscription.expires_at.desc())
    )
    if sub and sub.plan:
        sync_plan_templates_to_user(db, user, sub.plan)

    db.commit()

    synced = None
    if user.settings_json:
        import json
        try:
            parsed = json.loads(user.settings_json)
            if isinstance(parsed, dict):
                synced = parsed
        except json.JSONDecodeError:
            synced = None
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        entitlement_token=entitlement,
        email=email,
        settings_sync=SettingsSyncResponse(
            revision=user.settings_revision or 0,
            updated_at=user.settings_updated_at,
            settings=synced,
        ),
    )


@router.post('/refresh', response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db), settings: Settings = Depends(get_settings), token_signer: EntitlementSigner = Depends(signer)) -> TokenResponse:
    now = utcnow()
    hashed = secure_token_hash(payload.refresh_token)
    stored = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hashed))
    if not stored or as_utc(stored.expires_at) <= now or stored.device_id != payload.device_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Refresh token is invalid')
    if stored.revoked_at is not None:
        if stored.replaced_by_hash:
            db.execute(update(RefreshToken).where(RefreshToken.user_id == stored.user_id, RefreshToken.device_id == stored.device_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
            db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Refresh token is invalid')
    user = db.get(User, stored.user_id)
    device = db.scalar(select(Device).where(Device.user_id == stored.user_id, Device.device_id == payload.device_id, Device.revoked_at.is_(None)))
    if not user or not device:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Account or device unavailable')
    stored.revoked_at = now
    access, raw_refresh, entitlement = issue_session(db, settings, token_signer, user=user, device=device)
    stored.replaced_by_hash = secure_token_hash(raw_refresh)
    device.last_seen_at = now
    sub = active_subscription(db, user.id)
    if sub and sub.plan:
        sync_plan_templates_to_user(db, user, sub.plan)
    db.commit()
    return TokenResponse(access_token=access, refresh_token=raw_refresh, entitlement_token=entitlement, email=user.email)


@router.post('/sign-out', response_model=MessageResponse)
def sign_out(payload: SignOutRequest, db: Session = Depends(get_db)) -> MessageResponse:
    now = utcnow()
    hashed = secure_token_hash(payload.refresh_token)
    stored = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hashed, RefreshToken.device_id == payload.device_id))
    if stored and stored.revoked_at is None:
        stored.revoked_at = now
        db.commit()
    return MessageResponse(message='Signed out')
