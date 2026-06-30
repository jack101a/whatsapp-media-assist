import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/storage/settings';

describe('settings normalization', () => {
  it('clears legacy filename leakage from image processing presets', () => {
    const settings = normalizeSettings({
      defaultFilenameTemplate: 'ssc_sign_{datetime}',
      defaultWidth: 256,
      defaultHeight: 64,
      defaultMaxKB: 20,
    });

    expect(settings.defaultFilenameTemplate).toBe('{datetime}');
    expect(settings.defaultWidth).toBe(256);
    expect(settings.defaultHeight).toBe(64);
  });
});
