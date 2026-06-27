from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from app.security import EntitlementSigner


def decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def test_entitlement_signer_uses_verifiable_p1363_signature(tmp_path: Path):
    key = ec.generate_private_key(ec.SECP256R1())
    path = tmp_path / 'private.pem'
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    token = EntitlementSigner(path).sign({'tier': 'premium', 'deviceId': 'device-1'})
    payload_part, signature_part = token.split('.')
    raw = decode(signature_part)
    assert len(raw) == 64
    r = int.from_bytes(raw[:32], 'big')
    s = int.from_bytes(raw[32:], 'big')
    key.public_key().verify(encode_dss_signature(r, s), decode(payload_part), ec.ECDSA(hashes.SHA256()))
    assert json.loads(decode(payload_part))['tier'] == 'premium'
