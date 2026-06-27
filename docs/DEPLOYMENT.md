# Production deployment

## 1. Files

Keep these together on the Oracle VPS:

```text
server/
deploy/
owner-secrets/entitlement-private.pem
```

```bash
chmod 600 owner-secrets/entitlement-private.pem
python3 deploy/prepare.py
```

Edit `server/.env` and add the Razorpay and Brevo credentials.

## 2. Start

```bash
cd deploy
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

The deployment uses:

- one API container
- one Uvicorn worker
- SQLite at `/data/media-assist.db`
- WAL mode and a persistent Docker volume

Health checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

Expose port `8787` through HTTPS using your reverse proxy or tunnel.

## 3. Razorpay webhook

```text
https://mediaassist.002529.xyz/v1/webhooks/razorpay
```

Events:

```text
payment_link.paid
refund.processed
payment.refunded
```

Start in Test Mode. Verify purchase, duplicate webhook handling and a full refund.

## 4. Login and sync

Test the following:

- OTP delivery through Brevo
- first login uploads local settings when the account has none
- login on a new browser restores server settings
- new login revokes the previous device
- old access/refresh tokens return 401
- pending setting changes retry after reconnecting

A replaced device loses server access immediately. Every paid pipeline performs a lightweight online entitlement check before running, so a displaced device cannot continue using paid pipelines. The signed local entitlement cache is retained only for UI status and short network interruptions.

## 5. SQLite backup

Online backup without stopping the API:

```bash
cd deploy
./backup.sh
```

Restore:

```bash
./restore.sh ./backups/media-assist-YYYYMMDDTHHMMSSZ.db
```

Back up separately:

- SQLite backup files
- `owner-secrets/entitlement-private.pem`
- `server/.env`

## 6. Extension

```bash
npm ci
npm run release
```

Load `.output/chrome-mv3` unpacked and test real WhatsApp image, HD-image, image-document and PDF viewers before store submission.
