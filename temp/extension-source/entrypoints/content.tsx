import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContentApp } from '../src/components/ContentApp';
import { CONTENT_STYLES } from '../src/styles/content.css';

export default defineContentScript({
  matches: ['https://web.whatsapp.com/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'manual',
  main(ctx) {
    const host = document.createElement('div');
    host.id = 'media-assist-extension-root';
    host.dataset.mediaAssist = 'local-only';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CONTENT_STYLES;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    document.documentElement.append(host);
    const root = createRoot(mount);
    root.render(<ContentApp />);
    ctx.onInvalidated(() => {
      root.unmount();
      host.remove();
    });
  },
});
