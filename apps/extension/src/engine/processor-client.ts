import { browser } from 'wxt/browser';
import type { MergeItem, MergeOptions } from '../types/media';
import type { ProcessorRequest, ProcessorRequestInput, ProcessorResponse } from '../types/processor';
import { createId } from '../utils/id';

interface PendingRequest {
  resolve: (value: Blob | MergeItem[]) => void;
  reject: (error: Error) => void;
  onProgress?: (current: number, total: number, note: string) => void;
  timeout: number;
}

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<void> | null = null;
let frameReadyResolve: (() => void) | null = null;
let frameNonce = '';
const pending = new Map<string, PendingRequest>();
let idleTimer: number | null = null;

function extensionOrigin(): string {
  return new URL(browser.runtime.getURL('/')).origin;
}

function processorTargetOrigin(): string {
  const origin = extensionOrigin();
  // Opaque origins occur only in local browser fixtures. The random nonce plus
  // exact iframe window check still prevents messages from other frames.
  return origin === 'null' ? '*' : origin;
}

function onWindowMessage(event: MessageEvent): void {
  if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
  const expectedOrigin = extensionOrigin();
  if (expectedOrigin !== 'null' && event.origin !== expectedOrigin) return;
  const message = event.data as { channel?: string; nonce?: string; response?: ProcessorResponse };
  if (message.nonce !== frameNonce) return;
  if (message.channel === 'media-assist-processor-ready') {
    frameReadyResolve?.();
    frameReadyResolve = null;
    return;
  }
  if (message.channel !== 'media-assist-processor-response' || !message.response) return;
  const response = message.response;
  const request = pending.get(response.id);
  if (!request) return;
  if (response.type === 'progress') {
    request.onProgress?.(response.current, response.total, response.note);
    return;
  }
  pending.delete(response.id);
  window.clearTimeout(request.timeout);
  if (response.type === 'success') request.resolve(response.result);
  else request.reject(new Error(response.message));
  scheduleIdleShutdown();
}

function ensureFrame(): Promise<void> {
  if (frame && frameReady) return frameReady;
  frameNonce = createId();
  frame = document.createElement('iframe');
  frame.src = `${browser.runtime.getURL('/processor.html' as never)}#${encodeURIComponent(frameNonce)}`;
  frame.title = 'Media Assist local processor';
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    left: '-10000px',
    top: '-10000px',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      frameReadyResolve = null;
      reject(new Error('The local processor did not start.'));
    }, 8000);
    frameReadyResolve = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });
  frameReady = ready.catch((error) => {
    terminateProcessor();
    throw error;
  });
  window.addEventListener('message', onWindowMessage);
  document.documentElement.append(frame);
  return frameReady;
}

function scheduleIdleShutdown(): void {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (pending.size === 0) terminateProcessor();
  }, 3000);
}

async function requestProcessor(request: ProcessorRequestInput, onProgress?: (current: number, total: number, note: string) => void): Promise<Blob | MergeItem[]> {
  const id = createId();
  const ready = ensureFrame();
  await ready;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      request.reject(new Error('Media processing timed out. Try fewer or smaller files.'));
      scheduleIdleShutdown();
    }, 120_000);
    pending.set(id, { resolve, reject, onProgress, timeout });
    const payload = { ...request, id } as ProcessorRequest;
    frame?.contentWindow?.postMessage({ channel: 'media-assist-processor-request', nonce: frameNonce, request: payload }, processorTargetOrigin());
  });
}

export async function rasterizePdfForMerge(blob: Blob, name: string, sourceKey: string, onProgress?: (current: number, total: number, note: string) => void): Promise<MergeItem[]> {
  const result = await requestProcessor({ type: 'raster-pdf', blob, name, sourceKey, pdfWorkerUrl: browser.runtime.getURL('/pdfjs-worker.mjs' as never) }, onProgress);
  if (!Array.isArray(result)) throw new Error('The PDF processor returned an invalid result.');
  return result;
}

export async function compressPdfLocally(blob: Blob, maxBytes: number | undefined, preferredQuality: number, onProgress?: (current: number, total: number, note: string) => void): Promise<Blob> {
  const result = await requestProcessor({ type: 'compress-pdf', blob, maxBytes, preferredQuality, pdfWorkerUrl: browser.runtime.getURL('/pdfjs-worker.mjs' as never) }, onProgress);
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
  frame?.remove();
  frame = null;
  frameReady = null;
  frameReadyResolve = null;
  window.removeEventListener('message', onWindowMessage);
  for (const request of pending.values()) {
    window.clearTimeout(request.timeout);
    request.reject(new Error('Media processing was cancelled.'));
  }
  pending.clear();
}
