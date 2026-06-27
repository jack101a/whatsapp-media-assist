# Security model

## Protected server secrets

Never place these in the extension, public source archive or GitHub:

- Razorpay key secret
- Razorpay webhook secret
- entitlement private key
- JWT secret
- OTP pepper
- Brevo API key
- PostgreSQL password

## Entitlements

- P-256 ECDSA signatures
- random installation/device binding
- 24-hour refresh target
- 72-hour offline grace
- server-controlled annual expiry
- maximum three active devices by default
- refund and device revocation support

The public verification key is intentionally included in the extension. It cannot create valid entitlements.

A skilled attacker can still modify a locally loaded copy of any browser extension. Server entitlements prevent ordinary key generation, sharing and refund bypass, but cannot make client-side code impossible to patch.

## Authentication

- six-digit email OTP
- OTP HMAC hashing
- email cooldown and per-IP/per-email request limits
- maximum attempts and expiry
- 15-minute access tokens
- rotating refresh tokens
- refresh-token replay revokes the active device token chain
- server-side sign-out and device revocation

## Payments

- Razorpay-hosted Payment Links
- webhook HMAC validation over the raw body
- event-ID idempotency
- payment link, amount and currency checks
- activation only after captured payment webhook
- full-refund revocation

## Extension boundary

Only the background service worker can contact the configured licensing API. The WhatsApp content script processes media locally and does not contain payment secrets.

## Reporting

```text
security@002529.xyz
```


## Dependency audit

`npm audit --omit=dev` reports zero production dependency vulnerabilities. The full development tree currently reports advisories inside WXT/Vite/Firefox packaging tooling; those development packages are not included in the Chrome or Firefox runtime ZIPs.
