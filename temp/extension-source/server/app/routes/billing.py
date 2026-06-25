from __future__ import annotations

import json
import logging
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status, BackgroundTasks
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db, SessionLocal
from ..deps import AuthContext, require_auth
from ..models import Checkout, PaymentEvent, Subscription, utcnow
from ..razorpay_client import RazorpayClient, RazorpayError
from ..schemas import CheckoutRequest, CheckoutResponse, ProductPrice, ProductResponse
from ..services import active_subscription
from ..timeutils import as_utc

router = APIRouter(tags=['billing'])


@router.get('/v1/billing/product', response_model=ProductResponse)
def product(settings: Settings = Depends(get_settings)) -> ProductResponse:
    prices: list[ProductPrice] = []
    if settings.enable_inr_checkout:
        prices.append(ProductPrice(currency='INR', amount_minor=settings.price_inr_minor, label=f'₹{settings.price_inr_minor / 100:g} / {settings.annual_license_days} days'))
    if settings.enable_usd_checkout:
        prices.append(ProductPrice(currency='USD', amount_minor=settings.price_usd_minor, label=f'${settings.price_usd_minor / 100:.2f} / {settings.annual_license_days} days'))
    return ProductResponse(duration_days=settings.annual_license_days, prices=prices)


@router.post('/v1/billing/checkout', response_model=CheckoutResponse)
async def create_checkout(payload: CheckoutRequest, auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> CheckoutResponse:
    currency = payload.currency
    if (currency == 'INR' and not settings.enable_inr_checkout) or (currency == 'USD' and not settings.enable_usd_checkout):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='This checkout currency is not enabled')
    amount = settings.price_inr_minor if currency == 'INR' else settings.price_usd_minor
    reference = f'MA-{uuid.uuid4().hex[:32]}'
    expires_at = utcnow() + timedelta(hours=24)
    checkout = Checkout(user_id=auth.user.id, reference_id=reference, currency=currency, amount_minor=amount, expires_at=expires_at)
    db.add(checkout)
    db.flush()
    try:
        result = await RazorpayClient(settings).create_payment_link(
            amount_minor=amount,
            currency=currency,
            reference_id=reference,
            email=auth.user.email,
            expire_by=expires_at,
            user_id=auth.user.id,
        )
    except RazorpayError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    checkout.razorpay_link_id = result['id']
    checkout.short_url = result['short_url']
    checkout.status = result.get('status', 'created')
    db.commit()
    return CheckoutResponse(checkout_url=checkout.short_url, reference_id=reference, expires_at=expires_at, currency=currency, amount_minor=amount)


logger = logging.getLogger("media_assist")


def process_webhook_async(payload: dict, event_type: str, settings: Settings) -> None:
    db = SessionLocal()
    try:
        if event_type == 'payment_link.paid':
            link = payload.get('payload', {}).get('payment_link', {}).get('entity', {})
            payment = payload.get('payload', {}).get('payment', {}).get('entity', {})
            reference = link.get('reference_id')
            checkout = db.scalar(select(Checkout).where(Checkout.reference_id == reference))
            payment_captured = payment.get('status') == 'captured' or payment.get('captured') is True
            if checkout and payment_captured and link.get('id') == checkout.razorpay_link_id:
                paid_amount = int(payment.get('amount', 0))
                paid_currency = payment.get('currency')
                if paid_amount != checkout.amount_minor or paid_currency != checkout.currency:
                    logger.warning(
                        f"Payment amount or currency mismatch: expected {checkout.amount_minor} {checkout.currency}, "
                        f"got {paid_amount} {paid_currency}"
                    )
                    return
                checkout.status = 'paid'
                checkout.paid_at = utcnow()
                existing = db.scalar(select(Subscription).where(Subscription.source_payment_id == payment.get('id')))
                if not existing:
                    current = active_subscription(db, checkout.user_id)
                    start = max(utcnow(), as_utc(current.expires_at)) if current else utcnow()
                    db.add(Subscription(
                        user_id=checkout.user_id,
                        status='active',
                        starts_at=start,
                        expires_at=start + timedelta(days=settings.annual_license_days),
                        source='razorpay',
                        source_payment_id=payment['id'],
                        currency=checkout.currency,
                        amount_minor=checkout.amount_minor,
                    ))
        elif event_type == 'refund.processed':
            refund = payload.get('payload', {}).get('refund', {}).get('entity', {})
            payment_id = refund.get('payment_id')
            subscription = db.scalar(select(Subscription).where(Subscription.source_payment_id == payment_id))
            if subscription and int(refund.get('amount', 0)) >= subscription.amount_minor:
                subscription.status = 'refunded'
                subscription.expires_at = utcnow()
        elif event_type == 'payment.refunded':
            payment = payload.get('payload', {}).get('payment', {}).get('entity', {})
            subscription = db.scalar(select(Subscription).where(Subscription.source_payment_id == payment.get('id')))
            if subscription and int(payment.get('amount_refunded', 0)) >= subscription.amount_minor:
                subscription.status = 'refunded'
                subscription.expires_at = utcnow()
        db.commit()
        logger.info(f"Successfully processed webhook event {event_type}")
    except Exception as exc:
        db.rollback()
        logger.error(f"Error processing webhook event {event_type}: {exc}", exc_info=exc)
    finally:
        db.close()


@router.post('/v1/webhooks/razorpay')
async def razorpay_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    # Guard body size to prevent memory exhaustion (limit to 1MB)
    content_length = request.headers.get('content-length')
    if content_length and int(content_length) > 1_048_576:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail='Request body too large')

    body_bytes = bytearray()
    async for chunk in request.stream():
        body_bytes.extend(chunk)
        if len(body_bytes) > 1_048_576:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail='Request body too large')
    raw = bytes(body_bytes)

    signature = request.headers.get('x-razorpay-signature', '')
    event_id = request.headers.get('x-razorpay-event-id', '')
    if not signature or not settings.razorpay_webhook_secret or not RazorpayClient(settings).verify_webhook(raw, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid webhook signature')
    if not event_id:
        event_id = f'fallback-{uuid.uuid4()}'
    if db.get(PaymentEvent, event_id):
        return {'ok': True}

    payload = json.loads(raw)
    event_type = payload.get('event', '')
    db.add(PaymentEvent(id=event_id, event_type=event_type, payload_json=raw.decode('utf-8', errors='replace')))
    db.commit()

    background_tasks.add_task(process_webhook_async, payload, event_type, settings)
    return {'ok': True}



@router.get('/payment-complete', response_class=HTMLResponse)
def payment_complete() -> str:
    return '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Media Assist payment</title><style>body{font:16px system-ui;background:#f5f7f8;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:32px;max-width:460px;box-shadow:0 16px 50px #0001}h1{margin-top:0;color:#087a66}</style></head><body><main class="card"><h1>Payment submitted</h1><p>Return to Media Assist Settings and click <b>Refresh status</b>. Activation happens after Razorpay confirms the payment.</p></main></body></html>'''


@router.get('/dev/pay/{reference_id}', response_class=HTMLResponse)
def dev_pay(reference_id: str, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> str:
    if settings.environment != 'development':
        raise HTTPException(status_code=404)
    checkout = db.scalar(select(Checkout).where(Checkout.reference_id == reference_id))
    if not checkout:
        raise HTTPException(status_code=404)
    checkout.status = 'paid'
    checkout.paid_at = utcnow()
    current = active_subscription(db, checkout.user_id)
    start = max(utcnow(), as_utc(current.expires_at)) if current else utcnow()
    db.add(Subscription(user_id=checkout.user_id, status='active', starts_at=start, expires_at=start + timedelta(days=settings.annual_license_days), source='development', source_payment_id=f'dev-{reference_id}', currency=checkout.currency, amount_minor=checkout.amount_minor))
    db.commit()
    return '<h1>Development payment activated</h1><p>Return to the extension and refresh status.</p>'
