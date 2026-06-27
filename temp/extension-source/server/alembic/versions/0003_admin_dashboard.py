"""add admin dashboard catalog and backups

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'plans',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('tier', sa.String(24), nullable=False),
        sa.Column('price_inr_minor', sa.Integer(), nullable=False),
        sa.Column('price_usd_minor', sa.Integer(), nullable=False),
        sa.Column('duration_days', sa.Integer(), nullable=False),
        sa.Column('features_json', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        'templates',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('category', sa.String(50), nullable=True),
        sa.Column('payload_json', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_templates_category', 'templates', ['category'])
    op.create_table(
        'admin_audit_logs',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('action', sa.String(100), nullable=False),
        sa.Column('details', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_admin_audit_logs_action', 'admin_audit_logs', ['action'])
    op.create_table(
        'system_settings',
        sa.Column('key', sa.String(100), primary_key=True),
        sa.Column('value', sa.Text(), nullable=False),
    )

    with op.batch_alter_table('subscriptions') as batch_op:
        batch_op.add_column(sa.Column('plan_id', sa.String(36), nullable=True))
        batch_op.create_index('ix_subscriptions_plan_id', ['plan_id'])
        batch_op.create_foreign_key('fk_subscriptions_plan_id_plans', 'plans', ['plan_id'], ['id'], ondelete='SET NULL')

    with op.batch_alter_table('checkouts') as batch_op:
        batch_op.add_column(sa.Column('plan_id', sa.String(36), nullable=True))
        batch_op.create_index('ix_checkouts_plan_id', ['plan_id'])
        batch_op.create_foreign_key('fk_checkouts_plan_id_plans', 'plans', ['plan_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    with op.batch_alter_table('checkouts') as batch_op:
        batch_op.drop_constraint('fk_checkouts_plan_id_plans', type_='foreignkey')
        batch_op.drop_index('ix_checkouts_plan_id')
        batch_op.drop_column('plan_id')

    with op.batch_alter_table('subscriptions') as batch_op:
        batch_op.drop_constraint('fk_subscriptions_plan_id_plans', type_='foreignkey')
        batch_op.drop_index('ix_subscriptions_plan_id')
        batch_op.drop_column('plan_id')

    op.drop_table('system_settings')
    op.drop_index('ix_admin_audit_logs_action', table_name='admin_audit_logs')
    op.drop_table('admin_audit_logs')
    op.drop_index('ix_templates_category', table_name='templates')
    op.drop_table('templates')
    op.drop_table('plans')
