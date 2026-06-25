"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-06-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('users',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('email', sa.String(320), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('email'),
    )
    op.create_index('ix_users_email', 'users', ['email'])
    op.create_table('devices',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('device_id', sa.String(128), nullable=False),
        sa.Column('name', sa.String(160), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('user_id', 'device_id', name='uq_device_user_device'),
    )
    op.create_index('ix_devices_user_id', 'devices', ['user_id'])
    op.create_index('ix_devices_device_id', 'devices', ['device_id'])
    op.create_table('otp_codes',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('email', sa.String(320), nullable=False),
        sa.Column('code_hash', sa.String(128), nullable=False),
        sa.Column('request_ip_hash', sa.String(64), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_otp_codes_email', 'otp_codes', ['email'])
    op.create_index('ix_otp_codes_request_ip_hash', 'otp_codes', ['request_ip_hash'])
    op.create_index('ix_otp_codes_created_at', 'otp_codes', ['created_at'])
    op.create_table('refresh_tokens',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('device_id', sa.String(128), nullable=False),
        sa.Column('token_hash', sa.String(64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('replaced_by_hash', sa.String(64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_refresh_tokens_user_id', 'refresh_tokens', ['user_id'])
    op.create_index('ix_refresh_tokens_device_id', 'refresh_tokens', ['device_id'])
    op.create_index('ix_refresh_tokens_token_hash', 'refresh_tokens', ['token_hash'])
    op.create_table('subscriptions',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('source', sa.String(32), nullable=False),
        sa.Column('source_payment_id', sa.String(128), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('amount_minor', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint('source_payment_id'),
    )
    op.create_index('ix_subscriptions_user_id', 'subscriptions', ['user_id'])
    op.create_index('ix_subscriptions_status', 'subscriptions', ['status'])
    op.create_index('ix_subscriptions_expires_at', 'subscriptions', ['expires_at'])
    op.create_index('ix_subscriptions_source_payment_id', 'subscriptions', ['source_payment_id'])
    op.create_table('checkouts',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('reference_id', sa.String(40), nullable=False),
        sa.Column('razorpay_link_id', sa.String(128), nullable=True),
        sa.Column('short_url', sa.Text(), nullable=True),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('amount_minor', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint('reference_id'),
        sa.UniqueConstraint('razorpay_link_id'),
    )
    op.create_index('ix_checkouts_user_id', 'checkouts', ['user_id'])
    op.create_index('ix_checkouts_reference_id', 'checkouts', ['reference_id'])
    op.create_index('ix_checkouts_status', 'checkouts', ['status'])
    op.create_table('payment_events',
        sa.Column('id', sa.String(128), primary_key=True),
        sa.Column('event_type', sa.String(80), nullable=False),
        sa.Column('payload_json', sa.Text(), nullable=False),
        sa.Column('processed_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_payment_events_event_type', 'payment_events', ['event_type'])


def downgrade() -> None:
    op.drop_table('payment_events')
    op.drop_table('checkouts')
    op.drop_table('subscriptions')
    op.drop_table('refresh_tokens')
    op.drop_table('otp_codes')
    op.drop_table('devices')
    op.drop_table('users')
