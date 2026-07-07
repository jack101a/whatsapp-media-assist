import type { MediaProfile, PipelineStep } from '../types/profile';

export const PIPELINE_STEP_TYPES: PipelineStep['type'][] = [
  'crop',
  'rotate',
  'resize',
  'format',
  'compress',
  'filename',
  'download',
];

const MEDIA_TRANSFORMS = new Set<PipelineStep['type']>(['crop', 'rotate', 'resize']);

export function availableStepTypes(profile: MediaProfile): PipelineStep['type'][] {
  const used = new Set(profile.steps.map((step) => step.type));
  return PIPELINE_STEP_TYPES.filter((type) => !used.has(type));
}

export function validatePipeline(profile: MediaProfile): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<PipelineStep['type']>();

  for (const step of profile.steps) {
    if (seen.has(step.type)) errors.push(`Only one ${step.type} step is allowed.`);
    seen.add(step.type);
  }

  const indexOf = (type: PipelineStep['type']) => profile.steps.findIndex((step) => step.type === type);
  const cropIndex = indexOf('crop');
  const formatIndex = indexOf('format');
  const compressIndex = indexOf('compress');
  const filenameIndex = indexOf('filename');
  const downloadIndex = indexOf('download');

  if (cropIndex >= 0) {
    const crop = profile.steps[cropIndex];
    if (crop?.type === 'crop' && crop.mode === 'ask') {
      const earlierTransform = profile.steps.slice(0, cropIndex).some((step) => MEDIA_TRANSFORMS.has(step.type));
      if (earlierTransform) errors.push('“Ask each time” crop must be the first image step.');
    }
  }

  const lastTransform = profile.steps.reduce((last, step, index) => MEDIA_TRANSFORMS.has(step.type) ? index : last, -1);
  if (formatIndex >= 0 && formatIndex < lastTransform) errors.push('Format must come after crop, rotate and resize.');
  if (compressIndex >= 0 && compressIndex < Math.max(lastTransform, formatIndex)) errors.push('File size must come after image and format steps.');
  if (filenameIndex >= 0 && filenameIndex < Math.max(lastTransform, formatIndex, compressIndex)) errors.push('Filename must come after processing steps.');
  if (downloadIndex >= 0 && downloadIndex !== profile.steps.length - 1) errors.push('Download must be the final step.');

  const resize = profile.steps.find((step): step is Extract<PipelineStep, { type: 'resize' }> => step.type === 'resize');
  if (resize && !resize.width && !resize.height) errors.push('Resize needs a width, height, or both.');

  const compression = profile.steps.find((step): step is Extract<PipelineStep, { type: 'compress' }> => step.type === 'compress');
  if (compression?.minKB && compression?.maxKB && compression.minKB > compression.maxKB) {
    errors.push('Minimum KB cannot be greater than maximum KB.');
  }

  if (profile.inputCount < 1 || profile.inputCount > 20) errors.push('Required media must be between 1 and 20.');

  // Warnings
  const crop = profile.steps.find((step): step is Extract<PipelineStep, { type: 'crop' }> => step.type === 'crop');
  if (crop && resize && resize.fit === 'cover') {
    warnings.push('Both crop and resize “Fill & Crop” exist. This may result in double cropping.');
  }

  const formatStep = profile.steps.find((step): step is Extract<PipelineStep, { type: 'format' }> => step.type === 'format');
  const format = formatStep?.format ?? 'jpeg';
  if (format === 'png' && compression?.maxKB) {
    warnings.push('PNG format has no quality control; target size can only be met by losing image dimensions.');
  }

  if (resize && resize.width && resize.height && compression?.maxKB) {
    const pixels = resize.width * resize.height;
    // Rough estimate: 0.1 bytes per pixel is extremely low quality for JPEG, if maxBytes is below that, it's very likely infeasible.
    if (pixels * 0.1 > compression.maxKB * 1024) {
      warnings.push(`Target size (${compression.maxKB} KB) may be too small for the specified resize dimensions (${resize.width}x${resize.height}).`);
    }
  }

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}
