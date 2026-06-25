#!/usr/bin/env sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 backups/file.sql.gz" >&2
  exit 2
fi
file="$1"
[ -f "$file" ] || { echo "Backup not found: $file" >&2; exit 2; }
echo "This replaces the current mediaassist database. Type RESTORE to continue:"
read answer
[ "$answer" = "RESTORE" ] || exit 1
docker compose exec -T db psql -U mediaassist -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mediaassist' AND pid <> pg_backend_pid();"
docker compose exec -T db dropdb -U mediaassist --if-exists mediaassist
docker compose exec -T db createdb -U mediaassist mediaassist
gzip -dc "$file" | docker compose exec -T db psql -U mediaassist -d mediaassist
echo "Restore complete"
