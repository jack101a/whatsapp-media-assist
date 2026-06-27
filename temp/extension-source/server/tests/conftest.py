from __future__ import annotations

import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

TEST_DB = Path('/tmp/media-assist-api-test.sqlite3')
TEST_KEY = Path('/tmp/media-assist-api-test-key.pem')
if TEST_DB.exists():
    TEST_DB.unlink()
if not TEST_KEY.exists():
    key = ec.generate_private_key(ec.SECP256R1())
    TEST_KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))

os.environ.update({
    'ENVIRONMENT': 'development',
    'API_BASE_URL': 'http://testserver/',
    'FRONTEND_SUCCESS_URL': 'http://testserver/payment-complete',
    'DATABASE_URL': f'sqlite:///{TEST_DB}',
    'JWT_SECRET': 'j' * 64,
    'OTP_PEPPER': 'o' * 64,
    'ADMIN_API_KEY': 'a' * 32,
    'ENTITLEMENT_PRIVATE_KEY_PATH': str(TEST_KEY),
    'RAZORPAY_KEY_ID': '',
    'RAZORPAY_KEY_SECRET': '',
    'RAZORPAY_WEBHOOK_SECRET': 'webhook-secret',
    'BREVO_API_KEY': '',
    'BREVO_SENDER_EMAIL': 'no-reply.mediaassit@example.com',
    'BREVO_REPLY_TO_EMAIL': 'support.mediaassit@example.com',
})
