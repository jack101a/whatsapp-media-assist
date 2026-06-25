const DEFAULT_API_ORIGIN = 'https://mediaassist.002529.xyz';

export const API_BASE_URL = (import.meta.env.VITE_MEDIA_ASSIST_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, '');
export const ENTITLEMENT_REFRESH_ALARM = 'media-assist-entitlement-refresh';
export const ENTITLEMENT_REFRESH_MINUTES = 12 * 60;
