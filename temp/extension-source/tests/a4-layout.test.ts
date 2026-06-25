import { describe, expect, it } from 'vitest';
import { A4_HEIGHT, A4_WIDTH, createA4Slots } from '../src/engine/a4-layout';

describe('A4 merge layouts', () => {
  it('stacks two items vertically inside an A4 page', () => {
    const slots = createA4Slots(2, 'vertical', 72, 36, 2);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.width).toBe(A4_WIDTH - 144);
    expect(slots[0]!.y).toBe(72);
    expect(slots[1]!.y).toBeGreaterThan(slots[0]!.y + slots[0]!.height);
    expect(slots[1]!.y + slots[1]!.height).toBeLessThanOrEqual(A4_HEIGHT - 72 + 0.001);
  });

  it('places two items side by side', () => {
    const slots = createA4Slots(2, 'horizontal', 60, 20, 2);
    expect(slots[0]!.height).toBe(A4_HEIGHT - 120);
    expect(slots[1]!.x).toBeGreaterThan(slots[0]!.x + slots[0]!.width);
  });

  it('honours a custom image grid column count', () => {
    const slots = createA4Slots(5, 'grid', 50, 10, 3);
    expect(slots).toHaveLength(5);
    expect(slots[3]!.y).toBeGreaterThan(slots[0]!.y);
    expect(slots[2]!.x).toBeGreaterThan(slots[1]!.x);
  });
});
