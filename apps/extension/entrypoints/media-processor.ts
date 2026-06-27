import { PDFDocument, rgb } from 'pdf-lib';
import type { MergeItem, MergeOptions } from '../src/types/media';
import type { ProcessorRequest, ProcessorResponse } from '../src/types/processor';
import { createId } from '../src/utils/id';
import { A4_HEIGHT, A4_WIDTH, createA4Slots, type A4Slot as Slot } from '../src/engine/a4-layout';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ProcessorRequest>) => void) | null;
  postMessage: (message: ProcessorResponse) => void;
};

type Rotation = 0 | 90 | 180 | 270;

let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function post(message: ProcessorResponse) {
  scope.postMessage(message);
}

async function bitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

function canvas(width: number, height: number): OffscreenCanvas {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeWidth > 16384 || safeHeight > 16384 || safeWidth * safeHeight > 80_000_000) throw new Error('The combined media is too large to process safely.');
  return new OffscreenCanvas(safeWidth, safeHeight);
}

function context2d(target: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = target.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas processing is unavailable.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return context;
}

async function prepareItem(item: MergeItem): Promise<OffscreenCanvas> {
  const bitmap = await bitmapFromBlob(item.blob);
  const swap = item.rotation === 90 || item.rotation === 270;
  const rotated = canvas(swap ? bitmap.height : bitmap.width, swap ? bitmap.width : bitmap.height);
  const rotatedContext = context2d(rotated);
  rotatedContext.translate(rotated.width / 2, rotated.height / 2);
  rotatedContext.rotate((item.rotation * Math.PI) / 180);
  rotatedContext.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();

  if (!item.crop) return rotated;
  const crop = item.crop;
  const sx = Math.max(0, Math.round(crop.x * rotated.width));
  const sy = Math.max(0, Math.round(crop.y * rotated.height));
  const sw = Math.max(1, Math.min(rotated.width - sx, Math.round(crop.width * rotated.width)));
  const sh = Math.max(1, Math.min(rotated.height - sy, Math.round(crop.height * rotated.height)));
  const cropped = canvas(sw, sh);
  context2d(cropped).drawImage(rotated, sx, sy, sw, sh, 0, 0, sw, sh);
  rotated.width = 1;
  rotated.height = 1;
  return cropped;
}

function drawPlaced(context: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, slot: Slot, item: MergeItem, options: MergeOptions) {
  const border = Math.max(0, options.borderWidth || 0);
  if (border > 0) {
    context.strokeStyle = options.borderColor || '#d6d9dc';
    context.lineWidth = border;
    context.strokeRect(slot.x + border / 2, slot.y + border / 2, Math.max(1, slot.width - border), Math.max(1, slot.height - border));
  }
  const inset = border + Math.max(8, options.gap * 0.08);
  const boxX = slot.x + inset;
  const boxY = slot.y + inset;
  const boxWidth = Math.max(1, slot.width - inset * 2);
  const boxHeight = Math.max(1, slot.height - inset * 2);
  const placement = item.placement ?? { offsetX: 0, offsetY: 0, scale: 1 };
  const baseScale = Math.min(boxWidth / source.width, boxHeight / source.height);
  const scale = baseScale * Math.max(0.6, Math.min(1.6, placement.scale || 1));
  const width = source.width * scale;
  const height = source.height * scale;
  const x = boxX + (boxWidth - width) / 2 + Math.max(-0.5, Math.min(0.5, placement.offsetX || 0)) * boxWidth * 0.55;
  const y = boxY + (boxHeight - height) / 2 + Math.max(-0.5, Math.min(0.5, placement.offsetY || 0)) * boxHeight * 0.55;
  context.save();
  context.beginPath();
  context.rect(slot.x, slot.y, slot.width, slot.height);
  context.clip();
  context.drawImage(source, x, y, width, height);
  context.restore();
}

async function mergeToCanvas(items: MergeItem[], options: MergeOptions, id: string): Promise<OffscreenCanvas> {
  if (!items.length) throw new Error('Add at least one item to merge.');
  if (options.layout === 'grid' && items.some((item) => item.sourceType === 'pdf-page')) {
    throw new Error('Grid layout is available only for images. Use Top & bottom or Side by side for PDF pages.');
  }
  const prepared: OffscreenCanvas[] = [];
  for (let index = 0; index < items.length; index += 1) {
    prepared.push(await prepareItem(items[index]!));
    post({ id, type: 'progress', current: index + 1, total: items.length, note: `Preparing item ${index + 1}/${items.length}` });
  }
  const output = canvas(A4_WIDTH, A4_HEIGHT);
  const context = context2d(output);
  context.fillStyle = options.background || '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  const slots = createA4Slots(prepared.length, options.layout, options.padding, options.gap, options.gridColumns);
  prepared.forEach((source, index) => drawPlaced(context, source, slots[index]!, items[index]!, options));
  prepared.forEach((item) => { item.width = 1; item.height = 1; });
  return output;
}

function parseHex(value: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value);
  if (!match) return { r: 1, g: 1, b: 1 };
  return { r: Number.parseInt(match[1]!, 16) / 255, g: Number.parseInt(match[2]!, 16) / 255, b: Number.parseInt(match[3]!, 16) / 255 };
}

async function pdfFromCanvas(output: OffscreenCanvas, quality: number, backgroundHex: string): Promise<Blob> {
  const imageBlob = await output.convertToBlob({ type: 'image/jpeg', quality });
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(await imageBlob.arrayBuffer());
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const page = pdf.addPage([pageWidth, pageHeight]);
  const background = parseHex(backgroundHex);
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(background.r, background.g, background.b) });
  page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  const bytes = await pdf.save({ useObjectStreams: true });
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' });
}

async function merge(items: MergeItem[], options: MergeOptions, id: string): Promise<Blob> {
  const output = await mergeToCanvas(items, options, id);
  try {
    if (options.format === 'pdf') {
      let result = await pdfFromCanvas(output, options.quality, options.background);
      for (const quality of [0.82, 0.7, 0.58, 0.46, 0.36]) {
        if (!options.maxBytes || result.size <= options.maxBytes) break;
        result = await pdfFromCanvas(output, quality, options.background);
      }
      return result;
    }
    if (!options.maxBytes || options.format === 'png') return output.convertToBlob({ type: `image/${options.format}`, quality: options.quality });
    let low = 0.34;
    let high = Math.max(low, options.quality);
    let best = await output.convertToBlob({ type: `image/${options.format}`, quality: low });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const quality = (low + high) / 2;
      const candidate = await output.convertToBlob({ type: `image/${options.format}`, quality });
      if (candidate.size <= options.maxBytes) { best = candidate; low = quality; } else high = quality;
    }
    return best;
  } finally {
    output.width = 1;
    output.height = 1;
  }
}


interface RasterPdfPage {
  blob: Blob;
  pageWidth: number;
  pageHeight: number;
}

async function openPdf(blob: Blob, pdfWorkerUrl: string) {
  const pdfjs = await loadPdfjs();
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, useWasm: false }).promise;
}

async function rasterPagesForCompression(blob: Blob, pdfWorkerUrl: string, id: string): Promise<RasterPdfPage[]> {
  const pdf = await openPdf(blob, pdfWorkerUrl);
  if (pdf.numPages > 60) { await pdf.destroy(); throw new Error('PDF compression supports up to 60 pages per file.'); }
  const pages: RasterPdfPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.75, Math.min(1.8, 1800 / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const output = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const outputContext = context2d(output);
      outputContext.fillStyle = '#ffffff';
      outputContext.fillRect(0, 0, output.width, output.height);
      await page.render({ canvas: output as never, canvasContext: outputContext as never, viewport }).promise;
      const pageBlob = await output.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
      output.width = 1;
      output.height = 1;
      page.cleanup();
      pages.push({ blob: pageBlob, pageWidth: base.width, pageHeight: base.height });
      post({ id, type: 'progress', current: pageNumber, total: pdf.numPages, note: `Preparing PDF page ${pageNumber}/${pdf.numPages}` });
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}

async function reencodePdfPages(sourcePages: RasterPdfPage[], quality: number, scale: number): Promise<RasterPdfPage[]> {
  const output: RasterPdfPage[] = [];
  for (const page of sourcePages) {
    const bitmap = await bitmapFromBlob(page.blob);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const target = canvas(width, height);
    const targetContext = context2d(target);
    targetContext.fillStyle = '#ffffff';
    targetContext.fillRect(0, 0, width, height);
    targetContext.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await target.convertToBlob({ type: 'image/jpeg', quality });
    target.width = 1;
    target.height = 1;
    output.push({ blob, pageWidth: page.pageWidth, pageHeight: page.pageHeight });
  }
  return output;
}

async function buildPdfFromRasterPages(pages: RasterPdfPage[]): Promise<Blob> {
  const pdf = await PDFDocument.create();
  for (const raster of pages) {
    const image = await pdf.embedJpg(await raster.blob.arrayBuffer());
    const page = pdf.addPage([Math.max(1, raster.pageWidth), Math.max(1, raster.pageHeight)]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' });
}

async function compressPdfDocument(blob: Blob, maxBytes: number | undefined, preferredQuality: number, pdfWorkerUrl: string, id: string): Promise<Blob> {
  const sourcePages = await rasterPagesForCompression(blob, pdfWorkerUrl, id);
  const preferred = Math.max(0.35, Math.min(0.95, preferredQuality || 0.88));
  const attempts = [
    { quality: preferred, scale: 1 },
    { quality: Math.min(preferred, 0.78), scale: 1 },
    { quality: Math.min(preferred, 0.64), scale: 1 },
    { quality: Math.min(preferred, 0.5), scale: 1 },
    { quality: Math.min(preferred, 0.42), scale: 0.86 },
    { quality: Math.min(preferred, 0.36), scale: 0.72 },
    { quality: Math.min(preferred, 0.3), scale: 0.6 },
  ];
  let best: Blob | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const pages = await reencodePdfPages(sourcePages, attempt.quality, attempt.scale);
    const candidate = await buildPdfFromRasterPages(pages);
    if (!best || candidate.size < best.size) best = candidate;
    post({ id, type: 'progress', current: index + 1, total: attempts.length, note: `Compressing PDF • pass ${index + 1}/${attempts.length}` });
    if (!maxBytes || candidate.size <= maxBytes) return candidate;
  }
  if (!best) throw new Error('The PDF could not be compressed.');
  return best;
}

async function rasterPdf(blob: Blob, name: string, sourceKey: string, pdfWorkerUrl: string, id: string): Promise<MergeItem[]> {
  const pdf = await openPdf(blob, pdfWorkerUrl);
  if (pdf.numPages > 60) { await pdf.destroy(); throw new Error('PDF merge supports up to 60 pages per file.'); }
  const items: MergeItem[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.8, Math.min(1.6, 1800 / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const output = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = context2d(output);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, output.width, output.height);
      await page.render({ canvas: output as never, canvasContext: context as never, viewport }).promise;
      const pageBlob = await output.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      output.width = 1;
      output.height = 1;
      page.cleanup();
      items.push({ id: createId(), blob: pageBlob, name: `${name} • page ${pageNumber}`, rotation: 0, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceKey: `${sourceKey}:page:${pageNumber}`, sourceType: 'pdf-page', pageNumber });
      post({ id, type: 'progress', current: pageNumber, total: pdf.numPages, note: `Reading PDF page ${pageNumber}/${pdf.numPages}` });
    }
  } finally {
    await pdf.destroy();
  }
  return items;
}

export default defineUnlistedScript(() => {
  scope.onmessage = (event) => {
    const request = event.data;
    void (async () => {
      try {
        if (request.type === 'raster-pdf') {
          const result = await rasterPdf(request.blob, request.name, request.sourceKey, request.pdfWorkerUrl, request.id);
          post({ id: request.id, type: 'success', result });
        } else if (request.type === 'compress-pdf') {
          const result = await compressPdfDocument(request.blob, request.maxBytes, request.preferredQuality, request.pdfWorkerUrl, request.id);
          post({ id: request.id, type: 'success', result });
        } else {
          const result = await merge(request.items, request.options, request.id);
          post({ id: request.id, type: 'success', result });
        }
      } catch (error) {
        post({ id: request.id, type: 'error', message: error instanceof Error ? error.message : 'Local processing failed.' });
      }
    })();
  };
});
