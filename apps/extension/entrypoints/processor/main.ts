import { browser } from 'wxt/browser';
import type { MergeItem, MergeOptions } from '../../src/types/media';
import type { ProcessorRequest, ProcessorResponse } from '../../src/types/processor';

const nonce = location.hash.slice(1);
let worker: Worker | null = null;
const active = new Set<string>();
const A4_WIDTH = 2480;
const A4_HEIGHT = 3508;

function send(response: ProcessorResponse): void {
  window.parent.postMessage({ channel: 'media-assist-processor-response', nonce, response }, '*');
}

function createA4Slots(count: number, layout: MergeOptions['layout'], padding: number, gap: number, gridColumns = 2, pageWidth = A4_WIDTH, pageHeight = A4_HEIGHT) {
  const safeCount = Math.max(1, Math.floor(count));
  const safePadding = Math.max(0, Math.min(pageWidth / 3, Number(padding) || 0));
  const safeGap = Math.max(0, Math.min(pageWidth / 3, Number(gap) || 0));
  const innerWidth = Math.max(1, pageWidth - safePadding * 2);
  const innerHeight = Math.max(1, pageHeight - safePadding * 2);
  if (layout === 'horizontal') {
    const width = Math.max(1, (innerWidth - safeGap * Math.max(0, safeCount - 1)) / safeCount);
    return Array.from({ length: safeCount }, (_, index) => ({ x: safePadding + index * (width + safeGap), y: safePadding, width, height: innerHeight }));
  }
  if (layout === 'grid') {
    const columns = Math.max(1, Math.min(6, Math.floor(Number(gridColumns) || 2)));
    const rows = Math.max(1, Math.ceil(safeCount / columns));
    const width = Math.max(1, (innerWidth - safeGap * Math.max(0, columns - 1)) / columns);
    const height = Math.max(1, (innerHeight - safeGap * Math.max(0, rows - 1)) / rows);
    return Array.from({ length: safeCount }, (_, index) => ({ x: safePadding + (index % columns) * (width + safeGap), y: safePadding + Math.floor(index / columns) * (height + safeGap), width, height }));
  }
  const height = Math.max(1, (innerHeight - safeGap * Math.max(0, safeCount - 1)) / safeCount);
  return Array.from({ length: safeCount }, (_, index) => ({ x: safePadding, y: safePadding + index * (height + safeGap), width: innerWidth, height }));
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  if (canvas.width > 16384 || canvas.height > 16384 || canvas.width * canvas.height > 80_000_000) throw new Error('The combined media is too large to process safely.');
  return canvas;
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas processing is unavailable.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return context;
}

async function bitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

async function prepareItem(item: MergeItem): Promise<HTMLCanvasElement> {
  const bitmap = await bitmapFromBlob(item.blob);
  const swap = item.rotation === 90 || item.rotation === 270;
  const rotated = makeCanvas(swap ? bitmap.height : bitmap.width, swap ? bitmap.width : bitmap.height);
  const context = get2d(rotated);
  context.translate(rotated.width / 2, rotated.height / 2);
  context.rotate((item.rotation * Math.PI) / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  if (!item.crop) return rotated;
  const crop = item.crop;
  const sx = Math.max(0, Math.round(crop.x * rotated.width));
  const sy = Math.max(0, Math.round(crop.y * rotated.height));
  const sw = Math.max(1, Math.min(rotated.width - sx, Math.round(crop.width * rotated.width)));
  const sh = Math.max(1, Math.min(rotated.height - sy, Math.round(crop.height * rotated.height)));
  const cropped = makeCanvas(sw, sh);
  get2d(cropped).drawImage(rotated, sx, sy, sw, sh, 0, 0, sw, sh);
  rotated.width = 1;
  rotated.height = 1;
  return cropped;
}

function drawPlaced(context: CanvasRenderingContext2D, source: HTMLCanvasElement, slot: ReturnType<typeof createA4Slots>[number], item: MergeItem, options: MergeOptions): void {
  const border = Math.max(0, Number(options.borderWidth) || 0);
  if (border > 0) {
    context.strokeStyle = options.borderColor || '#d6d9dc';
    context.lineWidth = border;
    context.strokeRect(slot.x + border / 2, slot.y + border / 2, Math.max(1, slot.width - border), Math.max(1, slot.height - border));
  }
  const inset = border + Math.max(8, (Number(options.gap) || 0) * 0.08);
  const boxX = slot.x + inset;
  const boxY = slot.y + inset;
  const boxWidth = Math.max(1, slot.width - inset * 2);
  const boxHeight = Math.max(1, slot.height - inset * 2);
  const placement = item.placement ?? { offsetX: 0, offsetY: 0, scale: 1 };
  const baseScale = Math.min(boxWidth / source.width, boxHeight / source.height);
  const scale = baseScale * Math.max(0.6, Math.min(1.6, Number(placement.scale) || 1));
  const width = source.width * scale;
  const height = source.height * scale;
  const x = boxX + (boxWidth - width) / 2 + Math.max(-0.5, Math.min(0.5, Number(placement.offsetX) || 0)) * boxWidth * 0.55;
  const y = boxY + (boxHeight - height) / 2 + Math.max(-0.5, Math.min(0.5, Number(placement.offsetY) || 0)) * boxHeight * 0.55;
  context.save();
  context.beginPath();
  context.rect(slot.x, slot.y, slot.width, slot.height);
  context.clip();
  context.drawImage(source, x, y, width, height);
  context.restore();
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode this image.')), type, quality);
  });
}

function exportScale(options: MergeOptions): number {
  if (!options.maxBytes || options.format === 'png') return 1;
  const targetKB = options.maxBytes / 1024;
  if (targetKB <= 650) return 0.5;
  if (targetKB <= 1000) return 0.6;
  if (targetKB <= 1800) return 0.72;
  if (targetKB <= 3000) return 0.84;
  return 1;
}

async function encodeImage(canvas: HTMLCanvasElement, options: MergeOptions, id: string): Promise<Blob> {
  const format = options.format === 'pdf' ? 'jpeg' : options.format;
  const type = `image/${format}`;
  if (!options.maxBytes || format === 'png') return canvasToBlob(canvas, type, options.quality);

  send({ id, type: 'progress', current: 1, total: 4, note: 'Encoding A4 image' });
  const preferred = Math.max(0.34, Math.min(0.96, Number(options.quality) || 0.92));
  const first = await canvasToBlob(canvas, type, preferred);
  if (first.size <= options.maxBytes) return first;

  send({ id, type: 'progress', current: 2, total: 4, note: 'Compressing A4 image' });
  let low = 0.34;
  let high = preferred;
  let best = await canvasToBlob(canvas, type, low);
  if (best.size > options.maxBytes) return best;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    send({ id, type: 'progress', current: 3, total: 4, note: `Optimising A4 image ${attempt + 1}/4` });
    const quality = (low + high) / 2;
    const candidate = await canvasToBlob(canvas, type, quality);
    if (candidate.size <= options.maxBytes) {
      best = candidate;
      low = quality;
    } else {
      high = quality;
    }
  }
  return best;
}

async function mergeImagesInFrame(request: Extract<ProcessorRequest, { type: 'merge' }>): Promise<Blob> {
  const { items, options, id } = request;
  if (!items.length) throw new Error('Add at least one item to merge.');
  if (options.layout === 'grid' && items.some((item) => item.sourceType === 'pdf-page')) throw new Error('Grid layout is available only for images. Use Top & bottom or Side by side for PDF pages.');
  const prepared: HTMLCanvasElement[] = [];
  for (let index = 0; index < items.length; index += 1) {
    prepared.push(await prepareItem(items[index]!));
    send({ id, type: 'progress', current: index + 1, total: items.length, note: `Preparing item ${index + 1}/${items.length}` });
  }
  const scale = exportScale(options);
  const output = makeCanvas(A4_WIDTH * scale, A4_HEIGHT * scale);
  const context = get2d(output);
  context.fillStyle = options.background || '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  const scaledOptions = {
    ...options,
    gap: options.gap * scale,
    padding: options.padding * scale,
    borderWidth: options.borderWidth * scale,
  };
  const slots = createA4Slots(prepared.length, options.layout, scaledOptions.padding, scaledOptions.gap, options.gridColumns, output.width, output.height);
  prepared.forEach((source, index) => drawPlaced(context, source, slots[index]!, items[index]!, scaledOptions));
  prepared.forEach((source) => { source.width = 1; source.height = 1; });
  try {
    return await encodeImage(output, options, id);
  } finally {
    output.width = 1;
    output.height = 1;
  }
}

function canMergeInFrame(request: ProcessorRequest): request is Extract<ProcessorRequest, { type: 'merge' }> {
  return request.type === 'merge' && request.options?.format !== 'pdf';
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(browser.runtime.getURL('/media-processor.js' as never));
  worker.onmessage = (event: MessageEvent<ProcessorResponse>) => {
    const response = event.data;
    if (response.type !== 'progress') active.delete(response.id);
    send(response);
  };
  worker.onmessageerror = () => {
    for (const id of active) send({ id, type: 'error', message: 'The local processor returned unreadable data.' });
    active.clear();
    worker?.terminate();
    worker = null;
  };
  worker.onerror = (event) => {
    for (const id of active) send({ id, type: 'error', message: event.message || 'The local processor could not start.' });
    active.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data as { channel?: string; nonce?: string; request?: ProcessorRequest };
  if (message.channel !== 'media-assist-processor-request' || message.nonce !== nonce || !message.request) return;
  if (canMergeInFrame(message.request)) {
    void mergeImagesInFrame(message.request)
      .then((result) => send({ id: message.request!.id, type: 'success', result }))
      .catch((error) => send({ id: message.request!.id, type: 'error', message: error instanceof Error ? error.message : 'Local processing failed.' }));
    return;
  }
  active.add(message.request.id);
  ensureWorker().postMessage(message.request);
});

window.parent.postMessage({ channel: 'media-assist-processor-ready', nonce }, '*');
