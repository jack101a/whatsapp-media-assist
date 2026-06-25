export type ActiveMedia = ActiveImageMedia | ActivePdfMedia;

export interface ActiveImageMedia {
  kind: 'image';
  element: HTMLImageElement;
  rect: DOMRect;
  viewer: HTMLElement;
  key: string;
}

export interface ActivePdfMedia {
  kind: 'pdf';
  element: HTMLElement;
  rect: DOMRect;
  viewer: HTMLElement;
  source?: string;
  key: string;
}

function visible(element: HTMLElement, rect = element.getBoundingClientRect()): boolean {
  if (!element.isConnected) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number.parseFloat(style.opacity || '1') > 0.03
    && rect.width > 2
    && rect.height > 2
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < innerHeight
    && rect.left < innerWidth;
}

/**
 * Lightweight rect-only visibility check — no getComputedStyle.
 * Used in the fast-path where the parent viewer is already known-visible,
 * so checking computed styles of each child is redundant.
 */
function visibleByRect(rect: DOMRect): boolean {
  return rect.width > 2 && rect.height > 2
    && rect.bottom > 0 && rect.right > 0
    && rect.top < innerHeight && rect.left < innerWidth;
}

function coversViewerArea(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (!visible(element, rect)) return false;
  const viewportArea = Math.max(1, innerWidth * innerHeight);
  const coverage = (rect.width * rect.height) / viewportArea;
  if (coverage < 0.66 || rect.width < innerWidth * 0.76 || rect.height < innerHeight * 0.74) return false;

  if (element.getAttribute('role') === 'dialog' || element.getAttribute('aria-modal') === 'true') return true;
  const style = getComputedStyle(element);
  const zIndex = Number.parseInt(style.zIndex || '0', 10);
  return (style.position === 'fixed' || style.position === 'absolute') && (!Number.isFinite(zIndex) || zIndex >= 10 || coverage > 0.88);
}

function findViewer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < 18; depth += 1, current = current.parentElement) {
    if (current === document.body || current === document.documentElement) continue;
    if (coversViewerArea(current)) return current;
  }
  return null;
}

function imageKey(image: HTMLImageElement): string {
  const source = image.currentSrc || image.src || 'loaded-image';
  return `image:${source}:${image.naturalWidth}x${image.naturalHeight}`;
}

function pdfSource(element: Element): string | undefined {
  if (element instanceof HTMLObjectElement) return element.data || undefined;
  if (element instanceof HTMLEmbedElement) return element.src || undefined;
  if (element instanceof HTMLIFrameElement) return element.src || undefined;
  return element.getAttribute('src') || element.getAttribute('data') || undefined;
}

function isPdfElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const type = (element.getAttribute('type') || '').toLowerCase();
  const source = (pdfSource(element) || '').toLowerCase();
  return type.includes('pdf') || source.endsWith('.pdf') || source.includes('.pdf?') || source.startsWith('blob:');
}

function candidateImage(image: HTMLImageElement): ActiveImageMedia | null {
  if (image.naturalWidth < 240 || image.naturalHeight < 160) return null;
  const rect = image.getBoundingClientRect();
  if (!visible(image, rect)) return null;
  const viewer = findViewer(image);
  if (!viewer) return null;
  const viewportArea = Math.max(1, innerWidth * innerHeight);
  const area = rect.width * rect.height;
  if (area < viewportArea * 0.075) return null;
  if (rect.width < innerWidth * 0.28 && rect.height < innerHeight * 0.34) return null;
  const centerXRatio = (rect.left + rect.width / 2) / innerWidth;
  const centerYRatio = (rect.top + rect.height / 2) / innerHeight;
  if (centerXRatio < 0.12 || centerXRatio > 0.88 || centerYRatio < 0.08 || centerYRatio > 0.92) return null;
  return { kind: 'image', element: image, rect, viewer, key: imageKey(image) };
}

export function refreshActiveMedia(media: ActiveMedia): ActiveMedia | null {
  if (!media.element.isConnected || !media.viewer.isConnected) return null;
  const rect = media.element.getBoundingClientRect();
  if (!visible(media.element, rect)) return null;
  const viewerRect = media.viewer.getBoundingClientRect();
  if (!visible(media.viewer, viewerRect) || viewerRect.width < innerWidth * 0.55 || viewerRect.height < innerHeight * 0.55) return null;
  if (media.kind === 'image') {
    if (media.element.naturalWidth < 200 || media.element.naturalHeight < 140) return null;
    return { ...media, rect, key: imageKey(media.element) };
  }
  return { ...media, rect };
}

/**
 * Searches for active media the user is currently viewing.
 *
 * @param knownViewer - A previously-identified viewer element. When supplied the
 *   search is scoped to that subtree only, avoiding an expensive full-page
 *   querySelectorAll. Falls back to a complete document scan if nothing is
 *   found inside the known viewer or if the viewer is no longer connected.
 */
export function findActiveMedia(knownViewer?: HTMLElement | null): ActiveMedia | null {
  const viewportArea = Math.max(1, innerWidth * innerHeight);

  // ── Fast path ──────────────────────────────────────────────────────────────
  // When we already know which overlay element is the viewer, restrict the
  // querySelectorAll to that subtree. This is several orders of magnitude
  // cheaper than scanning the entire WhatsApp DOM every 90 ms.
  if (knownViewer && knownViewer.isConnected) {
    let bestImage: ActiveImageMedia | null = null;
    let bestImageScore = 0;

    for (const image of knownViewer.querySelectorAll<HTMLImageElement>('img')) {
      // Use the cheaper rect-only check — the viewer itself is already confirmed
      // visible, so full getComputedStyle per child is wasteful.
      if (image.naturalWidth < 240 || image.naturalHeight < 160) continue;
      const rect = image.getBoundingClientRect();
      if (!visibleByRect(rect)) continue;
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const area = rect.width * rect.height;
      if (area < viewportArea * 0.075) continue;
      if (rect.width < innerWidth * 0.28 && rect.height < innerHeight * 0.34) continue;
      const centerXRatio = (rect.left + rect.width / 2) / innerWidth;
      const centerYRatio = (rect.top + rect.height / 2) / innerHeight;
      if (centerXRatio < 0.12 || centerXRatio > 0.88 || centerYRatio < 0.08 || centerYRatio > 0.92) continue;
      // findViewer is already known — reuse knownViewer directly.
      const candidate: ActiveImageMedia = { kind: 'image', element: image, rect, viewer: knownViewer, key: imageKey(image) };
      const centerDistance = Math.hypot(
        rect.left + rect.width / 2 - innerWidth / 2,
        rect.top + rect.height / 2 - innerHeight / 2,
      );
      const centerBonus = Math.max(0, 1 - centerDistance / Math.hypot(innerWidth, innerHeight));
      const score = area * (1 + centerBonus * 0.32);
      if (score > bestImageScore) { bestImageScore = score; bestImage = candidate; }
    }
    if (bestImage) return bestImage;

    for (const element of knownViewer.querySelectorAll<HTMLElement>('embed, object, iframe')) {
      if (!isPdfElement(element)) continue;
      const rect = element.getBoundingClientRect();
      if (!visibleByRect(rect) || rect.width * rect.height < viewportArea * 0.12) continue;
      const source = pdfSource(element);
      return { kind: 'pdf', element, rect, viewer: knownViewer, source, key: `pdf:${source || `${Math.round(rect.width)}x${Math.round(rect.height)}`}` };
    }
    // Nothing found inside the known viewer — fall through to the full scan so
    // we can detect a different viewer that may have opened.
  }

  // ── Full-page fallback scan ────────────────────────────────────────────────
  let bestImage: ActiveImageMedia | null = null;
  let bestImageScore = 0;

  for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
    const candidate = candidateImage(image);
    if (!candidate) continue;
    const area = candidate.rect.width * candidate.rect.height;
    const centerDistance = Math.hypot(candidate.rect.left + candidate.rect.width / 2 - innerWidth / 2, candidate.rect.top + candidate.rect.height / 2 - innerHeight / 2);
    const centerBonus = Math.max(0, 1 - centerDistance / Math.hypot(innerWidth, innerHeight));
    const score = area * (1 + centerBonus * 0.32);
    if (score > bestImageScore) {
      bestImageScore = score;
      bestImage = candidate;
    }
  }
  if (bestImage) return bestImage;

  for (const element of document.querySelectorAll<HTMLElement>('embed, object, iframe')) {
    if (!isPdfElement(element)) continue;
    const rect = element.getBoundingClientRect();
    if (!visible(element, rect) || rect.width * rect.height < viewportArea * 0.12) continue;
    const viewer = findViewer(element);
    if (!viewer) continue;
    const source = pdfSource(element);
    return { kind: 'pdf', element, rect, viewer, source, key: `pdf:${source || `${Math.round(rect.width)}x${Math.round(rect.height)}`}` };
  }
  return null;
}
