import { describe, expect, it } from 'vitest';
import { dateTokens, renderFilename, withExtension } from '../src/utils/filename';

describe('filename engine', () => {
  it('creates a compact datetime without special characters', () => {
    const date = new Date(2026, 5, 23, 14, 5, 9);
    expect(dateTokens(date).datetime).toBe('20260623140509');
    expect(renderFilename('{datetime}', { date }, { removeSpaces: true, removeSpecialCharacters: true })).toBe('20260623140509');
  });
  it('sanitizes reserved and unsafe names', () => {
    expect(renderFilename('CON: file?', {}, { removeSpaces: false, removeSpecialCharacters: true })).toBe('CON_file');
  });
  it('replaces a known extension', () => {
    expect(withExtension('sample.png', 'jpeg')).toBe('sample.jpg');
  });
});
