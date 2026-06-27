from __future__ import annotations

import hashlib
import hmac
from types import SimpleNamespace

from app.razorpay_client import RazorpayClient


def test_webhook_signature_validation():
    settings = SimpleNamespace(razorpay_webhook_secret='webhook-secret')
    raw = b'{"event":"payment_link.paid"}'
    signature = hmac.new(b'webhook-secret', raw, hashlib.sha256).hexdigest()
    assert RazorpayClient(settings).verify_webhook(raw, signature)
    assert not RazorpayClient(settings).verify_webhook(raw, 'wrong')
