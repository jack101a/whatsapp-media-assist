export type ImageFormat = 'jpeg' | 'png' | 'webp';
export type MergeLayout = 'vertical' | 'horizontal' | 'grid';

export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResizeSettings {
  width?: number;
  height?: number;
  percentage?: number;
  maintainAspectRatio: boolean;
  allowUpscale: boolean;
  fit: 'contain' | 'cover' | 'stretch';
}

export interface CompressionSettings {
  minBytes?: number;
  maxBytes?: number;
  preferredQuality: number;
  minimumQuality: number;
  allowDimensionReduction: boolean;
}


export type CanvasOperation =
  | { type: 'rotate'; degrees: -90 | 90 | 180 | 270 }
  | { type: 'crop'; crop?: NormalizedCrop; ratio?: number }
  | { type: 'resize'; settings: ResizeSettings };

export interface ImageTransform {
  rotation: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
  crop?: NormalizedCrop;
  resize?: ResizeSettings;
  format: ImageFormat;
  compression: CompressionSettings;
  background: string;
}

export interface ProcessedMedia {
  blob: Blob;
  width: number;
  height: number;
  format: ImageFormat;
  quality?: number;
  warnings: string[];
}

export interface ItemPlacement {
  /** Horizontal offset relative to the assigned A4 slot, from -0.5 to 0.5. */
  offsetX: number;
  /** Vertical offset relative to the assigned A4 slot, from -0.5 to 0.5. */
  offsetY: number;
  /** Scale applied after the item is fitted into its assigned slot. */
  scale: number;
}

export interface MergeOptions {
  layout: MergeLayout;
  format: ImageFormat | 'pdf';
  background: string;
  gap: number;
  padding: number;
  borderWidth: number;
  borderColor: string;
  gridColumns: number;
  quality: number;
  maxBytes?: number;
}

export interface MergeItem {
  id: string;
  blob: Blob;
  name: string;
  rotation: 0 | 90 | 180 | 270;
  crop?: NormalizedCrop;
  placement?: ItemPlacement;
  sourceKey?: string;
  sourceType?: 'image' | 'pdf-page';
  pageNumber?: number;
}
