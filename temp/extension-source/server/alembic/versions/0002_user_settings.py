"""add synced user settings

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('settings_json', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('settings_revision', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('users', sa.Column('settings_updated_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'settings_updated_at')
    op.drop_column('users', 'settings_revision')
    op.drop_column('users', 'settings_json')
