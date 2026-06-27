from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from .config import Settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_otp(settings: Settings, email: str, code: str) -> str:
    data = f'{normalize_email(email)}:{code}'.encode()
    return hmac.new(settings.otp_pepper.encode(), data, hashlib.sha256).hexdigest()


def secure_token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

def privacy_hash(settings: Settings, value: str) -> str:
    return hmac.new(settings.otp_pepper.encode(), value.encode(), hashlib.sha256).hexdigest()


def create_access_token(settings: Settings, *, user_id: str, email: str, device_id: str) -> str:
    now = utcnow()
    payload = {
        'sub': user_id,
        'email': email,
        'device_id': device_id,
        'iat': int(now.timestamp()),
        'exp': int((now + timedelta(minutes=settings.access_token_minutes)).timestamp()),
        'iss': 'media-assist-api',
        'aud': 'media-assist-extension',
        'type': 'access',
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm='HS256')


def decode_access_token(settings: Settings, token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.jwt_secret, algorithms=['HS256'], audience='media-assist-extension', issuer='media-assist-api')


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


class EntitlementSigner:
    def __init__(self, private_key_path: Path):
        raw = private_key_path.read_bytes()
        key = serialization.load_pem_private_key(raw, password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
            raise RuntimeError('Entitlement key must be an unencrypted P-256 EC private key')
        self._key = key

    def sign(self, payload: dict[str, Any]) -> str:
        encoded = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode()
        der = self._key.sign(encoded, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        signature = r.to_bytes(32, 'big') + s.to_bytes(32, 'big')
        return f'{b64url(encoded)}.{b64url(signature)}'
