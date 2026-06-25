# Production deployment

This release assumes the API domain:

```text
mediaassist.002529.xyz
```

Change it before building if you use another hostname.

## 1. DNS and HTTPS

Point the hostname to the Oracle VPS or expose `127.0.0.1:8787` through your existing tunnel/reverse proxy.

The public API must use HTTPS.

## 2. Prepare the VPS files

Upload these directories to one private folder:

```text
server/
deploy/
owner-secrets/
```

Keep `owner-secrets/entitlement-private.pem` private:

```bash
chmod 600 owner-secrets/entitlement-private.pem
```

The matching public key is already embedded in the extension. Replacing the private key requires rebuilding the extension with its new public key.

## 3. Generate local secrets

From the project root:

```bash
python3 deploy/prepare.py
```

This creates:

```text
deploy/.env
server/.env
```

Then edit `server/.env` and add:

```text
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
BREVO_API_KEY
BREVO_SENDER_EMAIL
```

Set `ENABLE_USD_CHECKOUT=true` only after Razorpay enables international payments for your merchant account.

## 4. Start Docker

```bash
cd deploy
docker compose up -d --build
```

Check:

```bash
docker compose ps
docker compose logs -f api
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

## 5. Reverse proxy

An optional Caddy example is included in `deploy/Caddyfile.example`.

Public endpoints that must work:

```text
GET  /healthz
GET  /readyz
POST /v1/auth/request-otp
POST /v1/webhooks/razorpay
```

Do not expose PostgreSQL publicly.

## 6. Brevo

Use a verified sender/domain. The server sends only six-digit sign-in codes.

Test login from the extension Options page before enabling live checkout.

## 7. Razorpay

Create a webhook pointing to:

```text
https://mediaassist.002529.xyz/v1/webhooks/razorpay
```

Use the exact same secret in Razorpay and `server/.env`.

Subscribe to:

```text
payment_link.paid
refund.processed
payment.refunded
```

Start in Razorpay Test Mode. Complete a test purchase and confirm:

- webhook returns HTTP 200
- account changes to Pro
- entitlement is active for 365 days
- duplicate webhook event does not add a second year
- full refund removes Pro access

## 8. Extension build

```bash
npm ci
npm run release
```

Load `.output/chrome-mv3` unpacked and test against the live API before uploading the Chrome ZIP.

## 9. Backups

```bash
cd deploy
./backup.sh
```

Back up separately:

- PostgreSQL dump
- `owner-secrets/entitlement-private.pem`
- `server/.env`

Losing the entitlement private key prevents the server from issuing tokens accepted by the published extension.

## 10. Final release checks

- OTP email delivery works
- INR checkout works
- USD option appears only when enabled
- Razorpay webhook signature failures return 401
- payment amount/currency/link mismatch does not activate Pro
- Pro pipeline button appears in WhatsApp
- expired/refunded account loses Pro after refresh or grace expiry
- no image/PDF request reaches the licensing API
- Chrome and Firefox packages load without manifest errors
