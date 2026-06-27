#!/usr/bin/env python3
from __future__ import annotations

import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_ENV = ROOT / 'server' / '.env'
EXAMPLE = ROOT / 'server' / '.env.example'
PRIVATE_KEY = ROOT / 'owner-secrets' / 'entitlement-private.pem'

if not PRIVATE_KEY.exists():
    raise SystemExit('Missing owner-secrets/entitlement-private.pem. Use the private owner package that matches this extension build.')
if SERVER_ENV.exists():
    raise SystemExit('server/.env already exists. Remove it only if you intentionally want to regenerate secrets.')

replacements = {
    'CHANGE_TO_64_RANDOM_CHARACTERS': secrets.token_urlsafe(64),
    'CHANGE_TO_ANOTHER_64_RANDOM_VALUE': secrets.token_urlsafe(64),
    'CHANGE_TO_LONG_ADMIN_KEY': secrets.token_urlsafe(48),
}
content = EXAMPLE.read_text(encoding='utf-8')
for old, new in replacements.items():
    content = content.replace(old, new)
SERVER_ENV.write_text(content, encoding='utf-8')
SERVER_ENV.chmod(0o600)
print('Created server/.env with unique local secrets.')
print('Now add Razorpay and Brevo credentials to server/.env.')
