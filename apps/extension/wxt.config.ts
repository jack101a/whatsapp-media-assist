import { defineConfig } from 'wxt';

const API_ORIGIN = (process.env.VITE_MEDIA_ASSIST_API_ORIGIN || 'https://mediaassist.002529.xyz').replace(/\/$/, '');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'WhatsApp Media Assist',
    short_name: 'WA Media Assist',
    description: 'Crop, resize, compress and merge opened WhatsApp Web media locally. Pro pipelines automate repeated workflows.',
    version: '0.0.1',
    permissions: ['storage', 'alarms'],
    host_permissions: ['https://web.whatsapp.com/*', `${API_ORIGIN}/*`],
    action: {
      default_title: 'WhatsApp Media Assist',
      default_popup: 'popup.html',
    },
    web_accessible_resources: [{
      resources: ['processor.html', 'media-processor.js', 'pdfjs-worker.mjs'],
      matches: ['https://web.whatsapp.com/*'],
    }],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      96: 'icons/icon-96.png',
      128: 'icons/icon-128.png',
    },
    content_security_policy: {
      extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${API_ORIGIN}; img-src 'self' blob: data:; media-src 'none'; font-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'`,
    },
    browser_specific_settings: browser === 'firefox' ? {
      gecko: {
        id: 'media-assist@002529.xyz',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['personallyIdentifyingInfo', 'authenticationInfo', 'financialAndPaymentInfo'],
        },
      },
    } : undefined,
  }),
});
