import type {
  CanvasOperation,
  CompressionSettings,
  ImageFormat,
  ImageTransform,
  NormalizedCrop,
  ProcessedMedia,
  ResizeSettings,
} from '../types/media';

export class PrivacySourceError extends Error {
  // This happens when the browser blocks cross-origin image data access.
  constructor(message = "This image can't be edited — try opening it fully first, then use the toolbar.") {
    super(message);
    this.name = 'PrivacySourceError';
  }
}

// Safety limits for canvas allocation. These same values are duplicated in
// entrypoints/media-processor.ts (OffscreenCanvas worker) — keep them in sync.
const MAX_PIXELS = 80_000_000;
const MAX_EDGE = 16_384;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeWidth > MAX_EDGE || safeHeight > MAX_EDGE || safeWidth * safeHeight > MAX_PIXELS) {
    throw new Error('This image is too large to process safely in the browser.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  return canvas;
}

export function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
  if (!context) throw new Error('Canvas processing is unavailable in this browser.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return context;
}

export async function captureImageElement(image: HTMLImageElement): Promise<Blob> {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('The opened image has not finished loading.');

  const canvas = createCanvas(width, height);
  try {
    get2d(canvas).drawImage(image, 0, 0, width, height);
    // Accessing pixels forces an immediate security check instead of failing later.
    get2d(canvas).getImageData(0, 0, 1, 1);
  } catch (error) {
    canvas.width = 1;
    canvas.height = 1;
    throw new PrivacySourceError(error instanceof Error ? error.message : undefined);
  }

  const blob = await canvasToBlob(canvas, 'image/png');
  canvas.width = 1;
  canvas.height = 1;
  return blob;
}

export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const canvas = createCanvas(bitmap.width, bitmap.height);
  get2d(canvas).drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export function rotateAndFlipCanvas(
  source: HTMLCanvasElement,
  rotation: 0 | 90 | 180 | 270,
  flipX: boolean,
  flipY: boolean,
): HTMLCanvasElement {
  const swap = rotation === 90 || rotation === 270;
  const output = createCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const context = get2d(output);
  context.translate(output.width / 2, output.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return output;
}

export function cropCanvas(source: HTMLCanvasElement, crop?: NormalizedCrop): HTMLCanvasElement {
  if (!crop) return source;
  const x = Math.max(0, Math.min(1, crop.x));
  const y = Math.max(0, Math.min(1, crop.y));
  const width = Math.max(0.005, Math.min(1 - x, crop.width));
  const height = Math.max(0.005, Math.min(1 - y, crop.height));
  const sourceX = Math.round(x * source.width);
  const sourceY = Math.round(y * source.height);
  const sourceWidth = Math.max(1, Math.round(width * source.width));
  const sourceHeight = Math.max(1, Math.round(height * source.height));
  const output = createCanvas(sourceWidth, sourceHeight);
  get2d(output).drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return output;
}

function calculateResize(sourceWidth: number, sourceHeight: number, settings?: ResizeSettings) {
  if (!settings) return { width: sourceWidth, height: sourceHeight };
  if (settings.percentage && settings.percentage > 0) {
    const factor = settings.percentage / 100;
    const width = Math.round(sourceWidth * factor);
    const height = Math.round(sourceHeight * factor);
    if (!settings.allowUpscale && factor > 1) return { width: sourceWidth, height: sourceHeight };
    return { width, height };
  }

  const requestedWidth = settings.width && settings.width > 0 ? settings.width : undefined;
  const requestedHeight = settings.height && settings.height > 0 ? settings.height : undefined;
  if (!requestedWidth && !requestedHeight) return { width: sourceWidth, height: sourceHeight };

  let width = requestedWidth ?? Math.round(sourceWidth * ((requestedHeight ?? sourceHeight) / sourceHeight));
  let height = requestedHeight ?? Math.round(sourceHeight * (width / sourceWidth));

  if (settings.maintainAspectRatio) {
    const widthScale = requestedWidth ? requestedWidth / sourceWidth : Number.POSITIVE_INFINITY;
    const heightScale = requestedHeight ? requestedHeight / sourceHeight : Number.POSITIVE_INFINITY;
    const scale = settings.fit === 'cover' ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);
    const finiteScale = Number.isFinite(scale) ? scale : (requestedWidth ? widthScale : heightScale);
    width = Math.round(sourceWidth * finiteScale);
    height = Math.round(sourceHeight * finiteScale);
  }

  if (!settings.allowUpscale && (width > sourceWidth || height > sourceHeight)) {
    return { width: sourceWidth, height: sourceHeight };
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

export function resizeCanvas(source: HTMLCanvasElement, settings?: ResizeSettings): HTMLCanvasElement {
  const target = calculateResize(source.width, source.height, settings);
  if (target.width === source.width && target.height === source.height) return source;
  const output = createCanvas(target.width, target.height);
  get2d(output).drawImage(source, 0, 0, target.width, target.height);
  return output;
}

export function scaleCanvas(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const output = createCanvas(width, height);
  get2d(output).drawImage(source, 0, 0, width, height);
  return output;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode this image.')),
      mimeType,
      quality,
    );
  });
}

const mimeFor = (format: ImageFormat): string => `image/${format}`;

async function encodeToLimit(
  initial: HTMLCanvasElement,
  format: ImageFormat,
  compression: CompressionSettings,
): Promise<{ blob: Blob; canvas: HTMLCanvasElement; quality?: number; warnings: string[] }> {
  const warnings: string[] = [];
  const maxBytes = compression.maxBytes;
  const minBytes = compression.minBytes;
  let working = initial;

  if (format === 'png') {
    let blob = await canvasToBlob(working, 'image/png');
    let attempts = 0;
    while (maxBytes && blob.size > maxBytes && compression.allowDimensionReduction && attempts < 10) {
      const next = scaleCanvas(working, 0.88);
      if (working !== initial) { working.width = 1; working.height = 1; }
      working = next;
      blob = await canvasToBlob(working, 'image/png');
      attempts += 1;
    }
    if (maxBytes && blob.size > maxBytes) warnings.push('PNG could not reach the requested size without further dimension loss.');
    if (minBytes && blob.size < minBytes) warnings.push('The output is smaller than the requested minimum; no padding was added.');
    return { blob, canvas: working, warnings };
  }

  const preferred = Math.max(compression.minimumQuality, Math.min(1, compression.preferredQuality));
  let dimensionsAttempt = 0;

  while (true) {
    // ── Fast path: probe at preferred quality first ──────────────────────────
    // For the majority of images this single encode is all we need. Only fall
    // through to the binary search when the preferred encode exceeds maxBytes.
    const probe = await canvasToBlob(working, mimeFor(format), preferred);
    if (!maxBytes || probe.size <= maxBytes) {
      // Already fits at the best quality — done immediately, no binary search.
      if (minBytes && probe.size < minBytes)
        warnings.push('The output is smaller than the requested minimum; quality is already at the preferred maximum.');
      return { blob: probe, canvas: working, quality: preferred, warnings };
    }

    // ── Binary search between minimumQuality and preferred ───────────────────
    // Use the probe size to estimate a smarter starting point so we converge
    // faster (avoid blindly starting at minimumQuality every time).
    let low = compression.minimumQuality;
    let high = preferred;
    // Rough linear estimate: quality ≈ preferred * (maxBytes / probe.size)
    const estimatedQuality = Math.max(low, Math.min(high, preferred * (maxBytes / probe.size)));
    let bestBlob = await canvasToBlob(working, mimeFor(format), low);
    let bestQuality = low;

    if (bestBlob.size <= maxBytes) {
      // Even minimum quality fits — use the estimate as starting lower bound
      // to reduce the number of iterations needed.
      low = Math.min(estimatedQuality, high - 0.01);

      for (let index = 0; index < 7; index += 1) {
        const quality = (low + high) / 2;
        const candidate = await canvasToBlob(working, mimeFor(format), quality);
        if (candidate.size <= maxBytes) {
          bestBlob = candidate;
          bestQuality = quality;
          low = quality;
        } else {
          high = quality;
        }
      }
      return { blob: bestBlob, canvas: working, quality: bestQuality, warnings };
    }

    // Even minimum quality at current dimensions exceeds maxBytes — scale down.
    if (!compression.allowDimensionReduction || dimensionsAttempt >= 10) {
      warnings.push('The requested maximum size could not be reached at the minimum quality.');
      return { blob: bestBlob, canvas: working, quality: bestQuality, warnings };
    }

    const next = scaleCanvas(working, 0.88);
    if (working !== initial) { working.width = 1; working.height = 1; }
    working = next;
    dimensionsAttempt += 1;
  }
}

function cropForAspectRatio(width: number, height: number, targetRatio: number): NormalizedCrop | undefined {
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || width <= 0 || height <= 0) return undefined;
  const sourceRatio = width / height;
  if (Math.abs(sourceRatio - targetRatio) < 0.0001) return undefined;
  if (sourceRatio > targetRatio) {
    const cropWidth = targetRatio / sourceRatio;
    return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
  }
  const cropHeight = sourceRatio / targetRatio;
  return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
}

export async function processCanvasPipeline(
  sourceBlob: Blob,
  operations: CanvasOperation[],
  output: Pick<ImageTransform, 'format' | 'compression' | 'background'>,
): Promise<ProcessedMedia> {
  let working = await blobToCanvas(sourceBlob);

  for (const operation of operations) {
    let next = working;
    if (operation.type === 'rotate') {
      const normalized = ((operation.degrees % 360) + 360) % 360 as 0 | 90 | 180 | 270;
      next = rotateAndFlipCanvas(working, normalized, false, false);
    } else if (operation.type === 'crop') {
      const crop = operation.crop ?? (operation.ratio ? cropForAspectRatio(working.width, working.height, operation.ratio) : undefined);
      next = cropCanvas(working, crop);
    } else if (operation.type === 'resize') {
      next = resizeCanvas(working, operation.settings);
    }

    if (next !== working) {
      working.width = 1;
      working.height = 1;
      working = next;
    }
  }

  if (output.format === 'jpeg') {
    const flattened = createCanvas(working.width, working.height);
    const context = get2d(flattened);
    context.fillStyle = output.background || '#ffffff';
    context.fillRect(0, 0, flattened.width, flattened.height);
    context.drawImage(working, 0, 0);
    working.width = 1;
    working.height = 1;
    working = flattened;
  }

  const result = await encodeToLimit(working, output.format, output.compression);
  const width = result.canvas.width;
  const height = result.canvas.height;
  result.canvas.width = 1;
  result.canvas.height = 1;
  return {
    blob: result.blob,
    width,
    height,
    format: output.format,
    quality: result.quality,
    warnings: result.warnings,
  };
}

export async function processImage(sourceBlob: Blob, transform: ImageTransform): Promise<ProcessedMedia> {
  const operations: CanvasOperation[] = [];
  if (transform.rotation) operations.push({ type: 'rotate', degrees: transform.rotation as 90 | 180 | 270 });
  if (transform.flipX || transform.flipY) {
    // Existing public transform supports flips; keep this path local to avoid expanding pipeline options.
    let working = await blobToCanvas(sourceBlob);
    const rotated = rotateAndFlipCanvas(working, transform.rotation, transform.flipX, transform.flipY);
    working.width = 1;
    working.height = 1;
    const staged = await canvasToBlob(rotated, 'image/png');
    rotated.width = 1;
    rotated.height = 1;
    return processCanvasPipeline(staged, [
      ...(transform.crop ? [{ type: 'crop', crop: transform.crop } as CanvasOperation] : []),
      ...(transform.resize ? [{ type: 'resize', settings: transform.resize } as CanvasOperation] : []),
    ], transform);
  }
  if (transform.crop) operations.push({ type: 'crop', crop: transform.crop });
  if (transform.resize) operations.push({ type: 'resize', settings: transform.resize });
  return processCanvasPipeline(sourceBlob, operations, transform);
}
