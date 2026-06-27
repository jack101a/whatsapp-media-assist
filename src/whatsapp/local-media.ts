import type { ActiveMedia } from './media-detector';
import { captureImageElement, PrivacySourceError } from '../engine/canvas';

export async function captureActiveMedia(media: ActiveMedia): Promise<Blob> {
  if (media.kind === 'image') return captureImageElement(media.element);
  const source = media.source;
  if (!source) throw new PrivacySourceError('The opened PDF does not expose a local source.');

  const resolved = new URL(source, location.href);
  if (resolved.protocol !== 'blob:' && resolved.protocol !== 'data:') {
    throw new PrivacySourceError('The opened PDF is not available as a local browser blob.');
  }

  // This reads only an already-local blob/data URL. HTTP(S) is rejected above.
  const response = await fetch(resolved.href);
  if (!response.ok) throw new PrivacySourceError('The local PDF could not be read.');
  const blob = await response.blob();
  if (blob.type && !blob.type.includes('pdf')) throw new PrivacySourceError('The local media is not a PDF.');
  return blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
}
