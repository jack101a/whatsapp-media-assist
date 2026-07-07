import { describe, expect, it } from 'vitest';
import { availableStepTypes, validatePipeline } from '../src/profiles/pipeline';
import type { MediaProfile, PipelineStep } from '../src/types/profile';

const step = <T extends PipelineStep['type']>(value: Extract<PipelineStep, { type: T }>): PipelineStep => value;

function profile(steps: PipelineStep[]): MediaProfile {
  return {
    id: 'p1', name: 'Upload1', pinned: true, inputCount: 1, mergeLayout: 'vertical', background: '#fff',
    steps, createdAt: 1, updatedAt: 1,
  };
}

describe('pipeline validation', () => {
  it('accepts a complete ordered processing pipeline', () => {
    const value = profile([
      step({ id: '1', type: 'crop', mode: 'ask', ratio: 'free' }),
      step({ id: '2', type: 'resize', width: 800, fit: 'contain', allowUpscale: false }),
      step({ id: '3', type: 'format', format: 'jpeg' }),
      step({ id: '4', type: 'compress', minKB: 100, maxKB: 200 }),
      step({ id: '5', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true }),
      step({ id: '6', type: 'download', automatic: true }),
    ]);
    expect(validatePipeline(value)).toEqual({ errors: [], warnings: [] });
  });

  it('rejects duplicates and invalid ordering', () => {
    const value = profile([
      step({ id: '1', type: 'download', automatic: true }),
      step({ id: '2', type: 'resize', width: 800, fit: 'contain', allowUpscale: false }),
      step({ id: '3', type: 'resize', height: 900, fit: 'contain', allowUpscale: false }),
    ]);
    expect(validatePipeline(value).errors.join(' ')).toMatch(/Only one resize/);
    expect(validatePipeline(value).errors.join(' ')).toMatch(/Download must be the final step/);
  });

  it('warns when both crop and resize cover exist', () => {
    const value = profile([
      step({ id: '1', type: 'crop', mode: 'preset', ratio: '1:1' }),
      step({ id: '2', type: 'resize', width: 800, fit: 'cover', allowUpscale: false }),
    ]);
    const validation = validatePipeline(value);
    expect(validation.warnings.join(' ')).toMatch(/Both crop and resize/);
  });

  it('offers only step types not already used', () => {
    const value = profile([step({ id: '1', type: 'crop', mode: 'ask', ratio: 'free' })]);
    expect(availableStepTypes(value)).not.toContain('crop');
    expect(availableStepTypes(value)).toContain('resize');
  });
});
