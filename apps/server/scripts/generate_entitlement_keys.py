from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64(value: int) -> str:
    return base64.urlsafe_b64encode(value.to_bytes(32, 'big')).rstrip(b'=').decode()


parser = argparse.ArgumentParser()
parser.add_argument('--private-output', default='owner-secrets/entitlement-private.pem')
parser.add_argument('--public-output', default='src/billing/public-entitlement-key.ts')
args = parser.parse_args()

private_path = Path(args.private_output)
public_path = Path(args.public_output)
private_path.parent.mkdir(parents=True, exist_ok=True)
public_path.parent.mkdir(parents=True, exist_ok=True)

key = ec.generate_private_key(ec.SECP256R1())
private_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
private_path.chmod(0o600)
numbers = key.public_key().public_numbers()
jwk = {'kty': 'EC', 'crv': 'P-256', 'x': b64(numbers.x), 'y': b64(numbers.y), 'ext': True}
public_path.write_text('export const ENTITLEMENT_PUBLIC_KEY = ' + json.dumps(jwk, indent=2) + ' as JsonWebKey;\n', encoding='utf-8')
print(f'Private key: {private_path}')
print(f'Extension public key: {public_path}')
