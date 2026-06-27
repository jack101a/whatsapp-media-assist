#!/usr/bin/env sh
set -eu
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/mediaassist-${stamp}.sql.gz"
docker compose exec -T db pg_dump -U mediaassist -d mediaassist | gzip -9 > "$out"
echo "Created $out"
