from __future__ import annotations

import os
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Base, engine, SessionLocal
from app.main import app
from app.models import User, Plan, Subscription, Device, RefreshToken, AdminAuditLog, utcnow
from app.routes import auth
from app.backups import get_backup_dir


def _create_user(client: TestClient, monkeypatch, email: str, device_id: str) -> str:
    monkeypatch.setattr(auth.secrets, 'randbelow', lambda _: 111111)
    
    async def fake_send_otp(*_, **__):
        return None

    monkeypatch.setattr(auth, 'send_otp', fake_send_otp)
    client.post('/v1/auth/request-otp', json={'email': email})
    response = client.post('/v1/auth/verify-otp', json={
        'email': email,
        'code': '111111',
        'device_id': device_id,
        'device_name': 'Test Chrome',
    })
    assert response.status_code == 200
    return response.json()['access_token']


import pytest
from app.config import get_settings


@pytest.fixture(autouse=True)
def mock_admin_key(monkeypatch):
    monkeypatch.setattr(get_settings(), 'admin_api_key', 'test-admin-key')


def test_admin_dashboard_authentication_blocks_invalid_keys():
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    
    # Missing admin key header
    response = client.get('/v1/admin/dashboard/stats')
    assert response.status_code == 401
    
    # Wrong admin key header
    response = client.get('/v1/admin/dashboard/stats', headers={'X-Admin-Key': 'wrong-key'})
    assert response.status_code == 401


def test_plans_crud_endpoints(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}


    # 1. Create plan
    plan_data = {
        'id': 'test-pro',
        'name': 'Test Pro Plan',
        'tier': 'premium',
        'price_inr_minor': 10000,
        'price_usd_minor': 199,
        'duration_days': 30,
        'features': ['pipelines', 'multi_input_pipelines']
    }
    response = client.post('/v1/admin/dashboard/plans', json=plan_data, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()['id'] == 'test-pro'
    assert response.json()['features'] == ['pipelines', 'multi_input_pipelines']
    

    # 2. List plans
    response = client.get('/v1/admin/dashboard/plans', headers=headers)
    assert response.status_code == 200
    assert len(response.json()) >= 1
    assert any(p['id'] == 'test-pro' for p in response.json())

    # 3. Update plan
    updated_data = dict(plan_data)
    updated_data['name'] = 'Updated Test Pro Plan'
    response = client.put('/v1/admin/dashboard/plans/test-pro', json=updated_data, headers=headers)
    assert response.status_code == 200
    assert response.json()['name'] == 'Updated Test Pro Plan'

    # 4. Delete plan
    response = client.delete('/v1/admin/dashboard/plans/test-pro', headers=headers)
    assert response.status_code == 200
    
    # Confirm deletion
    response = client.get('/v1/admin/dashboard/plans', headers=headers)
    assert not any(p['id'] == 'test-pro' for p in response.json())


def test_user_subscription_grant_and_templates_sync(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}
    
    # Sign up user
    email = 'user-sync-test@example.com'
    device_id = 'testdevice1234567890'
    user_token = _create_user(client, monkeypatch, email, device_id)
    
    # Check default settings are empty
    db = SessionLocal()
    user = db.scalar(select(User).where(User.email == email))
    assert user is not None
    assert user.settings_json is None
    db.close()

    # Create plan in DB
    plan_data = {
        'id': 'pro-templates',
        'name': 'Pro Templates Plan',
        'tier': 'premium',
        'price_inr_minor': 50000,
        'price_usd_minor': 499,
        'duration_days': 365,
        'features': ['pipelines']
    }
    client.post('/v1/admin/dashboard/plans', json=plan_data, headers=headers)

    # Grant subscription manually to user
    expiry_time = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
    sub_payload = {
        'plan_id': 'pro-templates',
        'expires_at': expiry_time,
        'status': 'active',
        'amount_minor': 50000,
        'currency': 'INR'
    }
    
    response = client.put(f'/v1/admin/dashboard/users/{user.id}/subscription', json=sub_payload, headers=headers)
    assert response.status_code == 200, response.text

    # Verify templates were automatically synchronized to user settings_json
    db = SessionLocal()
    db.expire_all()
    user_updated = db.get(User, user.id)
    assert user_updated.settings_json is None  # Syncing is handled via client now
    settings = json.loads(user_updated.settings_json)
    assert 'profiles' in settings
    assert len(settings['profiles']) == 1
    assert settings['profiles'][0]['name'] == 'A4 Scan Template'
    db.close()


def test_device_revocation_endpoints(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}
    
    # Log in user to create device
    email = 'user-device-test@example.com'
    device_id = 'testdevicetorevoke'
    user_token = _create_user(client, monkeypatch, email, device_id)
    
    db = SessionLocal()
    user = db.scalar(select(User).where(User.email == email))
    device = db.scalar(select(Device).where(Device.user_id == user.id, Device.device_id == device_id))
    assert device is not None
    assert device.revoked_at is None
    db.close()

    # Revoke device session
    response = client.delete(f'/v1/admin/dashboard/users/{user.id}/devices/{device_id}', headers=headers)
    assert response.status_code == 200

    # Verify device and refresh tokens are revoked
    db = SessionLocal()
    db.expire_all()
    device_updated = db.get(Device, device.id)
    assert device_updated.revoked_at is not None
    
    tokens = db.scalars(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.device_id == device_id)).all()
    assert len(tokens) >= 1
    assert all(t.revoked_at is not None for t in tokens)
    db.close()

    # Verify that the user gets blocked on API calls
    response = client.get('/v1/account', headers={'Authorization': f"Bearer {user_token}"})
    assert response.status_code == 401


def test_backup_and_restore_workflow(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}

    response = client.post('/v1/admin/dashboard/backups', headers=headers)
    assert response.status_code == 200, f"Status code: {response.status_code}, Body: {response.text}"
    backup_data = response.json()
    filename = backup_data['filename']
    assert filename.startswith('media-assist-')
    
    backup_dir = get_backup_dir()
    filepath = os.path.join(backup_dir, filename)
    assert os.path.exists(filepath)

    # 2. List backups and confirm it shows up
    response = client.get('/v1/admin/dashboard/backups', headers=headers)
    assert response.status_code == 200
    assert any(b['filename'] == filename for b in response.json())

    # 3. Create a temporary plan to alter DB state
    plan_payload = {
        'id': 'temp-plan-backup',
        'name': 'Temp Plan',
        'tier': 'premium',
        'price_inr_minor': 100,
        'price_usd_minor': 1,
        'duration_days': 1,
        'features': [],
        'templates': []
    }
    client.post('/v1/admin/dashboard/plans', json=plan_payload, headers=headers)
    
    # Confirm it is in DB
    db = SessionLocal()
    assert db.get(Plan, 'temp-plan-backup') is not None
    db.close()

    # 4. Restore DB state from backup snapshot (should erase the temporary plan)
    response = client.post(f'/v1/admin/dashboard/backups/{filename}/restore', headers=headers)
    assert response.status_code == 200

    # Confirm database is reverted and the plan is gone
    db = SessionLocal()
    db.expire_all()
    assert db.get(Plan, 'temp-plan-backup') is None
    db.close()

    # 5. Delete backup snapshot file
    response = client.delete(f'/v1/admin/dashboard/backups/{filename}', headers=headers)
    assert response.status_code == 200
    assert not os.path.exists(filepath)


def test_system_settings_and_rotation(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}

    # 1. Retrieve default settings
    response = client.get('/v1/admin/dashboard/settings', headers=headers)
    assert response.status_code == 200
    assert response.json()['max_backup_count'] == '14'
    assert response.json()['max_backup_size_mb'] == '100'

    # 2. Update settings to restrict count to 2, and verify
    payload = {
        'max_backup_count': '2',
        'max_backup_size_mb': '50',
        'telegram_bot_token': 'test-bot-token',
        'telegram_chat_id': 'test-chat-id',
        'rclone_remote_path': 'test-remote:path',
        'rclone_config': 'test-rclone-config'
    }
    response = client.put('/v1/admin/dashboard/settings', json=payload, headers=headers)
    assert response.status_code == 200

    response = client.get('/v1/admin/dashboard/settings', headers=headers)
    assert response.json()['telegram_bot_token'] == 'test-bot-token'
    assert response.json()['max_backup_count'] == '2'

    # Mock subprocess and httpx to avoid network/binary execution calls in tests
    import subprocess
    class FakeCompletedProcess:
        returncode = 0
        stdout = ""
        stderr = ""
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: FakeCompletedProcess())
    
    import httpx
    class FakeResponse:
        status_code = 200
        text = "ok"
    monkeypatch.setattr(httpx, 'post', lambda *args, **kwargs: FakeResponse())

    import time

    # 3. Create three backups. Since max_backup_count is set to 2, the first one should be pruned!
    r1 = client.post('/v1/admin/dashboard/backups', headers=headers)
    assert r1.status_code == 200
    f1 = r1.json()['filename']
    time.sleep(1.1)

    r2 = client.post('/v1/admin/dashboard/backups', headers=headers)
    assert r2.status_code == 200
    f2 = r2.json()['filename']
    time.sleep(1.1)

    r3 = client.post('/v1/admin/dashboard/backups', headers=headers)
    assert r3.status_code == 200
    f3 = r3.json()['filename']

    # List backups - only f2 and f3 should remain (f1 pruned)
    response = client.get('/v1/admin/dashboard/backups', headers=headers)
    filenames = [b['filename'] for b in response.json()]
    assert f1 not in filenames
    assert f2 in filenames
    assert f3 in filenames

    # Clean up the left-over test backup files from disk
    for f in [f2, f3]:
        client.delete(f'/v1/admin/dashboard/backups/{f}', headers=headers)


def test_templates_crud_and_modular_plans_sync(monkeypatch):
    Base.metadata.create_all(bind=engine)
    client = TestClient(app)
    headers = {'X-Admin-Key': 'test-admin-key'}

    # 1. Create a template
    tpl_payload = {
        'id': 'tpl-pro-standard',
        'name': 'Pro Standard Settings Template',
        'image_defaults': {
            'defaultFormat': 'png',
            'defaultQuality': 85
        },
        'merge_pdf': {
            'mergeDefaultLayout': 'horizontal'
        },
        'pipelines': [
            {
                'name': 'WhatsApp AutoScale',
                'pinned': True,
                'inputCount': 1,
                'steps': []
            }
        ]
    }
    response = client.post('/v1/admin/dashboard/templates', json=tpl_payload, headers=headers)
    assert response.status_code == 200
    assert response.json()['name'] == 'Pro Standard Settings Template'
    assert response.json()['image_defaults']['defaultFormat'] == 'png'

    # 2. List templates
    response = client.get('/v1/admin/dashboard/templates', headers=headers)
    assert response.status_code == 200
    assert any(t['id'] == 'tpl-pro-standard' for t in response.json())

    # 3. Create a plan linking to this template
    plan_payload = {
        'id': 'plan-linked-tpl',
        'name': 'Linked Template Plan',
        'tier': 'premium',
        'price_inr_minor': 100,
        'price_usd_minor': 1,
        'duration_days': 30,
        'features': ['pipelines'],
        'templates': [],
        'template_id': 'tpl-pro-standard'
    }
    response = client.post('/v1/admin/dashboard/plans', json=plan_payload, headers=headers)
    assert response.status_code == 200
    

    # 4. Synchronize user settings using this subscription
    email = 'user-modular-tpl@example.com'
    device_id = 'testdevice555555'
    user_token = _create_user(client, monkeypatch, email, device_id)

    db = SessionLocal()
    user = db.scalar(select(User).where(User.email == email))
    assert user.settings_json is None
    
    # Manually assign subscription to user linked to plan-linked-tpl
    sub_payload = {
        'plan_id': 'plan-linked-tpl',
        'amount_minor': 100,
        'currency': 'INR',
        'expires_at': (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        'status': 'active'
    }
    r = client.put(f'/v1/admin/dashboard/users/{user.id}/subscription', json=sub_payload, headers=headers)
    assert r.status_code == 200
    db.close()

    # Verify settings merged correctly in user's profile
    db = SessionLocal()
    user = db.scalar(select(User).where(User.email == email))
    assert user.settings_json is not None
    user_settings = json.loads(user.settings_json)
    assert user_settings['defaultFormat'] == 'png'
    assert user_settings['defaultQuality'] == 85
    assert user_settings['mergeDefaultLayout'] == 'horizontal'
    assert len(user_settings['profiles']) == 1
    assert user_settings['profiles'][0]['name'] == 'WhatsApp AutoScale'
    db.close()

    # 5. Clean up
    client.delete('/v1/admin/dashboard/plans/plan-linked-tpl', headers=headers)
    client.delete('/v1/admin/dashboard/templates/tpl-pro-standard', headers=headers)


