import type { MergeLayout } from '../types/media';

export const A4_WIDTH = 2480;
export const A4_HEIGHT = 3508;

export interface A4Slot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createA4Slots(
  count: number,
  layout: MergeLayout,
  padding: number,
  gap: number,
  gridColumns = 2,
): A4Slot[] {
  const safeCount = Math.max(1, Math.floor(count));
  const safePadding = Math.max(0, Math.min(A4_WIDTH / 3, padding));
  const safeGap = Math.max(0, Math.min(A4_WIDTH / 3, gap));
  const usableWidth = Math.max(1, A4_WIDTH - safePadding * 2);
  const usableHeight = Math.max(1, A4_HEIGHT - safePadding * 2);

  if (layout === 'horizontal') {
    const width = Math.max(1, (usableWidth - safeGap * Math.max(0, safeCount - 1)) / safeCount);
    return Array.from({ length: safeCount }, (_, index) => ({
      x: safePadding + index * (width + safeGap),
      y: safePadding,
      width,
      height: usableHeight,
    }));
  }

  if (layout === 'grid') {
    const columns = Math.max(1, Math.min(6, Math.floor(gridColumns) || 2));
    const rows = Math.max(1, Math.ceil(safeCount / columns));
    const width = Math.max(1, (usableWidth - safeGap * Math.max(0, columns - 1)) / columns);
    const height = Math.max(1, (usableHeight - safeGap * Math.max(0, rows - 1)) / rows);
    return Array.from({ length: safeCount }, (_, index) => ({
      x: safePadding + (index % columns) * (width + safeGap),
      y: safePadding + Math.floor(index / columns) * (height + safeGap),
      width,
      height,
    }));
  }

  const height = Math.max(1, (usableHeight - safeGap * Math.max(0, safeCount - 1)) / safeCount);
  return Array.from({ length: safeCount }, (_, index) => ({
    x: safePadding,
    y: safePadding + index * (height + safeGap),
    width: usableWidth,
    height,
  }));
}
