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
  constructor(message = 'The currently loaded media cannot be processed without a new network request.') {
    super(message);
    this.name = 'PrivacySourceError';
  }
}

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
  const requestedWidth = settings?.width && settings.width > 0 ? settings.width : undefined;
  const requestedHeight = settings?.height && settings.height > 0 ? settings.height : undefined;
  if (settings && requestedWidth && requestedHeight) {
    const output = createCanvas(requestedWidth, requestedHeight);
    const context = get2d(output);
    if (settings.fit === 'stretch') {
      context.drawImage(source, 0, 0, requestedWidth, requestedHeight);
      return output;
    }
    const scale = settings.fit === 'cover'
      ? Math.max(requestedWidth / source.width, requestedHeight / source.height)
      : Math.min(requestedWidth / source.width, requestedHeight / source.height);
    const drawWidth = Math.max(1, Math.round(source.width * scale));
    const drawHeight = Math.max(1, Math.round(source.height * scale));
    context.drawImage(source, (requestedWidth - drawWidth) / 2, (requestedHeight - drawHeight) / 2, drawWidth, drawHeight);
    return output;
  }
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
const LOWEST_BROWSER_QUALITY = 0.05;

function dimensionScaleForTarget(currentBytes: number, maxBytes: number): number {
  if (currentBytes <= 0 || maxBytes <= 0) return 0.88;
  return Math.max(0.45, Math.min(0.9, Math.sqrt(maxBytes / currentBytes) * 0.96));
}

async function encodeLossyToRange(
  canvas: HTMLCanvasElement,
  format: ImageFormat,
  minBytes: number | undefined,
  maxBytes: number | undefined,
  preferredQuality: number,
): Promise<{ blob: Blob; quality: number; overMax: boolean }> {
  const mime = mimeFor(format);
  const preferred = Math.max(LOWEST_BROWSER_QUALITY, Math.min(1, preferredQuality || 0.9));

  // Early-exit: check if preferred quality works perfectly
  const preferredBlob = await canvasToBlob(canvas, mime, preferred);
  const fitsMax = !maxBytes || preferredBlob.size <= maxBytes;
  const fitsMin = !minBytes || preferredBlob.size >= minBytes;
  if (fitsMax && fitsMin) {
    return { blob: preferredBlob, quality: preferred, overMax: false };
  }

  let low = LOWEST_BROWSER_QUALITY;
  let high = preferred;
  let bestBlob = await canvasToBlob(canvas, mime, low);
  let bestQuality = low;

  if (maxBytes && bestBlob.size > maxBytes) {
    return { blob: bestBlob, quality: bestQuality, overMax: true };
  }

  // 8 iterations give ~1/256 precision — more than sufficient for file-size targeting.
  for (let index = 0; index < 8; index += 1) {
    const quality = (low + high) / 2;
    const candidate = await canvasToBlob(canvas, mime, quality);
    if (!maxBytes || candidate.size <= maxBytes) {
      bestBlob = candidate;
      bestQuality = quality;
      low = quality;
    } else {
      high = quality;
    }
  }

  if (minBytes && bestBlob.size < minBytes && bestQuality < 1) {
    low = bestQuality;
    high = 1;
    // 6 iterations are sufficient to find the minimum size floor.
    for (let index = 0; index < 6; index += 1) {
      const quality = (low + high) / 2;
      const candidate = await canvasToBlob(canvas, mime, quality);
      if (!maxBytes || candidate.size <= maxBytes) {
        bestBlob = candidate;
        bestQuality = quality;
        low = quality;
      } else {
        high = quality;
      }
    }
  }

  return { blob: bestBlob, quality: bestQuality, overMax: Boolean(maxBytes && bestBlob.size > maxBytes) };
}

async function encodeToLimit(
  initial: HTMLCanvasElement,
  format: ImageFormat,
  compression: CompressionSettings,
): Promise<{ blob: Blob; canvas: HTMLCanvasElement; quality?: number; warnings: string[]; sizeUnreachable?: boolean }> {
  const warnings: string[] = [];
  const maxBytes = compression.maxBytes;
  const minBytes = compression.minBytes;
  let working = initial;

  if (format === 'png') {
    const blob = await canvasToBlob(working, 'image/png');
    let sizeUnreachable = false;
    if (maxBytes && blob.size > maxBytes) {
      warnings.push('PNG could not reach the requested size without further dimension loss.');
      sizeUnreachable = true;
    }
    return { blob, canvas: working, warnings, sizeUnreachable };
  }

  const result = await encodeLossyToRange(working, format, minBytes, maxBytes, compression.preferredQuality);
  if (result.overMax) {
    warnings.push('The requested maximum size could not be reached without changing the chosen dimensions.');
  }

  return {
    blob: result.blob,
    canvas: working,
    quality: result.quality,
    warnings,
    sizeUnreachable: result.overMax,
  };
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
  const warnings: string[] = [];

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
      if (operation.settings.fit === 'cover' && (working.width !== next.width || working.height !== next.height)) {
        const sourceRatio = working.width / working.height;
        const targetWidth = operation.settings.width;
        const targetHeight = operation.settings.height;
        if (targetWidth && targetHeight) {
          const targetRatio = targetWidth / targetHeight;
          if (Math.abs(sourceRatio - targetRatio) > 0.001) {
            warnings.push('Resize “Fill & Crop” mode cropped some parts of the image to fit the aspect ratio.');
          }
        }
      }
    } else if (operation.type === 'sizefit') {
      let attempts = 0;
      let currentCanvas = working;
      const format = operation.format;
      const maxBytes = operation.maxBytes;
      const minBytes = operation.minBytes;

      if (format === 'png') {
        let blob = await canvasToBlob(currentCanvas, 'image/png');
        while (maxBytes && blob.size > maxBytes && attempts < 18) {
          const nextCanvas = scaleCanvas(currentCanvas, dimensionScaleForTarget(blob.size, maxBytes));
          if (currentCanvas !== working) {
            currentCanvas.width = 1;
            currentCanvas.height = 1;
          }
          currentCanvas = nextCanvas;
          blob = await canvasToBlob(currentCanvas, 'image/png');
          attempts += 1;
        }
        next = currentCanvas;
      } else {
        while (attempts < 18) {
          const result = await encodeLossyToRange(currentCanvas, format, minBytes, maxBytes, operation.preferredQuality);
          if (!result.overMax) {
            break;
          }
          const nextCanvas = scaleCanvas(currentCanvas, dimensionScaleForTarget(result.blob.size, maxBytes));
          if (currentCanvas !== working) {
            currentCanvas.width = 1;
            currentCanvas.height = 1;
          }
          currentCanvas = nextCanvas;
          attempts += 1;
        }
        next = currentCanvas;
      }
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
    warnings: [...warnings, ...result.warnings],
    sizeUnreachable: result.sizeUnreachable,
  };
}

export async function processImage(sourceBlob: Blob, transform: ImageTransform): Promise<ProcessedMedia> {
  const operations: CanvasOperation[] = [];
  if (transform.rotation) operations.push({ type: 'rotate', degrees: transform.rotation as 90 | 180 | 270 });
  const hasResize = Boolean(transform.resize?.width || transform.resize?.height || transform.resize?.percentage);
  const addSizeFit = Boolean(transform.compression.maxBytes && !hasResize);

  if (transform.flipX || transform.flipY) {
    let working = await blobToCanvas(sourceBlob);
    const rotated = rotateAndFlipCanvas(working, transform.rotation, transform.flipX, transform.flipY);
    working.width = 1;
    working.height = 1;
    const staged = await canvasToBlob(rotated, 'image/png');
    rotated.width = 1;
    rotated.height = 1;

    const subOps: CanvasOperation[] = [];
    if (transform.crop) subOps.push({ type: 'crop', crop: transform.crop });
    if (transform.resize) subOps.push({ type: 'resize', settings: transform.resize });
    if (addSizeFit) {
      subOps.push({
        type: 'sizefit',
        maxBytes: transform.compression.maxBytes!,
        minBytes: transform.compression.minBytes,
        preferredQuality: transform.compression.preferredQuality,
        minimumQuality: transform.compression.minimumQuality,
        format: transform.format,
      });
    }
    return processCanvasPipeline(staged, subOps, transform);
  }
  if (transform.crop) operations.push({ type: 'crop', crop: transform.crop });
  if (transform.resize) operations.push({ type: 'resize', settings: transform.resize });
  if (addSizeFit) {
    operations.push({
      type: 'sizefit',
      maxBytes: transform.compression.maxBytes!,
      minBytes: transform.compression.minBytes,
      preferredQuality: transform.compression.preferredQuality,
      minimumQuality: transform.compression.minimumQuality,
      format: transform.format,
    });
  }
  return processCanvasPipeline(sourceBlob, operations, transform);
}
