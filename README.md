# WhatsApp Media Assist

WhatsApp Media Assist adds lightweight image and PDF tools only when media is opened in WhatsApp Web.

## Features

- Live crop and rotate preview
- Resize, convert, and target-size compression
- A4 image/PDF merge workspace
- Top/bottom, side-by-side, and image-only grid layouts
- Small popup: Enable/Disable and Settings
- Full light-theme Options page
- Pro pipelines that create named one-click WhatsApp toolbar buttons
- Email OTP login and automatic settings/pipeline sync
- One active device per account
- Razorpay annual Pro activation

## Privacy

Images, PDFs, chats, contacts, filenames, and WhatsApp URLs stay on the device. The server receives only account, device, entitlement, pipeline, extension-preference, and Razorpay order/reference data needed for Pro access. Payment card, UPI, bank, and wallet details are handled by Razorpay. WhatsApp Media Assist is independent and is not affiliated with WhatsApp LLC or Meta Platforms, Inc.

Public privacy policy:

```text
https://mediaassist.002529.xyz/privacy-policy
```

## Architecture

- `apps/extension/entrypoints/`, `apps/extension/src/` - Chrome/Firefox extension
- `apps/server/` - lightweight FastAPI + SQLite licensing API
- `tooling/deploy/` - one-container Docker deployment and SQLite backup tools
- `apps/extension/tests/`, `apps/server/tests/` - extension and API tests

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
pip install -r apps/server/requirements-dev.txt
PYTHONPATH=apps/server pytest -q apps/server/tests
```

Default API origin:

```text
https://mediaassist.002529.xyz
```

Override it while building:

```bash
VITE_MEDIA_ASSIST_API_ORIGIN=https://your-api.example.com npm run release
```

## Docker Deployment

The server image is published to GitHub Container Registry:

```text
ghcr.io/jack101a/whatsapp-media-assist-server:latest
```

The Portainer stack compose is in `tooling/deploy/docker-compose.yml`. It follows the same config-path storage pattern as the existing stacks:

```yaml
volumes:
  - ${CONFIG_PATH:-/srv/ajaxhs/config}/media_assist_test/data:/data
networks:
  ajax_network:
    external: true
```

For `mediaassist.002529.xyz`, keep the `ajax_network` aliases `mediaassist-api` and `whatsapp-media-assist-api` because the reverse proxy routes to `http://whatsapp-media-assist-api:8787`.

Plan name, duration, features, and INR/USD prices are managed from the admin dashboard. The public checkout uses the `pro` plan when it exists; otherwise it uses the newest dashboard plan. Built-in server defaults are only a first-run fallback before any plan is created.
