import type { MergeItem } from './media';
import type { MergeOptions } from './media';

export type ProcessorRequestInput =
  | { type: 'raster-pdf'; blob: Blob; name: string; sourceKey: string; pdfWorkerUrl: string }
  | { type: 'compress-pdf'; blob: Blob; maxBytes?: number; preferredQuality: number; pdfWorkerUrl: string }
  | { type: 'merge'; items: MergeItem[]; options: MergeOptions };

export type ProcessorRequest = ProcessorRequestInput & { id: string };

export type ProcessorResponse =
  | { id: string; type: 'progress'; current: number; total: number; note: string }
  | { id: string; type: 'success'; result: Blob | MergeItem[] }
  | { id: string; type: 'error'; message: string };
