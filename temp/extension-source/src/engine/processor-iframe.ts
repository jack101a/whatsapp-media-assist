import { browser } from 'wxt/browser';

let worker: Worker | null = null;

window.addEventListener('message', (event) => {
  // Only accept messages from WhatsApp Web
  if (event.origin !== 'https://web.whatsapp.com') return;

  if (!worker) {
    worker = new Worker(browser.runtime.getURL('/media-processor.js'));
    worker.onmessage = (msgEvent) => {
      // Forward worker response back to WhatsApp Web
      window.parent.postMessage(msgEvent.data, 'https://web.whatsapp.com');
    };
    worker.onerror = (errEvent) => {
      window.parent.postMessage({ type: 'error', message: errEvent.message || 'Local media processor failed.', id: 'UNKNOWN' }, 'https://web.whatsapp.com');
    };
  }

  // Forward request to the worker
  worker.postMessage(event.data);
});
