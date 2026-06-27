#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/media-assist-backup.db" >&2
  exit 1
fi
BACKUP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
test -f "$BACKUP"
# Validate before replacing the live database.
python3 - "$BACKUP" <<'PY'
import sqlite3, sys
con = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
result = con.execute('PRAGMA integrity_check').fetchone()[0]
con.close()
if result != 'ok':
    raise SystemExit(f'Backup integrity check failed: {result}')
PY
docker compose stop api
docker compose run --rm --no-deps --user 0:0 \
  -v "$BACKUP:/restore.db:ro" \
  --entrypoint sh api -c 'rm -f /data/media-assist.db /data/media-assist.db-wal /data/media-assist.db-shm; cp /restore.db /data/media-assist.db; chown mediaassist:mediaassist /data/media-assist.db'
docker compose up -d api
printf 'Database restored from %s\n' "$BACKUP"
