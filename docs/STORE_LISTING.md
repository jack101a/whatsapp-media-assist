# Chrome Web Store Listing

## Product Name

WhatsApp Media Assist

## Short Description

Crop, resize, compress, merge and automate media opened in WhatsApp Web.

## Full Description

WhatsApp Media Assist adds a compact toolbar only when an image or PDF is opened in WhatsApp Web.

- live crop and rotate preview
- resize, convert and compress images
- compress scanned PDFs
- merge images or PDF pages on A4
- top/bottom, side-by-side and image-only grid layouts
- named Pro pipeline buttons for repeated workflows
- email OTP login and optional settings/template sync

A pipeline such as **Upload1** can combine crop, resize, JPEG conversion, target file size, filename rules and automatic download into one button.

WhatsApp media stays on the device. WhatsApp Media Assist does not read chats, captions, contacts, phone numbers, conversation history, media URLs or downloaded filenames.

WhatsApp Media Assist is an independent extension and is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta Platforms, Inc.

## Category

Productivity

## Language

English

## Permissions Explanation

- **Storage:** preferences, local presets, pipelines, account session and signed entitlement.
- **Alarms:** lightweight entitlement/settings refresh without continuous polling.
- **web.whatsapp.com:** detects the opened media viewer and displays local tools.
- **Licensing API:** OTP login, settings sync, checkout and Pro entitlement.

## Data Disclosure

Processed:

- email address
- random device ID and device name
- authentication tokens
- payment and entitlement status
- extension preferences and pipeline/template configurations

Not processed:

- WhatsApp media files
- chats, captions, contacts, phone numbers or conversation history
- WhatsApp media URLs
- downloaded filenames

## Pricing

One annual Pro product: INR 500 for 365 days; USD 4.99 when international checkout is enabled.

## Store Assets

Use the files in `assets/store-assets/`:

- `icon-source-512.png` - source icon
- `promo-small-440x280.png` - small promotional tile
- `promo-marquee-1400x560.png` - marquee promotional tile
- `screenshots/01-whatsapp-media-tools.png`
- `screenshots/02-full-options-page.png`
- `screenshots/02-pipeline-builder.png`
- `screenshots/03-a4-merge-workspace.png`

AI-generated professional source artwork is saved separately in `assets/store-assets/ai-generated/`:

- `icon-rich-source.png` - richer icon source, text-free
- `promo-marquee-source.png` - marquee promotional artwork source
- `promo-text-free-source.png` - text-free promotional artwork source
- `promo-text-concept-source.png` - visual direction reference only; do not upload directly because generated text may be inaccurate

Chrome Web Store upload fields require exact dimensions. The exact-size files above have been exported from the AI-generated sources for submission.

## Chrome Package

Upload only the Chrome package generated from the Chrome MV3 build:

```bash
pnpm --filter whatsapp-media-assist-extension build
pnpm --filter whatsapp-media-assist-extension exec wxt zip
```

Expected Chrome build/package:

```text
apps/extension/.output/chrome-mv3/
apps/extension/.output/whatsapp-media-assist-extension-0.0.1-chrome.zip
```

Do not upload the Firefox package to Chrome Web Store.

## Firefox Package

Firefox must use the Firefox MV3 build/package:

```bash
pnpm --filter whatsapp-media-assist-extension exec wxt zip -b firefox
```

Expected Firefox build/package:

```text
apps/extension/.output/firefox-mv3/
apps/extension/.output/whatsapp-media-assist-extension-0.0.1-firefox.zip
```

Do not upload the Chrome package to Mozilla Add-ons.

## Chrome Web Store Publishing Checklist

1. Create or open the item in the Chrome Web Store Developer Dashboard.
2. Upload the Chrome ZIP only.
3. Complete the Store listing using the copy above.
4. Upload screenshots and promotional assets from `assets/store-assets/`.
5. Complete the Privacy tab:
   - Single purpose: local WhatsApp Web media editing and optional Pro account sync.
   - Declare email/authentication/payment/account data only.
   - State that WhatsApp media, chats, contacts and filenames are not collected.
6. Add the privacy policy URL or paste the policy from `docs/PRIVACY_POLICY.md`.
7. Set support email to `support.mediaassit@002529.xyz`.
8. Submit for review.

## Support And Refund Copy

Use **support.mediaassit@002529.xyz** for public support contact. No refunds. Users are responsible for complying with WhatsApp's terms and policies; WhatsApp Media Assist is not responsible for WhatsApp account restrictions or other consequences caused by how the extension is used.
