import { browser } from 'wxt/browser';
import type { MergeItem } from '../types/media';
import type { MergeOptions } from '../types/media';
import type { ProcessorRequest, ProcessorRequestInput, ProcessorResponse } from '../types/processor';
import { createId } from '../utils/id';

let iframePromise: Promise<HTMLIFrameElement> | null = null;
let iframeElement: HTMLIFrameElement | null = null;
const pending = new Map<string, { resolve: (value: Blob | MergeItem[]) => void; reject: (error: Error) => void; onProgress?: (current: number, total: number, note: string) => void }>();
let idleTimer: number | null = null;

// Initialize the message listener once
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    // We only accept messages from our extension origin
    if (event.origin !== new URL(browser.runtime.getURL('/')).origin) return;
    
    const message = event.data as ProcessorResponse;
    if (!message || !message.id) return;
    
    const request = pending.get(message.id);
    if (!request) return;
    
    if (message.type === 'progress') {
      request.onProgress?.(message.current, message.total, message.note);
      return;
    }
    
    pending.delete(message.id);
    if (message.type === 'success') request.resolve(message.result);
    else request.reject(new Error(message.message));
    scheduleIdleShutdown();
  });
}

function shutdownWorker() {
  if (iframeElement) {
    iframeElement.remove();
    iframeElement = null;
    iframePromise = null;
  }
}

async function getIframeWorker(): Promise<Window> {
  if (iframePromise) {
    const iframe = await iframePromise;
    if (iframe.contentWindow) return iframe.contentWindow;
  }
  
  iframePromise = new Promise((resolve, reject) => {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = browser.runtime.getURL('/processor-iframe.html');
      
      iframe.onload = () => {
        iframeElement = iframe;
        resolve(iframe);
      };
      
      iframe.onerror = () => {
        iframePromise = null;
        reject(new Error('Failed to initialize local media processor iframe.'));
      };
      
      document.body.appendChild(iframe);
    } catch (error) {
      iframePromise = null;
      reject(error);
    }
  });
  
  const iframe = await iframePromise;
  return iframe.contentWindow!;
}

function scheduleIdleShutdown() {
  if (idleTimer) window.clearTimeout(idleTimer);
  // 60 s idle grace period. This prevents repeated Worker constructor/terminate
  // cycles when a user adds multiple items to the merge stack one by one.
  idleTimer = window.setTimeout(() => {
    if (pending.size === 0) {
      shutdownWorker();
    }
  }, 60_000);
}


/**
 * Resets the idle-shutdown timer without starting any processing work.
 * Call this while the merge workspace is open so the worker stays warm
 * and avoids being recreated for every image the user adds.
 */
export function keepWorkerAlive(): void {
  if (iframePromise) scheduleIdleShutdown();
}

function requestProcessor(request: ProcessorRequestInput, onProgress?: (current: number, total: number, note: string) => void): Promise<Blob | MergeItem[]> {
  const id = createId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getIframeWorker().then((win) => {
      win.postMessage({ ...request, id }, browser.runtime.getURL('/'));
    }).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
}

export async function rasterizePdfForMerge(blob: Blob, name: string, sourceKey: string, onProgress?: (current: number, total: number, note: string) => void): Promise<MergeItem[]> {
  const pdfWorkerUrl = browser.runtime.getURL('/pdfjs-worker.mjs' as never);
  const result = await requestProcessor({ type: 'raster-pdf', blob, name, sourceKey, pdfWorkerUrl }, onProgress);
  if (!Array.isArray(result)) throw new Error('The PDF processor returned an invalid result.');
  return result;
}

export async function compressPdfLocally(blob: Blob, maxBytes: number | undefined, preferredQuality: number, onProgress?: (current: number, total: number, note: string) => void): Promise<Blob> {
  const pdfWorkerUrl = browser.runtime.getURL('/pdfjs-worker.mjs' as never);
  const result = await requestProcessor({ type: 'compress-pdf', blob, maxBytes, preferredQuality, pdfWorkerUrl }, onProgress);
  if (Array.isArray(result)) throw new Error('The PDF compressor returned an invalid result.');
  return result;
}

export async function mergeMedia(items: MergeItem[], options: MergeOptions, onProgress?: (current: number, total: number, note: string) => void): Promise<Blob> {
  const result = await requestProcessor({ type: 'merge', items, options }, onProgress);
  if (Array.isArray(result)) throw new Error('The merge processor returned an invalid result.');
  return result;
}

export function terminateProcessor(): void {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = null;
  shutdownWorker();
  for (const request of pending.values()) request.reject(new Error('Media processing was cancelled.'));
  pending.clear();
}

