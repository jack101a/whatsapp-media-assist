import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const project = process.cwd();
const output = join(project, '.output/chrome-mv3');
const tempPopup = join(project, '.tmp-popup-fixture.js');
const tempOptions = join(project, '.tmp-options-fixture.js');

const ignoreCss = {
  name: 'ignore-css',
  setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
  },
};
await build({ entryPoints: [join(project, 'entrypoints/popup/main.tsx')], bundle: true, format: 'iife', platform: 'browser', outfile: tempPopup, plugins: [ignoreCss] });
await build({ entryPoints: [join(project, 'entrypoints/options/main.tsx')], bundle: true, format: 'iife', platform: 'browser', outfile: tempOptions, plugins: [ignoreCss] });

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });

async function installChromeMock(page, initialStore = {}, premium = false) {
  await page.evaluate(({ initialStore, premium }) => {
    if (!globalThis.crypto?.subtle) {
      const cryptoValue = globalThis.crypto ?? {};
      Object.defineProperty(cryptoValue, 'subtle', { configurable: true, value: {
        importKey: async () => ({}),
        verify: async () => true,
      } });
      if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoValue });
    }
    const listeners = new Set();
    const store = structuredClone(initialStore);
    globalThis.chrome = {
      runtime: {
        id: 'media-assist-fixture',
        getURL: (path) => globalThis.__resourceUrls?.[path] || `file:///fixture/${path}`,
        openOptionsPage: async () => { globalThis.__openedOptions = true; },
        sendMessage: async (request) => {
          if (request?.type === 'billing:get-status') return { ok: true, data: { signedIn: premium, email: premium ? 'buyer@example.com' : undefined, premium, deviceId: 'fixture-device-0001' } };
          return { ok: false, error: 'Fixture billing action unavailable' };
        },
      },
      storage: {
        local: {
          get: async (key) => typeof key === 'string' ? { [key]: store[key] } : { ...store },
          set: async (values) => {
            for (const [key, value] of Object.entries(values)) {
              const oldValue = store[key];
              store[key] = value;
              for (const listener of listeners) listener({ [key]: { oldValue, newValue: value } }, 'local');
            }
          },
        },
        onChanged: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
    };
  }, { initialStore, premium });
}

const b64url = (value) => Buffer.from(value).toString('base64url');
const entitlementPayload = {
  licenseId: 'fixture-license', tier: 'premium', issuedAt: Date.now() - 1000, refreshAfter: Date.now() + 86_400_000,
  expiresAt: Date.now() + 3 * 86_400_000, subscriptionExpiresAt: Date.now() + 365 * 86_400_000,
  customer: 'buyer@example.com', userId: 'fixture-user', deviceId: 'fixture-device-0001',
  features: ['pipelines', 'multi_input_pipelines', 'pinned_pipeline_buttons'], nonce: 'fixture-nonce',
};
const entitlementBytes = Buffer.from(JSON.stringify(entitlementPayload));
const fixtureEntitlement = `${b64url(entitlementBytes)}.${Buffer.alloc(64, 1).toString('base64url')}`;
const fixtureProfile = {
  id: 'fixture-pipeline', name: 'Upload1', pinned: true, inputCount: 1, mergeLayout: 'vertical', background: '#ffffff',
  steps: [
    { id: 'resize', type: 'resize', width: 640, fit: 'contain', allowUpscale: false },
    { id: 'format', type: 'format', format: 'jpeg' },
    { id: 'compress', type: 'compress', maxKB: 300 },
    { id: 'filename', type: 'filename', preset: 'profile-datetime', template: '{profile}_{datetime}', removeSpaces: true, removeSpecialCharacters: true },
    { id: 'download', type: 'download', automatic: true },
  ],
  createdAt: Date.now(), updatedAt: Date.now(),
};
const fixtureStore = {
  mediaAssistBilling: { deviceId: 'fixture-device-0001', email: 'buyer@example.com', entitlementToken: fixtureEntitlement },
  mediaAssistSettings: { enabled: true, profiles: [fixtureProfile], showToolbarLabels: true, showRotateControls: true, autoOpenMergeWorkspace: true },
};

const svgData = (label = 'Opened media') => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g"><stop stop-color="#0b8f73"/><stop offset="1" stop-color="#12354b"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="800" cy="440" r="230" fill="#fff" opacity=".12"/><text x="800" y="520" fill="white" font-family="Arial" font-size="86" text-anchor="middle">${label}</text></svg>`)}`;
const testPdf = await PDFDocument.create();
const testPdfPage = testPdf.addPage([595.28, 841.89]);
const testPdfFont = await testPdf.embedFont(StandardFonts.Helvetica);
testPdfPage.drawText('Media Assist PDF fixture • page 1', { x: 72, y: 720, size: 26, font: testPdfFont, color: rgb(0.05, 0.45, 0.35) });
const testPdfPage2 = testPdf.addPage([595.28, 841.89]);
testPdfPage2.drawText('Media Assist PDF fixture • page 2', { x: 72, y: 720, size: 26, font: testPdfFont, color: rgb(0.05, 0.45, 0.35) });
const testPdfBase64 = Buffer.from(await testPdf.save()).toString('base64');

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

try {
  // Popup: only enable/disable and Settings.
  const popup = await context.newPage();
  await popup.setContent('<div id="root"></div>');
  await installChromeMock(popup);
  await popup.addStyleTag({ content: readFileSync(join(project, 'entrypoints/popup/popup.css'), 'utf8') });
  await popup.addScriptTag({ path: tempPopup });
  await popup.waitForSelector('.popup');
  check(await popup.locator('button').count() === 2, 'Popup must contain exactly two buttons');
  check(await popup.locator('.toggle-row').isVisible(), 'Popup enable/disable toggle is missing');
  check(await popup.locator('.settings-button').isVisible(), 'Popup Settings button is missing');
  await popup.locator('.settings-button').click();
  check(await popup.evaluate(() => globalThis.__openedOptions === true), 'Popup Settings did not call openOptionsPage');
  await popup.close();

  // Full-page Options control center.
  const options = await context.newPage();
  await options.setContent('<div id="root"></div>');
  await installChromeMock(options, {}, true);
  await options.addStyleTag({ content: readFileSync(join(project, 'src/styles/pages.css'), 'utf8') });
  await options.addScriptTag({ path: tempOptions });
  await options.waitForSelector('.page');
  const optionMetrics = await options.locator('.page').evaluate((el) => ({ width: el.getBoundingClientRect().width, viewport: innerWidth }));
  check(optionMetrics.width >= optionMetrics.viewport * 0.95, 'Options UI is not full-page width');
  check(await options.locator('aside nav button').count() === 6, 'Options page navigation is incorrect');
  check(!(await options.locator('body').innerText()).includes('Overview'), 'Unnecessary Overview page is present');
  const bodyBackground = await options.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  check(bodyBackground !== 'rgb(0, 0, 0)', 'Options page is not using the light interface');
  await options.getByRole('button', { name: /Merge & PDF/i }).click();
  check(await options.locator('.a4').isVisible(), 'Options page A4 merge preview is missing');
  await options.getByRole('button', { name: /^Pipelines$/i }).click();
  await options.getByRole('button', { name: /New pipeline/i }).click();
  check(await options.getByLabel('Button name').inputValue() === 'Upload1', 'Pipeline builder did not create a named toolbar button');
  check(await options.locator('.step-card').count() >= 6, 'Pipeline builder is missing processing steps');
  const filenameStyle = options.getByLabel('Style');
  check(await filenameStyle.count() === 1, 'Filename preset dropdown is missing');
  await options.getByRole('button', { name: /Save pipeline/i }).click();
  check((await options.locator('.pipeline-list').innerText()).includes('Upload1'), 'Pipeline was not saved to the list');
  await options.close();

  // WhatsApp-like fixture. It starts with only a normal chat image.
  const page = await context.newPage();
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;font-family:Arial;background:#efeae2}
    #chat{height:100%;display:grid;grid-template-columns:320px 1fr}
    aside{background:#fff;border-right:1px solid #ddd}.conversation{padding:30px;overflow:auto}
    .bubble{width:620px;max-width:70%;margin:80px auto;padding:8px;background:#d9fdd3;border-radius:10px}
    .bubble img{display:block;width:560px;height:315px;object-fit:cover}
    .viewer{position:fixed;inset:0;z-index:100;background:rgba(11,20,25,.97);display:flex;align-items:center;justify-content:center}
    .viewer img{width:min(920px,72vw);height:min(575px,68vh);object-fit:contain}
  </style><div id="chat"><aside></aside><main class="conversation"><div class="bubble"><img id="chat-image"></div></main></div>`);
  await installChromeMock(page, fixtureStore, true);
  await page.evaluate(({ mediaProcessor, pdfWorker }) => {
    globalThis.__resourceUrls = {
      '/media-processor.js': URL.createObjectURL(new Blob([mediaProcessor], { type: 'text/javascript' })),
      '/pdfjs-worker.mjs': URL.createObjectURL(new Blob([pdfWorker], { type: 'text/javascript' })),
    };
  }, { mediaProcessor: readFileSync(join(output, 'media-processor.js'), 'utf8'), pdfWorker: readFileSync(join(output, 'pdfjs-worker.mjs'), 'utf8') });
  await page.evaluate((src) => { document.querySelector('#chat-image').src = src; }, svgData('Chat image'));
  await page.locator('#chat-image').evaluate((img) => img.decode());
  await page.addScriptTag({ path: join(output, 'content-scripts/content.js') });
  await page.waitForSelector('#media-assist-extension-root', { state: 'attached' });
  await page.waitForTimeout(250);
  const chatToolbarCount = await page.locator('#media-assist-extension-root').evaluate((host) => host.shadowRoot.querySelectorAll('.ma-toolbar').length);
  check(chatToolbarCount === 0, 'Toolbar appeared on a normal chat image');

  const openViewer = async (label = 'Opened media') => {
    await page.evaluate((src) => {
      document.querySelector('.viewer')?.remove();
      const viewer = document.createElement('section');
      viewer.className = 'viewer';
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      const img = document.createElement('img');
      img.id = 'opened-media';
      img.src = src;
      viewer.append(img);
      document.body.append(viewer);
    }, svgData(label));
    await page.locator('#opened-media').evaluate((img) => img.decode());
    await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-toolbar'));
  };

  await openViewer();
  const labels = await page.locator('#media-assist-extension-root').evaluate((host) => [...host.shadowRoot.querySelectorAll('.ma-tool-btn > span')].map((node) => node.textContent?.trim()));
  for (const expected of ['Crop', 'Resize', 'Compress', 'Add to merge', 'Download']) check(labels.includes(expected), `WhatsApp toolbar label missing: ${expected}`);
  check(await page.locator('#media-assist-extension-root').evaluate((host) => [...host.shadowRoot.querySelectorAll('.ma-profile-btn')].some((button) => button.textContent.includes('Upload1'))), 'Saved pipeline button did not appear in WhatsApp toolbar');

  const pipelineDownloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-profile-btn')].find((node) => node.textContent.includes('Upload1'));
    button?.click();
  });
  const pipelineDownload = await pipelineDownloadPromise;
  check(/^Upload1_\d{14}\.jpg$/i.test(pipelineDownload.suggestedFilename()), 'Pipeline did not run its resize/format/naming/download sequence');

  // Live rotation.
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-rotate-btn')].find((node) => node.textContent.includes('Rotate right'));
    button?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-live-preview'));
  check(await page.locator('#opened-media').evaluate((img) => img.style.opacity === '0'), 'Rotate did not switch to live preview');

  // Applied crop remains in live preview.
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((node) => node.textContent.includes('Crop'));
    button?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-crop-box'));
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-crop-controls button')].find((node) => node.textContent.includes('Apply'));
    button?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-live-preview'));
  check(await page.locator('#media-assist-extension-root').evaluate((host) => !host.shadowRoot.querySelector('.ma-crop-box')), 'Crop editor did not close after Apply');

  // Real local image processing and download after live transforms.
  const imageDownloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((node) => node.textContent.includes('Download'));
    button?.click();
  });
  const imageDownload = await imageDownloadPromise;
  check(/\.(?:jpg|jpeg)$/i.test(imageDownload.suggestedFilename()), 'Processed image download did not use the configured JPEG format');
  const imagePath = await imageDownload.path();
  check(Boolean(imagePath), 'Processed image download did not produce a file');

  // Anti-blink: temporary React-like viewer replacement.
  const blinkSamples = await page.evaluate(async (src) => {
    const host = document.querySelector('#media-assist-extension-root');
    const results = [];
    document.querySelector('.viewer')?.remove();
    for (let elapsed = 0; elapsed < 500; elapsed += 25) {
      results.push(Boolean(host.shadowRoot.querySelector('.ma-toolbar')));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const viewer = document.createElement('section');
    viewer.className = 'viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    const img = document.createElement('img');
    img.id = 'opened-media';
    img.src = src;
    viewer.append(img);
    document.body.append(viewer);
    await img.decode();
    await new Promise((resolve) => setTimeout(resolve, 150));
    results.push(Boolean(host.shadowRoot.querySelector('.ma-toolbar')));
    return results;
  }, svgData('Re-rendered media'));
  check(blinkSamples.every(Boolean), 'Toolbar blinked during transient viewer re-render');

  // A4 merge workspace.
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((node) => node.textContent.includes('Add to merge'));
    button?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-modal'));
  const mergeText = await page.locator('#media-assist-extension-root').evaluate((host) => host.shadowRoot.querySelector('.ma-modal')?.textContent ?? '');
  check(mergeText.includes('A4 merge workspace'), 'A4 merge workspace did not open');
  check(mergeText.includes('Top & bottom') && mergeText.includes('Side by side') && mergeText.includes('Grid'), 'Merge layout choices are incomplete');
  check(await page.locator('#media-assist-extension-root').evaluate((host) => Boolean(host.shadowRoot.querySelector('.ma-a4-page'))), 'A4 live preview is missing');

  // Real A4 merge processing in the lazy worker.
  const mergeDownloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const button = [...host.shadowRoot.querySelectorAll('.ma-modal-actions button')].find((node) => node.textContent.includes('Download A4'));
    button?.click();
  });
  const mergeDownload = await mergeDownloadPromise;
  check(/\.pdf$/i.test(mergeDownload.suggestedFilename()), 'A4 merge did not use the default PDF output');
  const mergePath = await mergeDownload.path();
  check(Boolean(mergePath), 'A4 merge download did not produce a file');

  // PDF capture and rasterisation stay local; grid is unavailable for PDF pages.
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const clear = [...host.shadowRoot.querySelectorAll('.ma-modal-actions button')].find((node) => node.textContent.includes('Clear stack'));
    clear?.click();
    host.shadowRoot.querySelector('.ma-modal-head .ma-icon-btn')?.click();
  });
  await page.evaluate((base64) => {
    document.querySelector('.viewer')?.remove();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const viewer = document.createElement('section');
    viewer.className = 'viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    const object = document.createElement('object');
    object.id = 'opened-pdf';
    object.type = 'application/pdf';
    object.data = url;
    object.style.width = '900px';
    object.style.height = '700px';
    viewer.append(object);
    document.body.append(viewer);
  }, testPdfBase64);
  await page.waitForFunction(() => {
    const host = document.querySelector('#media-assist-extension-root');
    return [...(host?.shadowRoot?.querySelectorAll('.ma-tool-btn') ?? [])].some((node) => node.textContent.includes('Compress PDF'));
  });

  const compressedPdfPromise = page.waitForEvent('download', { timeout: 90000 });
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const compress = [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((node) => node.textContent.includes('Compress PDF'));
    compress?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-quick-panel')?.textContent.includes('Compress PDF'));
  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const action = [...host.shadowRoot.querySelectorAll('.ma-quick-panel button')].find((node) => node.textContent.includes('Compress & download'));
    action?.click();
  });
  const compressedPdf = await compressedPdfPromise;
  const compressedPdfPath = await compressedPdf.path();
  check(Boolean(compressedPdfPath), 'Compressed PDF download did not produce a file');
  if (compressedPdfPath) {
    const parsedPdf = await PDFDocument.load(readFileSync(compressedPdfPath));
    check(parsedPdf.getPageCount() === 2, 'PDF compression did not preserve the original page count');
  }

  await page.locator('#media-assist-extension-root').evaluate((host) => {
    const add = [...host.shadowRoot.querySelectorAll('.ma-tool-btn')].find((node) => node.textContent.includes('Add to merge'));
    add?.click();
  });
  await page.waitForFunction(() => document.querySelector('#media-assist-extension-root')?.shadowRoot?.querySelector('.ma-modal')?.textContent.includes('page 1'), null, { timeout: 60000 });
  check(await page.locator('#media-assist-extension-root').evaluate((host) => {
    const grid = [...host.shadowRoot.querySelectorAll('.ma-layout-tabs button')].find((node) => node.textContent.includes('Grid'));
    return grid?.disabled === true;
  }), 'Grid layout was not disabled for PDF pages');

  // Viewer close removes toolbar after anti-blink grace, not immediately.
  await page.locator('#media-assist-extension-root').evaluate((host) => host.shadowRoot.querySelector('.ma-modal-head .ma-icon-btn')?.click());
  await page.evaluate(() => document.querySelector('.viewer')?.remove());
  await page.waitForTimeout(1950);
  check(!await page.locator('#media-assist-extension-root').evaluate((host) => Boolean(host.shadowRoot.querySelector('.ma-toolbar'))), 'Toolbar remained after the media viewer was closed');
  await page.close();
} finally {
  await context.close();
  await browser.close();
  rmSync(tempPopup, { force: true });
  rmSync(tempOptions, { force: true });
}

if (failures.length) {
  console.error('Browser fixture failures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Browser fixture passed: popup, light full Options, pipeline builder/button execution, media-only detection, live crop/rotate, anti-blink, A4 merge, and multi-page PDF processing.');
