# Security model

## Secrets

Never put these in the extension or public repository:

- Razorpay key/webhook secrets
- entitlement private key
- JWT secret
- OTP pepper
- Brevo API key

## Account and entitlement

- email OTP with cooldown, expiry and attempt limits
- rotating refresh tokens and replay detection
- one active device per account
- old server sessions revoked on a new OTP login
- P-256 signed, device-bound Pro entitlement
- 10-minute refresh target
- online entitlement verification before every paid pipeline execution
- short signed local cache for UI status; it cannot authorize a paid pipeline by itself
- server-controlled annual expiry and refund revocation

The public verification key in the extension cannot generate valid entitlements. A skilled attacker can still patch a locally modified extension, as with any client-side premium feature.

## SQLite

- one API worker
- WAL journal mode
- foreign keys enabled
- 10-second busy timeout
- online backup API used for consistent backups
- database stored only in a persistent Docker volume

## Media boundary

The WhatsApp content script does not send media to the API. Heavy merge/PDF work runs through an extension-origin processor and is destroyed after three idle seconds. A 120-second timeout prevents stuck processing jobs.

## Payments

Razorpay checkout is hosted by Razorpay. Pro activates only after a verified, idempotent webhook whose payment link, amount and currency match the server checkout record.
