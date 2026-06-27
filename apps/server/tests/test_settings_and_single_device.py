from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from app.db import Base, engine
from app.main import app
from app.models import utcnow as model_utcnow
from app.routes import auth


def _login(client: TestClient, monkeypatch, email: str, device_id: str, code: int, now=None):
    monkeypatch.setattr(auth.secrets, 'randbelow', lambda _: code)
    if now is not None:
        monkeypatch.setattr(auth, 'utcnow', lambda: now)

    async def fake_send_otp(*_, **__):
        return None

    monkeypatch.setattr(auth, 'send_otp', fake_send_otp)
    response = client.post('/v1/auth/request-otp', json={'email': email})
    assert response.status_code == 200, response.text
    response = client.post('/v1/auth/verify-otp', json={
        'email': email,
        'code': f'{code:06d}',
        'device_id': device_id,
        'device_name': device_id,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_settings_sync_revision_and_conflict(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    tokens = _login(client, monkeypatch, 'sync@example.com', 'device-sync-1234567890', 111111)
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}

    response = client.get('/v1/settings', headers=headers)
    assert response.status_code == 200
    assert response.json()['revision'] == 0
    assert response.json()['settings'] is None

    payload = {'enabled': True, 'profiles': [{'name': 'Upload1', 'steps': []}]}
    response = client.put('/v1/settings', headers=headers, json={'expected_revision': 0, 'settings': payload})
    assert response.status_code == 200, response.text
    assert response.json()['revision'] == 1
    assert response.json()['settings'] == payload

    conflict = client.put('/v1/settings', headers=headers, json={'expected_revision': 0, 'settings': payload})
    assert conflict.status_code == 409


def test_new_device_revokes_previous_session(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    start = model_utcnow()
    first = _login(client, monkeypatch, 'single@example.com', 'device-one-1234567890', 222222, start)
    saved = {'enabled': True, 'profiles': [{'name': 'Upload1', 'steps': [{'type': 'download'}]}]}
    synced = client.put('/v1/settings', headers={'Authorization': f"Bearer {first['access_token']}"}, json={'expected_revision': 0, 'settings': saved})
    assert synced.status_code == 200, synced.text

    second = _login(client, monkeypatch, 'single@example.com', 'device-two-1234567890', 333333, start + timedelta(seconds=61))
    assert second['settings_sync']['revision'] == 1
    assert second['settings_sync']['settings'] == saved

    old_access = client.get('/v1/account', headers={'Authorization': f"Bearer {first['access_token']}"})
    assert old_access.status_code == 401

    old_refresh = client.post('/v1/auth/refresh', json={
        'refresh_token': first['refresh_token'],
        'device_id': 'device-one-1234567890',
    })
    assert old_refresh.status_code == 401

    account = client.get('/v1/account', headers={'Authorization': f"Bearer {second['access_token']}"})
    assert account.status_code == 200, account.text
    devices = account.json()['devices']
    assert len(devices) == 1
    assert devices[0]['device_id'] == 'device-two-1234567890'
