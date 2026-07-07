import type { ImageFormat, MergeLayout } from './media';
import type { CropRatio } from '../storage/settings';

export type FilenamePreset = 'original' | 'datetime' | 'date-counter' | 'profile-datetime' | 'prefix-datetime' | 'dimensions-date' | 'advanced';

export type PipelineStep =
  | { id: string; type: 'crop'; mode: 'ask' | 'preset'; ratio: CropRatio }
  | { id: string; type: 'rotate'; degrees: -90 | 90 | 180 }
  | { id: string; type: 'resize'; width?: number; height?: number; fit: 'contain' | 'cover' | 'stretch'; allowUpscale: boolean }
  | { id: string; type: 'format'; format: ImageFormat | 'pdf' }
  | { id: string; type: 'compress'; minKB?: number; maxKB?: number; allowDimensionReduction?: boolean }
  | { id: string; type: 'filename'; preset: FilenamePreset; template: string; prefix?: string; removeSpaces: boolean; removeSpecialCharacters: boolean }
  | { id: string; type: 'download'; automatic: boolean };

export interface MediaProfile {
  id: string;
  name: string;
  tag?: string;
  pinned: boolean;
  inputCount: number;
  mergeLayout: MergeLayout;
  background: string;
  steps: PipelineStep[];
  createdAt: number;
  updatedAt: number;
}
