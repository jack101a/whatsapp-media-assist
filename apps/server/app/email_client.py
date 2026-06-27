from __future__ import annotations

import html

import httpx

from .config import Settings


class EmailDeliveryError(RuntimeError):
    pass


async def send_otp(settings: Settings, *, email: str, code: str) -> None:
    if settings.environment == 'test':
        return
    if not settings.brevo_api_key:
        if settings.environment == 'development':
            print(f'[DEV OTP] {email}: {code}', flush=True)
            return
        raise EmailDeliveryError('Brevo is not configured')

    payload = {
        'sender': {'name': settings.brevo_sender_name, 'email': str(settings.brevo_sender_email)},
        'to': [{'email': email}],
        'subject': f'{code} is your Media Assist code',
        'htmlContent': (
            '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">'
            '<h2>Media Assist sign-in</h2>'
            f'<p>Use this code:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">{html.escape(code)}</p>'
            '<p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>'
            '</div>'
        ),
        'tags': ['media-assist-otp'],
    }
    headers = {'api-key': settings.brevo_api_key, 'accept': 'application/json', 'content-type': 'application/json'}
    if settings.brevo_sandbox:
        headers['X-Sib-Sandbox'] = 'drop'
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post('https://api.brevo.com/v3/smtp/email', json=payload, headers=headers)
    if response.status_code >= 300:
        raise EmailDeliveryError(f'Brevo rejected the email: {response.status_code}')
