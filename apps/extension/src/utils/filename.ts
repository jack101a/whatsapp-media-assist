export interface FilenameContext {
  date?: Date;
  counter?: number;
  width?: number;
  height?: number;
  format?: string;
  profile?: string;
  custom?: string;
  original?: string;
  prefix?: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function dateTokens(date = new Date()) {
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return {
    date: `${year}${month}${day}`,
    time: `${hour}${minute}${second}`,
    datetime: `${year}${month}${day}${hour}${minute}${second}`,
  };
}

export function renderFilename(
  template: string,
  context: FilenameContext,
  options: { removeSpaces: boolean; removeSpecialCharacters: boolean },
): string {
  const now = context.date ?? new Date();
  const tokens = dateTokens(now);
  const values: Record<string, string> = {
    ...tokens,
    counter: String(context.counter ?? 1).padStart(2, '0'),
    width: String(context.width ?? ''),
    height: String(context.height ?? ''),
    format: context.format ?? '',
    profile: context.profile ?? '',
    custom: context.custom ?? '',
    original: context.original ?? 'media',
    prefix: context.prefix ?? '',
  };

  let result = (template.trim() || '{datetime}')
    .replace(/\{([a-z]+)\}/gi, (match, key: string) => values[key.toLowerCase()] ?? match)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\.+$/g, '');

  if (options.removeSpaces) result = result.replace(/\s+/g, '');
  if (options.removeSpecialCharacters) result = result.replace(/[^a-zA-Z0-9._-]/g, '');
  result = result.replace(/_{2,}/g, '_').replace(/-{2,}/g, '-').replace(/^\.+/, '').replace(/[_-]+$/g, '');

  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (windowsReserved.test(result)) result = `file_${result}`;
  return result.slice(0, 180) || tokens.datetime;
}

export function withExtension(name: string, extension: string): string {
  const safeExtension = extension.replace(/^\./, '').toLowerCase();
  const withoutKnown = name.replace(/\.(jpe?g|png|webp|pdf)$/i, '');
  return `${withoutKnown}.${safeExtension === 'jpeg' ? 'jpg' : safeExtension}`;
}
