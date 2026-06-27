export const kbToBytes = (kb?: number): number | undefined =>
  typeof kb === 'number' && Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : undefined;

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 100 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};
