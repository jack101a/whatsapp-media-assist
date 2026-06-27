from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from typing import Any

import httpx

from .config import Settings


class RazorpayError(RuntimeError):
    pass


class RazorpayClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def create_payment_link(
        self,
        *,
        amount_minor: int,
        currency: str,
        reference_id: str,
        email: str,
        expire_by: datetime,
        user_id: str,
    ) -> dict[str, Any]:
        if not self.settings.razorpay_key_id or not self.settings.razorpay_key_secret:
            if self.settings.environment == 'development':
                return {
                    'id': f'plink_dev_{reference_id}',
                    'short_url': f'{self.settings.api_base_url}dev/pay/{reference_id}',
                    'status': 'created',
                }
            raise RazorpayError('Razorpay is not configured')
        body = {
            'amount': amount_minor,
            'currency': currency,
            'accept_partial': False,
            'reference_id': reference_id,
            'description': 'Media Assist Pro — 365 days',
            'customer': {'email': email},
            'notify': {'email': False, 'sms': False},
            'reminder_enable': False,
            'expire_by': int(expire_by.timestamp()),
            'callback_url': str(self.settings.frontend_success_url),
            'callback_method': 'get',
            'notes': {'user_id': user_id, 'product': 'media-assist-pro', 'license_days': str(self.settings.annual_license_days)},
        }
        async with httpx.AsyncClient(timeout=20, auth=(self.settings.razorpay_key_id, self.settings.razorpay_key_secret)) as client:
            response = await client.post(f'{self.settings.razorpay_api_url}/payment_links', json=body)
        if response.status_code >= 300:
            raise RazorpayError(f'Razorpay payment link failed ({response.status_code}): {response.text[:500]}')
        return response.json()

    async def create_order(
        self,
        *,
        amount_minor: int,
        currency: str,
        reference_id: str,
        user_id: str,
        plan_id: str | None,
    ) -> dict[str, Any]:
        if not self.settings.razorpay_key_id or not self.settings.razorpay_key_secret:
            if self.settings.environment == 'development':
                return {
                    'id': f'order_dev_{reference_id}',
                    'amount': amount_minor,
                    'currency': currency,
                    'receipt': reference_id,
                    'status': 'created',
                }
            raise RazorpayError('Razorpay is not configured')
        body = {
            'amount': amount_minor,
            'currency': currency,
            'receipt': reference_id,
            'notes': {
                'reference_id': reference_id,
                'user_id': user_id,
                'plan_id': plan_id or '',
                'product': 'media-assist-pro',
            },
        }
        async with httpx.AsyncClient(timeout=20, auth=(self.settings.razorpay_key_id, self.settings.razorpay_key_secret)) as client:
            response = await client.post(f'{self.settings.razorpay_api_url}/orders', json=body)
        if response.status_code >= 300:
            raise RazorpayError(f'Razorpay order failed ({response.status_code}): {response.text[:500]}')
        return response.json()

    def verify_checkout_signature(self, *, order_id: str, payment_id: str, signature: str) -> bool:
        if not self.settings.razorpay_key_secret:
            return self.settings.environment == 'development' and signature == 'dev-signature'
        expected = hmac.new(
            self.settings.razorpay_key_secret.encode(),
            f'{order_id}|{payment_id}'.encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    def verify_webhook(self, raw_body: bytes, signature: str) -> bool:
        expected = hmac.new(self.settings.razorpay_webhook_secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
