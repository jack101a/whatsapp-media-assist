# Media Assist for WhatsApp Web

Media Assist adds local image and PDF tools to the opened WhatsApp Web media viewer.

## Included

- Crop, rotate, resize, convert and compress images
- Compress scanned/image-based PDFs locally
- Add images or PDF pages to an A4 merge stack
- Top/bottom, side-by-side and image grid layouts
- Light full-page Options interface
- Small popup with Enable/Disable and Settings only
- Pro pipelines: combine multiple steps into a named WhatsApp toolbar button
- Online annual Pro activation through Razorpay
- Email OTP login, device management and 72-hour signed offline entitlement grace

## Privacy boundary

WhatsApp media processing runs inside the browser. Images, PDFs, filenames, chats, contacts and WhatsApp URLs are not sent to the licensing server.

The licensing API receives only account, device, payment and entitlement records.

## Repository layout

- `entrypoints/` — popup, Options, background and WhatsApp content entrypoints
- `src/` — processing, UI, storage, billing and WhatsApp adapter modules
- `server/` — FastAPI licensing/payment API
- `deploy/` — Docker Compose and reverse-proxy deployment files
- `tests/` — extension tests
- `server/tests/` — API security and purchase-flow tests
- `store-assets/` — Chrome Web Store screenshots and promotional artwork

## Development

```bash
npm ci
npm run build
```

Server tests:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r server/requirements.txt
PYTHONPATH=server pytest -q server/tests
```

## Production builds

The default API origin is:

```text
https://mediaassist.002529.xyz
```

To use another domain, rebuild with:

```bash
VITE_MEDIA_ASSIST_API_ORIGIN=https://your-api.example.com npm run release
```

See `DEPLOYMENT.md` before publishing.
