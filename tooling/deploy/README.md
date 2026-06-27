# Oracle VPS Docker deployment

Run from this directory after completing `../server/.env`:

```bash
docker compose up -d --build
```

The API binds only to `127.0.0.1:8787`. Publish it through HTTPS using Caddy, Pangolin, Cloudflare Tunnel or another reverse proxy.

Useful commands:

```bash
docker compose ps
docker compose logs -f api
docker compose exec api alembic current
./backup.sh
```

See `../DEPLOYMENT.md` for the full checklist.
