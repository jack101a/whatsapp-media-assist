from __future__ import annotations

import json
import uuid
import html
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..deps import AuthContext, require_auth
from ..models import Checkout, PaymentEvent, Subscription, User, Plan, utcnow
from ..razorpay_client import RazorpayClient, RazorpayError
from ..schemas import CheckoutRequest, CheckoutResponse, ProductPrice, ProductResponse
from ..services import active_subscription, sync_plan_templates_to_user
from ..timeutils import as_utc

router = APIRouter(tags=['billing'])


def _base_url(settings: Settings) -> str:
    return str(settings.api_base_url).rstrip('/')


def _activate_checkout(db: Session, checkout: Checkout, payment_id: str, settings: Settings) -> None:
    checkout.status = 'paid'
    checkout.paid_at = utcnow()
    existing = db.scalar(select(Subscription).where(Subscription.source_payment_id == payment_id))
    if existing:
        return
    current = active_subscription(db, checkout.user_id)
    start = max(utcnow(), as_utc(current.expires_at)) if current else utcnow()
    plan = db.get(Plan, checkout.plan_id) if checkout.plan_id else None
    duration_days = plan.duration_days if plan else settings.annual_license_days
    user = db.get(User, checkout.user_id)
    db.add(Subscription(
        user_id=checkout.user_id,
        plan_id=checkout.plan_id,
        status='active',
        starts_at=start,
        expires_at=start + timedelta(days=duration_days),
        source='razorpay',
        source_payment_id=payment_id,
        currency=checkout.currency,
        amount_minor=checkout.amount_minor,
    ))
    db.flush()
    if user and plan:
        sync_plan_templates_to_user(db, user, plan)


def _checkout_not_available(title: str, message: str) -> str:
    safe_title = html.escape(title)
    safe_message = html.escape(message)
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{safe_title}</title><style>body{{font:16px system-ui;background:#f5f7f8;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0}}.card{{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:32px;max-width:460px;box-shadow:0 16px 50px #0001}}h1{{margin-top:0;color:#087a66}}</style></head><body><main class="card"><h1>{safe_title}</h1><p>{safe_message}</p></main></body></html>'''


@router.get('/v1/billing/product', response_model=ProductResponse)
def product(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> ProductResponse:
    prices: list[ProductPrice] = []
    # Eagerly load the 'pro' plan if it exists in the database
    plan = db.scalar(select(Plan).where(Plan.id == 'pro'))
    duration = plan.duration_days if plan else settings.annual_license_days
    price_inr = plan.price_inr_minor if plan else settings.price_inr_minor
    price_usd = plan.price_usd_minor if plan else settings.price_usd_minor

    if settings.enable_inr_checkout:
        prices.append(ProductPrice(currency='INR', amount_minor=price_inr, label=f'₹{price_inr / 100:g} / {duration} days'))
    if settings.enable_usd_checkout:
        prices.append(ProductPrice(currency='USD', amount_minor=price_usd, label=f'${price_usd / 100:.2f} / {duration} days'))
    return ProductResponse(name=plan.name if plan else 'Media Assist Pro', duration_days=duration, prices=prices)


@router.post('/v1/billing/checkout', response_model=CheckoutResponse)
async def create_checkout(payload: CheckoutRequest, auth: AuthContext = Depends(require_auth), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> CheckoutResponse:
    currency = payload.currency
    if (currency == 'INR' and not settings.enable_inr_checkout) or (currency == 'USD' and not settings.enable_usd_checkout):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='This checkout currency is not enabled')
    
    plan_id = payload.plan_id or 'pro'
    plan = db.get(Plan, plan_id)
    if not plan:
        # If it's not the default 'pro' plan, throw an error. If 'pro' is requested but missing, fallback to defaults.
        if plan_id != 'pro':
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Requested plan was not found')
    
    amount = settings.price_inr_minor if currency == 'INR' else settings.price_usd_minor
    if plan:
        amount = plan.price_inr_minor if currency == 'INR' else plan.price_usd_minor

    reference = f'MA-{uuid.uuid4().hex[:32]}'
    expires_at = utcnow() + timedelta(hours=24)
    checkout = Checkout(user_id=auth.user.id, plan_id=plan.id if plan else None, reference_id=reference, currency=currency, amount_minor=amount, expires_at=expires_at)
    db.add(checkout)
    db.flush()
    try:
        result = await RazorpayClient(settings).create_order(
            amount_minor=amount,
            currency=currency,
            reference_id=reference,
            user_id=auth.user.id,
            plan_id=checkout.plan_id,
        )
    except RazorpayError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    checkout.razorpay_link_id = result['id']
    checkout.short_url = f'{_base_url(settings)}/checkout/{reference}'
    checkout.status = result.get('status', 'created')
    db.commit()
    return CheckoutResponse(checkout_url=checkout.short_url, reference_id=reference, expires_at=expires_at, currency=currency, amount_minor=amount)


@router.get('/checkout/{reference_id}', response_class=HTMLResponse)
def hosted_checkout(reference_id: str, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> str:
    checkout = db.scalar(select(Checkout).where(Checkout.reference_id == reference_id))
    if not checkout:
        raise HTTPException(status_code=404)
    if checkout.status == 'paid':
        return _checkout_not_available('Payment complete', 'Your Media Assist Pro plan is already active. Return to the extension and click Sync now.')
    if as_utc(checkout.expires_at) <= utcnow():
        return _checkout_not_available('Checkout expired', 'Create a new checkout from Media Assist Settings and try again.')

    plan = db.get(Plan, checkout.plan_id) if checkout.plan_id else None
    user = db.get(User, checkout.user_id)
    plan_name = plan.name if plan else 'Media Assist Pro'
    amount_label = f'{checkout.currency} {checkout.amount_minor / 100:.2f}'
    options = {
        'key': settings.razorpay_key_id,
        'amount': checkout.amount_minor,
        'currency': checkout.currency,
        'name': 'Media Assist',
        'description': plan_name,
        'order_id': checkout.razorpay_link_id,
        'prefill': {'email': user.email if user else ''},
        'notes': {'reference_id': checkout.reference_id, 'user_id': checkout.user_id, 'plan_id': checkout.plan_id or ''},
        'theme': {'color': '#0b8f78'},
        'retry': {'enabled': True},
    }
    options_json = json.dumps(options, separators=(',', ':')).replace('</', '<\\/')
    reference_json = json.dumps(reference_id).replace('</', '<\\/')
    safe_plan = html.escape(plan_name)
    safe_amount = html.escape(amount_label)
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pay Media Assist</title>
  <style>
    :root {{ color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f7f8; color:#17212b; }}
    main {{ width:min(460px,calc(100vw - 32px)); background:#fff; border:1px solid #dfe5e7; border-radius:14px; padding:30px; box-shadow:0 20px 60px rgba(20,40,45,.14); }}
    .brand {{ display:flex; gap:10px; align-items:center; margin-bottom:24px; font-weight:850; font-size:22px; }}
    .mark {{ width:36px; height:36px; border-radius:10px; display:grid; place-items:center; color:#fff; background:#0b8f78; font-weight:900; }}
    h1 {{ margin:0; font-size:25px; line-height:1.2; }}
    p {{ margin:10px 0 0; color:#5c6972; line-height:1.55; }}
    .summary {{ margin:22px 0; display:grid; gap:10px; }}
    .row {{ display:flex; justify-content:space-between; gap:14px; padding:12px 0; border-top:1px solid #eef1f2; }}
    .row:last-child {{ border-bottom:1px solid #eef1f2; }}
    .label {{ color:#687680; }}
    .value {{ font-weight:800; text-align:right; }}
    button {{ width:100%; border:0; border-radius:10px; padding:14px 16px; color:#fff; background:#0b8f78; font-weight:800; cursor:pointer; }}
    button:disabled {{ opacity:.65; cursor:wait; }}
    #status {{ min-height:24px; margin-top:14px; font-size:14px; color:#5c6972; }}
    .success {{ color:#047857 !important; }}
    .error {{ color:#b91c1c !important; }}
  </style>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">MA</div><span>Media Assist</span></div>
    <h1>Complete payment</h1>
    <p>Razorpay Checkout will open automatically. Keep this tab open until your plan is activated.</p>
    <div class="summary">
      <div class="row"><span class="label">Plan</span><span class="value">{safe_plan}</span></div>
      <div class="row"><span class="label">Amount</span><span class="value">{safe_amount}</span></div>
    </div>
    <button type="button" id="payButton">Open Razorpay Checkout</button>
    <div id="status">Preparing secure checkout...</div>
  </main>
  <script>
    const options = {options_json};
    const referenceId = {reference_json};
    const payButton = document.getElementById("payButton");
    const statusEl = document.getElementById("status");
    let opened = false;
    function setStatus(message, className = "") {{
      statusEl.textContent = message;
      statusEl.className = className;
    }}
    async function verifyPayment(response) {{
      setStatus("Verifying payment with Media Assist...");
      payButton.disabled = true;
      const result = await fetch(`/checkout/${{encodeURIComponent(referenceId)}}/verify`, {{
        method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify({{
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature
        }})
      }});
      const body = await result.json().catch(() => ({{ ok: false, error: "Invalid server response" }}));
      if (!result.ok || !body.ok) throw new Error(body.error || "Payment verification failed");
      setStatus("Payment verified. Return to the extension and click Sync now.", "success");
      payButton.textContent = "Payment complete";
    }}
    function openCheckout() {{
      if (!window.Razorpay) {{
        setStatus("Razorpay Checkout could not load. Check network and try again.", "error");
        return;
      }}
      if (opened) return;
      opened = true;
      options.handler = function (response) {{
        verifyPayment(response).catch((error) => {{
          setStatus(error.message || "Payment verification failed", "error");
          payButton.disabled = false;
          payButton.textContent = "Retry verification";
        }});
      }};
      options.modal = {{
        ondismiss: function () {{
          opened = false;
          setStatus("Checkout closed before payment completion.");
          payButton.disabled = false;
        }}
      }};
      payButton.disabled = true;
      setStatus("Opening Razorpay Checkout...");
      const checkout = new Razorpay(options);
      checkout.open();
      setTimeout(() => {{ payButton.disabled = false; }}, 1200);
    }}
    payButton.addEventListener("click", openCheckout);
    window.addEventListener("load", () => setTimeout(openCheckout, 300));
  </script>
</body>
</html>'''


@router.post('/checkout/{reference_id}/verify')
async def verify_hosted_checkout(reference_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, bool]:
    body = await request.json()
    order_id = str(body.get('razorpay_order_id') or '')
    payment_id = str(body.get('razorpay_payment_id') or '')
    signature = str(body.get('razorpay_signature') or '')
    checkout = db.scalar(select(Checkout).where(Checkout.reference_id == reference_id))
    if not checkout or checkout.razorpay_link_id != order_id:
        raise HTTPException(status_code=404, detail='Checkout was not found')
    if not RazorpayClient(settings).verify_checkout_signature(order_id=order_id, payment_id=payment_id, signature=signature):
        raise HTTPException(status_code=401, detail='Invalid payment signature')
    _activate_checkout(db, checkout, payment_id, settings)
    db.commit()
    return {'ok': True}


@router.post('/v1/webhooks/razorpay')
async def razorpay_webhook(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, bool]:
    raw = await request.body()
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
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Payment amount or currency mismatch')
            _activate_checkout(db, checkout, payment.get('id'), settings)
    elif event_type in {'payment.captured', 'order.paid'}:
        payment = payload.get('payload', {}).get('payment', {}).get('entity', {})
        order = payload.get('payload', {}).get('order', {}).get('entity', {})
        order_id = payment.get('order_id') or order.get('id')
        checkout = db.scalar(select(Checkout).where(Checkout.razorpay_link_id == order_id))
        paid_amount = int(payment.get('amount') or order.get('amount') or 0)
        paid_currency = payment.get('currency') or order.get('currency')
        payment_id = payment.get('id') or f'order-{order_id}'
        payment_captured = event_type == 'order.paid' or payment.get('status') == 'captured' or payment.get('captured') is True
        if checkout and payment_captured:
            if paid_amount != checkout.amount_minor or paid_currency != checkout.currency:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Payment amount or currency mismatch')
            _activate_checkout(db, checkout, payment_id, settings)
    elif event_type == 'payment.failed':
        payment = payload.get('payload', {}).get('payment', {}).get('entity', {})
        order_id = payment.get('order_id')
        checkout = db.scalar(select(Checkout).where(Checkout.razorpay_link_id == order_id))
        if checkout:
            checkout.status = 'failed'
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
    
    plan = db.get(Plan, checkout.plan_id) if checkout.plan_id else None
    duration_days = plan.duration_days if plan else settings.annual_license_days
    user = db.get(User, checkout.user_id)

    db.add(Subscription(
        user_id=checkout.user_id,
        plan_id=checkout.plan_id,
        status='active',
        starts_at=start,
        expires_at=start + timedelta(days=duration_days),
        source='development',
        source_payment_id=f'dev-{reference_id}',
        currency=checkout.currency,
        amount_minor=checkout.amount_minor
    ))
    db.flush()
    if user and plan:
        sync_plan_templates_to_user(db, user, plan)
        
    db.commit()
    return '<h1>Development payment activated</h1><p>Return to the extension and refresh status.</p>'
