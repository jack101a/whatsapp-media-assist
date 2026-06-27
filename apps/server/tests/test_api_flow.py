from __future__ import annotations

import hashlib
import hmac
import json

from fastapi.testclient import TestClient

from app.db import Base, engine
from app.main import app
from app.routes import auth


def test_login_checkout_activation_and_signout(monkeypatch):
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(auth.secrets, 'randbelow', lambda _: 123456)

    async def fake_send_otp(*_, **__):
        return None

    monkeypatch.setattr(auth, 'send_otp', fake_send_otp)
    client = TestClient(app)
    email = 'buyer@example.com'
    device_id = 'device1234567890abcdef'

    response = client.post('/v1/auth/request-otp', json={'email': email})
    assert response.status_code == 200, response.text

    response = client.post('/v1/auth/verify-otp', json={
        'email': email,
        'code': '123456',
        'device_id': device_id,
        'device_name': 'Chrome on Windows',
    })
    assert response.status_code == 200, response.text
    tokens = response.json()
    assert tokens['entitlement_token'] is None
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}

    response = client.post('/v1/billing/checkout', json={'currency': 'INR'}, headers=headers)
    assert response.status_code == 200, response.text
    checkout = response.json()
    assert checkout['amount_minor'] == 50000
    assert checkout['checkout_url'].startswith('http://testserver/checkout/')

    webhook = {
        'event': 'order.paid',
        'payload': {
            'order': {'entity': {'id': f"order_dev_{checkout['reference_id']}", 'amount': 50000, 'currency': 'INR', 'status': 'paid'}},
            'payment': {'entity': {'id': 'pay_fixture_001', 'order_id': f"order_dev_{checkout['reference_id']}", 'amount': 50000, 'currency': 'INR', 'status': 'captured', 'captured': True}},
        },
    }
    raw = json.dumps(webhook, separators=(',', ':')).encode()
    signature = hmac.new(b'webhook-secret', raw, hashlib.sha256).hexdigest()
    response = client.post('/v1/webhooks/razorpay', content=raw, headers={
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': 'event_fixture_001',
    })
    assert response.status_code == 200, response.text
    duplicate = client.post('/v1/webhooks/razorpay', content=raw, headers={
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': 'event_fixture_001',
    })
    assert duplicate.status_code == 200

    response = client.get('/v1/account', headers=headers)
    assert response.status_code == 200, response.text
    account = response.json()
    assert account['entitlement']['plan'] == 'pro'
    assert account['entitlement']['entitlement_token']
    assert len(account['devices']) == 1

    response = client.post('/v1/auth/sign-out', json={
        'refresh_token': tokens['refresh_token'],
        'device_id': device_id,
    })
    assert response.status_code == 200, response.text

    response = client.post('/v1/auth/refresh', json={
        'refresh_token': tokens['refresh_token'],
        'device_id': device_id,
    })
    assert response.status_code == 401
