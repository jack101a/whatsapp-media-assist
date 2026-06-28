import React from 'react';

export type IconName = 'spark' | 'crop' | 'resize' | 'compress' | 'merge' | 'more' | 'rotate-left' | 'rotate-right' | 'close' | 'download' | 'lock' | 'eye' | 'eye-off' | 'settings' | 'file' | 'check' | 'trash' | 'up' | 'down' | 'plus';

const paths: Record<IconName, React.ReactNode> = {
  spark: <><path d="m12 2 1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2Z"/><path d="m5 14 .9 2.6L8.5 17.5l-2.6.9L5 21l-.9-2.6-2.6-.9 2.6-.9L5 14Z"/></>,
  crop: <><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/></>,
  resize: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="m3 8 6-6M15 2l6 6M3 16l6 6M15 22l6-6"/></>,
  compress: <><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/><path d="m8 8-5-5M16 8l5-5M8 16l-5 5M16 16l5 5"/></>,
  merge: <><rect x="3" y="4" width="8" height="8" rx="1"/><rect x="13" y="12" width="8" height="8" rx="1"/><path d="M7 12v4a2 2 0 0 0 2 2h4M17 12V8a2 2 0 0 0-2-2h-4"/></>,
  more: <><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></>,
  'rotate-left': <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></>,
  'rotate-right': <><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5"/><path d="M5 21h14"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3"/></>,
  'eye-off': <><path d="M3 3l18 18"/><path d="M10.7 5.2A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a16.4 16.4 0 0 1-2.1 2.9"/><path d="M6.6 6.7C3.9 8.5 2.5 12 2.5 12S6 19 12 19a9.7 9.7 0 0 0 4.1-.9"/><path d="M9.9 9.9A3 3 0 0 0 14.1 14.1"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  trash: <><path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15"/></>,
  up: <path d="m6 15 6-6 6 6"/>,
  down: <path d="m6 9 6 6 6-6"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
