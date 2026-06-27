from __future__ import annotations

import json
import os
from datetime import timedelta
from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..models import Plan, User, Subscription, Device, RefreshToken, AdminAuditLog, utcnow
from ..schemas import (
    PlanCreate, PlanResponse, AdminUserResponse, AdminUserSubscriptionUpdate,
    BackupResponse, AuditLogResponse, StatsResponse, MessageResponse,
    TemplateCreate, TemplateResponse
)
from ..services import active_subscription, sync_plan_templates_to_user
from ..backups import (
    take_database_backup, restore_database_backup, list_backups,
    get_db_path, get_backup_dir
)

router = APIRouter(prefix='/v1/admin/dashboard', tags=['admin_dashboard'])


def require_admin(
    x_admin_key: str | None = Header(default=None),
    x_admin_key_query: str | None = Query(default=None, alias='x_admin_key'),
    settings: Settings = Depends(get_settings),
) -> None:
    key = x_admin_key or x_admin_key_query
    if not key or key != settings.admin_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid admin credentials')


def log_audit_action(db: Session, action: str, details: str | None = None) -> None:
    db.add(AdminAuditLog(action=action, details=details))
    db.commit()


def safe_backup_path(filename: str) -> str:
    if os.path.basename(filename) != filename or not filename.startswith('media-assist-') or not filename.endswith('.db'):
        raise HTTPException(status_code=400, detail='Invalid backup filename')
    backup_dir = os.path.abspath(get_backup_dir())
    filepath = os.path.abspath(os.path.join(backup_dir, filename))
    if os.path.dirname(filepath) != backup_dir:
        raise HTTPException(status_code=400, detail='Invalid backup filename')
    return filepath


@router.get('/stats', response_model=StatsResponse, dependencies=[Depends(require_admin)])
def stats(db: Session = Depends(get_db)) -> StatsResponse:
    # 1. Total users
    total_users = db.scalar(select(func.count(User.id))) or 0

    # 2. Active subscriptions
    now = utcnow()
    active_subscriptions = db.scalar(
        select(func.count(Subscription.id))
        .where(Subscription.status == 'active', Subscription.expires_at > now)
    ) or 0

    # 3. Total active devices
    total_devices = db.scalar(
        select(func.count(Device.id))
        .where(Device.revoked_at.is_(None))
    ) or 0

    # 4. Projected ARR (Calculated by converting active subscriptions to annual value in INR)
    active_subs = db.scalars(
        select(Subscription)
        .where(Subscription.status == 'active', Subscription.expires_at > now)
    ).all()

    projected_arr = 0
    for sub in active_subs:
        amount = sub.amount_minor
        # Normalize to annual value if not 365 days
        plan_days = sub.plan.duration_days if sub.plan else 365
        annual_factor = 365 / max(1, plan_days)

        # Convert USD to INR at an index rate of 1 USD = 83 INR
        inr_amount = amount if sub.currency == 'INR' else amount * 83
        projected_arr += int(inr_amount * annual_factor)

    # 5. Database file sizes
    db_path = get_db_path()
    db_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    wal_path = f"{db_path}-wal"
    wal_size = os.path.getsize(wal_path) if os.path.exists(wal_path) else 0

    # 6. Latest backup
    backups = list_backups()
    last_backup_at = backups[0]['created_at'] if backups else None

    return StatsResponse(
        total_users=total_users,
        active_subscriptions=active_subscriptions,
        total_devices=total_devices,
        projected_arr=projected_arr,
        db_size_bytes=db_size,
        wal_size_bytes=wal_size,
        last_backup_at=last_backup_at
    )


# --- PLANS CRUD ---

@router.get('/plans', response_model=List[PlanResponse], dependencies=[Depends(require_admin)])
def list_plans(db: Session = Depends(get_db)) -> List[PlanResponse]:
    plans = db.scalars(select(Plan).order_by(Plan.created_at.desc())).all()
    output = []
    for p in plans:
        try:
            features = json.loads(p.features_json)
            if not isinstance(features, list):
                features = []
        except json.JSONDecodeError:
            features = []
        output.append(PlanResponse(
            id=p.id, name=p.name, tier=p.tier,
            price_inr_minor=p.price_inr_minor, price_usd_minor=p.price_usd_minor,
            duration_days=p.duration_days, features=features,
            created_at=p.created_at, updated_at=p.updated_at
        ))
    return output


@router.post('/plans', response_model=PlanResponse, dependencies=[Depends(require_admin)])
def create_plan(payload: PlanCreate, db: Session = Depends(get_db)) -> PlanResponse:
    existing = db.get(Plan, payload.id)
    if existing:
        raise HTTPException(status_code=400, detail="Plan ID already exists")

    plan = Plan(
        id=payload.id,
        name=payload.name,
        tier=payload.tier,
        price_inr_minor=payload.price_inr_minor,
        price_usd_minor=payload.price_usd_minor,
        duration_days=payload.duration_days,
        features_json=json.dumps(payload.features)
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)

    log_audit_action(db, "CREATE_PLAN", f"Created plan '{plan.name}' ({plan.id})")

    return PlanResponse(
        id=plan.id, name=plan.name, tier=plan.tier,
        price_inr_minor=plan.price_inr_minor, price_usd_minor=plan.price_usd_minor,
        duration_days=plan.duration_days, features=payload.features,
        created_at=plan.created_at, updated_at=plan.updated_at
    )


@router.put('/plans/{plan_id}', response_model=PlanResponse, dependencies=[Depends(require_admin)])
def update_plan(plan_id: str, payload: PlanCreate, db: Session = Depends(get_db)) -> PlanResponse:
    plan = db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    plan.name = payload.name
    plan.tier = payload.tier
    plan.price_inr_minor = payload.price_inr_minor
    plan.price_usd_minor = payload.price_usd_minor
    plan.duration_days = payload.duration_days
    plan.features_json = json.dumps(payload.features)
    plan.updated_at = utcnow()

    db.commit()
    db.refresh(plan)

    log_audit_action(db, "UPDATE_PLAN", f"Updated plan '{plan.name}' ({plan.id})")

    return PlanResponse(
        id=plan.id, name=plan.name, tier=plan.tier,
        price_inr_minor=plan.price_inr_minor, price_usd_minor=plan.price_usd_minor,
        duration_days=plan.duration_days, features=payload.features,
        created_at=plan.created_at, updated_at=plan.updated_at
    )


@router.delete('/plans/{plan_id}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def delete_plan(plan_id: str, db: Session = Depends(get_db)) -> MessageResponse:
    plan = db.get(Plan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    name = plan.name
    db.delete(plan)
    db.commit()

    log_audit_action(db, "DELETE_PLAN", f"Deleted plan '{name}' ({plan_id})")
    return MessageResponse(message="Plan deleted successfully")


# --- TEMPLATES CRUD ---

@router.get('/templates', response_model=List[TemplateResponse], dependencies=[Depends(require_admin)])
def list_templates(db: Session = Depends(get_db)) -> List[TemplateResponse]:
    from ..models import Template
    templates = db.scalars(select(Template).order_by(Template.created_at.desc())).all()
    output = []
    for t in templates:
        try:
            payload = json.loads(t.payload_json)
        except Exception:
            payload = {}
        output.append(TemplateResponse(
            id=t.id, name=t.name, category=t.category,
            payload=payload,
            created_at=t.created_at, updated_at=t.updated_at
        ))
    return output


@router.post('/templates', response_model=TemplateResponse, dependencies=[Depends(require_admin)])
def create_template(payload: TemplateCreate, db: Session = Depends(get_db)) -> TemplateResponse:
    from ..models import Template
    existing = db.get(Template, payload.id)
    if existing:
        raise HTTPException(status_code=400, detail="Template ID already exists")

    template = Template(
        id=payload.id,
        name=payload.name,
        category=payload.category,
        payload_json=json.dumps(payload.payload)
    )
    db.add(template)
    db.commit()
    db.refresh(template)

    log_audit_action(db, "CREATE_TEMPLATE", f"Created settings template '{template.name}' ({template.id})")

    return TemplateResponse(
        id=template.id, name=template.name, category=template.category,
        payload=payload.payload,
        created_at=template.created_at, updated_at=template.updated_at
    )


@router.put('/templates/{template_id}', response_model=TemplateResponse, dependencies=[Depends(require_admin)])
def update_template(template_id: str, payload: TemplateCreate, db: Session = Depends(get_db)) -> TemplateResponse:
    from ..models import Template
    template = db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    template.name = payload.name
    template.category = payload.category
    template.payload_json = json.dumps(payload.payload)
    template.updated_at = utcnow()

    db.commit()
    db.refresh(template)

    log_audit_action(db, "UPDATE_TEMPLATE", f"Updated settings template '{template.name}' ({template.id})")

    return TemplateResponse(
        id=template.id, name=template.name, category=template.category,
        payload=payload.payload,
        created_at=template.created_at, updated_at=template.updated_at
    )


@router.delete('/templates/{template_id}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def delete_template(template_id: str, db: Session = Depends(get_db)) -> MessageResponse:
    from ..models import Template
    template = db.get(Template, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    name = template.name
    db.delete(template)
    db.commit()

    log_audit_action(db, "DELETE_TEMPLATE", f"Deleted settings template '{name}' ({template_id})")
    return MessageResponse(message="Template deleted successfully")



# --- USERS & DEVICES MANAGEMENT ---

@router.get('/users', response_model=List[AdminUserResponse], dependencies=[Depends(require_admin)])
def list_users(search: str = "", db: Session = Depends(get_db)) -> List[AdminUserResponse]:
    query = select(User)
    if search:
        query = query.where(User.email.like(f"%{search.strip().lower()}%"))

    users = db.scalars(query.order_by(User.created_at.desc())).all()
    output = []

    for u in users:
        # Load active subscription
        sub = active_subscription(db, u.id)
        # Load device count
        device_count = db.scalar(
            select(func.count(Device.id))
            .where(Device.user_id == u.id, Device.revoked_at.is_(None))
        ) or 0

        output.append(AdminUserResponse(
            id=u.id,
            email=u.email,
            plan_id=sub.plan_id if sub else None,
            plan_name=sub.plan.name if sub and sub.plan else ('Legacy Pro' if sub else None),
            subscription_status=sub.status if sub else None,
            subscription_expires_at=sub.expires_at if sub else None,
            device_count=device_count,
            settings_revision=u.settings_revision or 0,
            created_at=u.created_at
        ))
    return output


@router.put('/users/{user_id}/subscription', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def manual_update_subscription(user_id: str, payload: AdminUserSubscriptionUpdate, db: Session = Depends(get_db)) -> MessageResponse:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    plan = db.get(Plan, payload.plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Selected plan does not exist")

    # Deactivate existing active subscriptions
    db.execute(
        update(Subscription)
        .where(Subscription.user_id == user_id, Subscription.status == 'active')
        .values(status='cancelled', updated_at=utcnow())
    )

    # Create new subscription
    start = payload.starts_at or utcnow()
    sub = Subscription(
        user_id=user_id,
        plan_id=payload.plan_id,
        status=payload.status,
        starts_at=start,
        expires_at=payload.expires_at,
        source='admin_manual',
        source_payment_id=f"manual-{user_id}-{int(utcnow().timestamp())}",
        currency=payload.currency,
        amount_minor=payload.amount_minor
    )
    db.add(sub)
    db.flush()

    # Automatically sync templates associated with this plan
    sync_plan_templates_to_user(db, user, plan)
    db.commit()

    log_audit_action(db, "MANUAL_SUBSCRIPTION_GRANT", f"Manually granted plan '{plan.name}' to user '{user.email}' until {payload.expires_at.date()}")
    return MessageResponse(message="Subscription updated successfully")


@router.delete('/users/{user_id}/subscription', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def manual_remove_subscription(user_id: str, db: Session = Depends(get_db)) -> MessageResponse:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    db.execute(
        update(Subscription)
        .where(Subscription.user_id == user_id, Subscription.status == 'active')
        .values(status='cancelled', expires_at=utcnow(), updated_at=utcnow())
    )
    db.commit()

    log_audit_action(db, "MANUAL_SUBSCRIPTION_REMOVE", f"Revoked active subscription for user '{user.email}'")
    return MessageResponse(message="Subscription removed successfully")


@router.get('/users/{user_id}/devices', response_model=List[dict], dependencies=[Depends(require_admin)])
def list_user_devices(user_id: str, db: Session = Depends(get_db)) -> List[dict]:
    devices = db.scalars(
        select(Device)
        .where(Device.user_id == user_id, Device.revoked_at.is_(None))
        .order_by(Device.created_at.desc())
    ).all()
    return [{"device_id": d.device_id, "name": d.name, "created_at": d.created_at, "last_seen_at": d.last_seen_at} for d in devices]


@router.delete('/users/{user_id}/devices/{device_id}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def revoke_user_device(user_id: str, device_id: str, db: Session = Depends(get_db)) -> MessageResponse:
    device = db.scalar(
        select(Device)
        .where(Device.user_id == user_id, Device.device_id == device_id, Device.revoked_at.is_(None))
    )
    if not device:
        raise HTTPException(status_code=404, detail="Device session not found or already revoked")

    now = utcnow()
    device.revoked_at = now
    db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.device_id == device_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    db.commit()

    user = db.get(User, user_id)
    log_audit_action(db, "DEVICE_REVOKED", f"Revoked device '{device.name}' ({device_id}) for user '{user.email if user else user_id}'")
    return MessageResponse(message="Device revoked successfully")


@router.delete('/users/{user_id}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def delete_user(user_id: str, db: Session = Depends(get_db)) -> MessageResponse:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    email = user.email
    db.delete(user)
    db.commit()

    log_audit_action(db, "DELETE_USER", f"Permanently deleted user '{email}' and all associated devices/sessions")
    return MessageResponse(message="User permanently deleted")


# --- SNAPSHOT BACKUP & RESTORE ---

@router.get('/backups', response_model=List[BackupResponse], dependencies=[Depends(require_admin)])
def list_snapshots() -> List[BackupResponse]:
    backups = list_backups()
    return [BackupResponse(filename=b['filename'], size_bytes=b['size_bytes'], created_at=b['created_at']) for b in backups]


@router.post('/backups', response_model=BackupResponse, dependencies=[Depends(require_admin)])
def trigger_backup(db: Session = Depends(get_db)) -> BackupResponse:
    try:
        backup_path = take_database_backup()
        filename = os.path.basename(backup_path)
        stat = os.stat(backup_path)

        log_audit_action(db, "CREATE_BACKUP", f"Created system snapshot backup '{filename}' ({stat.st_size} bytes)")

        return BackupResponse(filename=filename, size_bytes=stat.st_size, created_at=utcnow())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Backup failed: {str(exc)}")


@router.post('/backups/{filename}/restore', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def restore_backup_snapshot(filename: str, db: Session = Depends(get_db)) -> MessageResponse:
    # Ensure uvicorn worker expires any cached SQLAlchemy sessions on next query
    try:
        safe_backup_path(filename)
        restore_database_backup(filename)

        # Log to the newly restored database itself!
        log_audit_action(db, "RESTORE_BACKUP", f"Restored system database state from snapshot '{filename}'")

        return MessageResponse(message="System database restored successfully")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Backup file not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Database restore failed: {str(exc)}")


@router.delete('/backups/{filename}', response_model=MessageResponse, dependencies=[Depends(require_admin)])
def delete_backup_snapshot(filename: str, db: Session = Depends(get_db)) -> MessageResponse:
    filepath = safe_backup_path(filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Backup file not found")
    try:
        os.remove(filepath)
        log_audit_action(db, "DELETE_BACKUP", f"Deleted database snapshot '{filename}'")
        return MessageResponse(message="Backup file deleted successfully")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete backup file: {str(exc)}")


@router.get('/backups/{filename}/download', dependencies=[Depends(require_admin)])
def download_backup_snapshot(filename: str) -> FileResponse:
    filepath = safe_backup_path(filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Backup file not found")
    return FileResponse(filepath, filename=filename, media_type="application/octet-stream")


# --- AUDIT LOGS ---

@router.get('/audit-logs', response_model=List[AuditLogResponse], dependencies=[Depends(require_admin)])
def query_audit_logs(limit: int = 100, db: Session = Depends(get_db)) -> List[AuditLogResponse]:
    logs = db.scalars(
        select(AdminAuditLog)
        .order_by(AdminAuditLog.created_at.desc())
        .limit(limit)
    ).all()
    return [AuditLogResponse(id=l.id, action=l.action, details=l.details, created_at=l.created_at) for l in logs]


# --- SYSTEM SETTINGS ---

@router.get('/settings', dependencies=[Depends(require_admin)])
def get_system_settings(db: Session = Depends(get_db), settings_env: Settings = Depends(get_settings)) -> dict:
    from ..models import SystemSetting
    settings_records = db.scalars(select(SystemSetting)).all()
    settings_dict = {s.key: s.value for s in settings_records}

    defaults = {
        "rclone_config": "",
        "rclone_remote_path": "",
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "max_backup_count": "14",
        "max_backup_size_mb": "100",
        "auto_backup_enabled": "true"
    }
    for k, v in defaults.items():
        if k not in settings_dict:
            settings_dict[k] = v

    settings_dict["razorpay_webhook_secret_configured"] = "true" if settings_env.razorpay_webhook_secret else "false"
    base = settings_env.api_base_url.rstrip("/") if settings_env.api_base_url else "https://<your-domain>"
    settings_dict["razorpay_webhook_url"] = f"{base}/v1/webhooks/razorpay"

    return settings_dict


@router.put('/settings', dependencies=[Depends(require_admin)])
def update_system_settings(payload: dict, db: Session = Depends(get_db)) -> MessageResponse:
    from ..models import SystemSetting
    for k, v in payload.items():
        setting = db.get(SystemSetting, k)
        if not setting:
            setting = SystemSetting(key=k, value=str(v))
            db.add(setting)
        else:
            setting.value = str(v)

    db.commit()
    log_audit_action(db, "UPDATE_SYSTEM_SETTINGS", "Updated system dashboard and backup configuration settings")
    return MessageResponse(message="Settings updated successfully")
