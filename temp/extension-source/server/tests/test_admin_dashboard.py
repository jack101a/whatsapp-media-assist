from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import Base, SessionLocal, engine
from app.main import app
from app.models import User
from app.routes import auth


ADMIN_HEADERS = {'X-Admin-Key': 'a' * 32}


def create_signed_in_user(client: TestClient, monkeypatch, email: str, device_id: str = 'admin-dashboard-device-1') -> str:
    monkeypatch.setattr(auth.secrets, 'randbelow', lambda _: 123456)

    async def fake_send_otp(*_, **__):
        return None

    monkeypatch.setattr(auth, 'send_otp', fake_send_otp)
    response = client.post('/v1/auth/request-otp', json={'email': email})
    assert response.status_code == 200, response.text
    response = client.post('/v1/auth/verify-otp', json={
        'email': email,
        'code': '123456',
        'device_id': device_id,
        'device_name': 'Dashboard Test Browser',
    })
    assert response.status_code == 200, response.text
    return response.json()['access_token']


def test_dashboard_auth_catalog_and_manual_grant(monkeypatch):
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        response = client.get('/v1/admin/dashboard/stats')
        assert response.status_code == 401

        plans = client.get('/v1/admin/dashboard/plans', headers=ADMIN_HEADERS)
        assert plans.status_code == 200, plans.text
        assert any(plan['id'] == 'pro' for plan in plans.json())

        templates = client.get('/v1/admin/dashboard/templates', headers=ADMIN_HEADERS)
        assert templates.status_code == 200, templates.text
        assert any(item['category'] == 'image_defaults' for item in templates.json())

        email = 'dashboard-grant@example.com'
        token = create_signed_in_user(client, monkeypatch, email)
        db = SessionLocal()
        try:
            user = db.scalar(select(User).where(User.email == email))
            assert user is not None
            expires_at = datetime.now(timezone.utc) + timedelta(days=30)
        finally:
            db.close()

        grant = client.put(
            f'/v1/admin/dashboard/users/{user.id}/subscription',
            headers=ADMIN_HEADERS,
            json={
                'plan_id': 'pro',
                'expires_at': expires_at.isoformat(),
                'status': 'active',
                'amount_minor': 50000,
                'currency': 'INR',
            },
        )
        assert grant.status_code == 200, grant.text

        account = client.get('/v1/account', headers={'Authorization': f'Bearer {token}'})
        assert account.status_code == 200, account.text
        entitlement = account.json()['entitlement']
        assert entitlement['plan'] == 'pro'
        assert entitlement['status'] == 'active'
        assert entitlement['entitlement_token']

        users = client.get('/v1/admin/dashboard/users?search=dashboard-grant', headers=ADMIN_HEADERS)
        assert users.status_code == 200, users.text
        assert users.json()[0]['plan_name'] == 'Media Assist Pro'


def test_dashboard_backup_download_and_delete():
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as client:
        created = client.post('/v1/admin/dashboard/backups', headers=ADMIN_HEADERS)
        assert created.status_code == 200, created.text
        filename = created.json()['filename']
        assert filename.startswith('media-assist-')

        downloaded = client.get(f'/v1/admin/dashboard/backups/{filename}/download?x_admin_key={"a" * 32}')
        assert downloaded.status_code == 200, downloaded.text
        assert downloaded.content.startswith(b'SQLite format 3')

        deleted = client.delete(f'/v1/admin/dashboard/backups/{filename}', headers=ADMIN_HEADERS)
        assert deleted.status_code == 200, deleted.text

        backup_path = Path('/tmp/backups') / filename
        assert not backup_path.exists()
