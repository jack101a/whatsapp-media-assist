#!/bin/sh
set -eu
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/media-assist-$STAMP.db"
mkdir -p "$BACKUP_DIR"
# SQLite's online backup API includes committed WAL data without stopping the API.
docker compose exec -T api python - <<'PY' > "$TARGET"
import sqlite3, sys, tempfile
source = sqlite3.connect('file:/data/media-assist.db?mode=ro', uri=True)
with tempfile.NamedTemporaryFile(suffix='.db') as tmp:
    target = sqlite3.connect(tmp.name)
    source.backup(target)
    target.close()
    source.close()
    tmp.seek(0)
    sys.stdout.buffer.write(tmp.read())
PY
find "$BACKUP_DIR" -type f -name 'media-assist-*.db' -mtime +14 -delete
printf 'Backup written to %s\n' "$TARGET"
