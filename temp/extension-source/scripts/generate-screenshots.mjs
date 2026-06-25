import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const project = process.cwd();
const output = join(project, '.output/chrome-mv3');
const screenshots = join(project, 'store-assets/screenshots');
mkdirSync(screenshots, { recursive: true });
const tempOptions = join(project, '.tmp-options-screenshot.js');
const ignoreCss = { name: 'ignore-css', setup(builder) { builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' })); } };
await build({ entryPoints: [join(project, 'entrypoints/options/main.tsx')], bundle: true, format: 'iife', platform: 'browser', outfile: tempOptions, plugins: [ignoreCss] });

const deviceId = 'screenshot-device-0001';
const payload = {
  licenseId: 'screenshot-license', tier: 'premium', issuedAt: Date.now() - 1000,
  refreshAfter: Date.now() + 86_400_000, expiresAt: Date.now() + 259_200_000,
  subscriptionExpiresAt: Date.now() + 31_536_000_000, customer: 'owner@example.com',
  userId: 'screenshot-user', deviceId, features: ['pipelines'], nonce: 'screenshot',
};
const token = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.alloc(64, 1).toString('base64url')}`;
const profile = {
  id: 'upload1', name: 'Upload1', pinned: true, inputCount: 1, mergeLayout: 'vertical', background: '#ffffff',
  steps: [
    { id: 'crop', type: 'crop', mode: 'ask', ratio: 'free' },
    { id: 'resize', type: 'resize', width: 800, height: 1000, fit: 'contain', allowUpscale: false },
    { id: 'format', type: 'format', format: 'jpeg' },
    { id: 'compress', type: 'compress', minKB: 100, maxKB: 200 },
    { id: 'filename', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true },
    { id: 'download', type: 'download', automatic: true },
  ],
  createdAt: Date.now(), updatedAt: Date.now(),
};
const initialStore = {
  mediaAssistBilling: { deviceId, email: 'owner@example.com', entitlementToken: token },
  mediaAssistSettings: { enabled: true, showToolbarLabels: true, showRotateControls: true, autoOpenMergeWorkspace: true, profiles: [profile] },
};

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

async function mockChrome(page, storeSeed = initialStore) {
  await page.evaluate(({ storeSeed }) => {
    if (!globalThis.crypto?.subtle) {
      const cryptoValue = globalThis.crypto ?? {};
      Object.defineProperty(cryptoValue, 'subtle', { configurable: true, value: { importKey: async () => ({}), verify: async () => true } });
      if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoValue });
    }
    const listeners = new Set();
    const store = structuredClone(storeSeed);
    globalThis.chrome = {
      runtime: {
        id: 'media-assist-screenshot',
        getURL: (path) => globalThis.__resourceUrls?.[path] || path,
        openOptionsPage: async () => {},
        sendMessage: async (request) => {
          if (request?.type === 'billing:get-status') return { ok: true, data: { signedIn: true, email: 'owner@example.com', premium: true, deviceId: 'screenshot-device-0001', entitlement: { subscriptionExpiresAt: Date.now() + 31_536_000_000 } } };
          if (request?.type === 'billing:get-product') return { ok: true, data: { name: 'Media Assist Pro', duration_days: 365, prices: [{ currency: 'INR', amount_minor: 50000, label: '₹500 / 365 days' }, { currency: 'USD', amount_minor: 499, label: '$4.99 / 365 days' }] } };
          return { ok: false, error: 'Screenshot action unavailable' };
        },
      },
      storage: {
        local: {
          get: async (key) => typeof key === 'string' ? { [key]: store[key] } : { ...store },
          set: async (values) => {
            for (const [key, value] of Object.entries(values)) {
              const oldValue = store[key]; store[key] = value;
              for (const listener of listeners) listener({ [key]: { oldValue, newValue: value } }, 'local');
            }
          },
        },
        onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
      },
    };
  }, { storeSeed });
}

const svg = (label, a = '#0f8e73', b = '#263b61') => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1125"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1800" height="1125" fill="url(#g)"/><circle cx="1330" cy="340" r="240" fill="#fff" opacity=".13"/><path d="M0 980 420 530 720 820 1060 380 1800 1010V1125H0Z" fill="#081f2d" opacity=".52"/><text x="900" y="1020" fill="white" font-family="Arial" font-weight="700" font-size="74" text-anchor="middle">${label}</text></svg>`)}`;

async function createMediaPage(label = 'Application photo', source = svg(label)) {
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Arial;background:#0b141a;color:#e9edef}
    .appbar{height:72px;background:#111b21;border-bottom:1px solid #26353d;display:flex;align-items:center;padding:0 24px;gap:14px}.wa{width:34px;height:34px;border-radius:50%;background:#25d366;display:grid;place-items:center;font-weight:900}.appbar strong{font-size:19px}.official{margin-left:auto;display:flex;gap:26px;font-size:22px;color:#d9e2e5}
    .rail{position:absolute;top:72px;bottom:0;left:0;width:74px;background:#111b21;border-right:1px solid #26353d;display:flex;flex-direction:column;align-items:center;gap:27px;padding-top:28px}.rail i{width:22px;height:22px;border:2px solid #8da0a9;border-radius:6px;opacity:.75}
    .viewer{position:fixed;left:74px;top:72px;right:0;bottom:0;z-index:100;background:#0b141a;display:flex;align-items:center;justify-content:center}.viewer img{width:850px;height:532px;object-fit:contain;border-radius:4px;box-shadow:0 14px 42px rgba(0,0,0,.42)}
    .caption{position:fixed;left:100px;bottom:23px;color:#8696a0;font-size:12px}.caption strong{display:block;color:#e9edef;font-size:14px;margin-bottom:4px}
  </style><header class="appbar"><span class="wa">W</span><strong>WhatsApp</strong><span style="color:#8696a0">Media viewer</span><div class="official"><span>☆</span><span>⇩</span><span>×</span></div></header><aside class="rail">${'<i></i>'.repeat(6)}</aside><section class="viewer" role="dialog" aria-modal="true"><img id="opened-media"></section><div class="caption"><strong>${label}</strong>Media processing remains local</div>`);
  await mockChrome(page);
  await page.evaluate(({ source, processor, pdfWorker }) => {
    document.querySelector('#opened-media').src = source;
    globalThis.__resourceUrls = {
      '/media-processor.js': URL.createObjectURL(new Blob([processor], { type: 'text/javascript' })),
      '/pdfjs-worker.mjs': URL.createObjectURL(new Blob([pdfWorker], { type: 'text/javascript' })),
    };
  }, { source, processor: readFileSync(join(output, 'media-processor.js'), 'utf8'), pdfWorker: readFileSync(join(output, 'pdfjs-worker.mjs'), 'utf8') });
  await page.locator('#opened-media').evaluate((image) => image.decode());
  await page.addScriptTag({ path: join(output, 'content-scripts/content.js') });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-toolbar'));
  return page;
}

try {
  const media = await createMediaPage();
  await media.screenshot({ path: join(screenshots, '01-whatsapp-media-tools.png') });
  await media.close();

  const options = await context.newPage();
  await options.setContent('<div id="root"></div>');
  await mockChrome(options);
  await options.addStyleTag({ content: readFileSync(join(project, 'src/styles/pages.css'), 'utf8') });
  await options.addScriptTag({ path: tempOptions });
  await options.waitForSelector('.page');
  await options.locator('.brand img').evaluate((img, data) => { img.src = data; }, `data:image/png;base64,${readFileSync(join(project, 'public/icons/icon-48.png')).toString('base64')}`);
  await options.getByRole('button', { name: /^Pipelines$/i }).click();
  await options.getByRole('button', { name: /New pipeline/i }).click();
  await options.screenshot({ path: join(screenshots, '02-pipeline-builder.png') });
  await options.close();

  const merge = await createMediaPage('ID front', svg('ID FRONT', '#247f71', '#243f66'));
  await merge.locator('#media-assist-extension-root').evaluate((host) => [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((button) => button.textContent.includes('Add to merge'))?.click());
  await merge.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-modal'));
  await merge.locator('#media-assist-extension-root').evaluate((host) => host.shadowRoot.querySelector('.ma-modal-head .ma-icon-btn')?.click());
  await merge.evaluate((source) => { document.querySelector('#opened-media').src = source; }, svg('ID BACK', '#7b4f91', '#263a58'));
  await merge.locator('#opened-media').evaluate((image) => image.decode());
  await merge.waitForTimeout(180);
  await merge.locator('#media-assist-extension-root').evaluate((host) => [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((button) => button.textContent.includes('Add to merge'))?.click());
  await merge.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelectorAll('.ma-merge-item').length === 2);
  await merge.locator('#media-assist-extension-root').evaluate((host) => host.shadowRoot?.querySelector('.ma-toast-stack')?.remove());
  await merge.screenshot({ path: join(screenshots, '03-a4-merge-workspace.png') });
  await merge.close();
} finally {
  await context.close();
  await browser.close();
  rmSync(tempOptions, { force: true });
}
console.log('Generated v1.3 store screenshots from the compiled product UI.');
