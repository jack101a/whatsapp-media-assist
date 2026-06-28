# WhatsApp Media Assist

WhatsApp Media Assist adds lightweight image and PDF tools only when media is opened in WhatsApp Web.

## Features

- Live crop and rotate preview
- Resize, convert and target-size compression
- A4 image/PDF merge workspace
- Top/bottom, side-by-side and image-only grid layouts
- Small popup: Enable/Disable and Settings
- Full light-theme Options page
- Pro pipelines that create named one-click WhatsApp toolbar buttons
- Email OTP login and automatic settings/pipeline sync
- One active device per account
- Razorpay annual Pro activation

## Privacy

Images, PDFs, chats, contacts, filenames and WhatsApp URLs stay on the device. The server receives only account, device, payment, entitlement, pipeline and extension-preference data. WhatsApp Media Assist is independent and is not affiliated with WhatsApp LLC or Meta Platforms, Inc.

## Architecture

- `entrypoints/`, `src/` — Chrome/Firefox extension
- `server/` — lightweight FastAPI + SQLite licensing API
- `deploy/` — one-container Docker deployment and SQLite backup tools
- `tests/`, `server/tests/` — extension and API tests

The SQLite database runs in WAL mode with one API worker. Heavy image/PDF processing is loaded only when requested and is removed after it becomes idle.

## Build

```bash
npm ci
npm run release
```

Server tests:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r server/requirements-dev.txt
PYTHONPATH=server pytest -q server/tests
```

Default API origin:

```text
https://mediaassist.002529.xyz
```

Override it while building:

```bash
VITE_MEDIA_ASSIST_API_ORIGIN=https://your-api.example.com npm run release
```
