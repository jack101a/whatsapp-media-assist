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

    safe_code = html.escape(code)
    support_email = 'support.mediaassit@002529.xyz'
    payload = {
        'sender': {'name': settings.brevo_sender_name, 'email': str(settings.brevo_sender_email)},
        'to': [{'email': email}],
        'subject': f'{code} is your WhatsApp Media Assist sign-in code',
        'htmlContent': (
            '<div style="margin:0;padding:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#17212b;">'
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4f7f6;">'
            '<tr><td align="center" style="padding:28px 16px;">'
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border-collapse:collapse;background:#ffffff;border:1px solid #dce6e2;border-radius:14px;overflow:hidden;">'
            '<tr><td style="padding:22px 24px;background:#0f7665;color:#ffffff;">'
            '<div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.86;">Secure sign-in</div>'
            '<h1 style="margin:8px 0 0;font-size:24px;line-height:1.25;">WhatsApp Media Assist</h1>'
            '</td></tr>'
            '<tr><td style="padding:26px 24px 10px;">'
            '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#314047;">Use this one-time code to finish signing in to your extension account.</p>'
            f'<div style="margin:18px 0 18px;padding:18px 20px;text-align:center;background:#eef8f5;border:1px solid #bde4d9;border-radius:12px;font-size:34px;line-height:1;font-weight:800;letter-spacing:8px;color:#0f7665;">{safe_code}</div>'
            '<p style="margin:0;font-size:14px;line-height:1.6;color:#52616a;">This code expires in 10 minutes. For your privacy, images, PDFs, chats and WhatsApp media stay on your device.</p>'
            '</td></tr>'
            '<tr><td style="padding:18px 24px 26px;">'
            '<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7880;">If you did not request this code, you can safely ignore this email. Need help? Contact '
            f'<a href="mailto:{support_email}" style="color:#0f7665;text-decoration:none;font-weight:700;">{support_email}</a>.</p>'
            '</td></tr>'
            '</table>'
            '<p style="max-width:560px;margin:14px 0 0;font-size:12px;line-height:1.5;color:#7a878d;">This message was sent by WhatsApp Media Assist. It is not affiliated with WhatsApp LLC or Meta Platforms, Inc.</p>'
            '</td></tr>'
            '</table>'
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
