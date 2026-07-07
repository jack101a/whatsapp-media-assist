"""Template visibility controls

Revision ID: 8df2c7a941bb
Revises: 0213b9b90837
Create Date: 2026-06-30 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '8df2c7a941bb'
down_revision: Union[str, None] = '0213b9b90837'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('templates') as batch:
        batch.add_column(sa.Column('is_enabled', sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column('user_email', sa.String(length=320), nullable=True))
    op.create_index(op.f('ix_templates_is_enabled'), 'templates', ['is_enabled'], unique=False)
    op.create_index(op.f('ix_templates_user_email'), 'templates', ['user_email'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_templates_user_email'), table_name='templates')
    op.drop_index(op.f('ix_templates_is_enabled'), table_name='templates')
    with op.batch_alter_table('templates') as batch:
        batch.drop_column('user_email')
        batch.drop_column('is_enabled')
