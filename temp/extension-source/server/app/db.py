from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()

# SQLite needs check_same_thread=False because FastAPI dispatches sync routes
# on a thread-pool. pool_pre_ping is omitted — it's a no-op for file-based DBs.
_connect_args = {'check_same_thread': False} if settings.database_url.startswith('sqlite') else {}
engine = create_engine(settings.database_url, connect_args=_connect_args, future=True)

# Enable WAL journal mode for SQLite so concurrent reads don't block writes.
# Safe to call on non-SQLite engines — the event simply won't fire.
if settings.database_url.startswith('sqlite'):
    @event.listens_for(engine, 'connect')
    def _set_wal_mode(dbapi_connection, _connection_record):  # type: ignore[misc]
        dbapi_connection.execute('PRAGMA journal_mode=WAL')
        dbapi_connection.execute('PRAGMA synchronous=NORMAL')
        dbapi_connection.execute('PRAGMA foreign_keys=ON')

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
