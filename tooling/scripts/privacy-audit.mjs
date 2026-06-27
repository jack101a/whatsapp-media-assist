import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['src', 'entrypoints'];
const forbidden = [
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'EventSource', pattern: /\bEventSource\b/ },
  { label: 'sendBeacon', pattern: /\bsendBeacon\s*\(/ },
  { label: 'body innerText', pattern: /document\.body\.innerText/ },
  { label: 'body textContent', pattern: /document\.body\.textContent/ },
  { label: 'remote script URL', pattern: /<script[^>]+https?:\/\//i },
];
const fetchAllowlist = new Set(['src/whatsapp/local-media.ts', 'entrypoints/background.ts']);
const failures = [];
function walk(path) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(?:ts|tsx|js|mjs|html)$/.test(name)) {
      const rel = relative('.', full).replace(/\\/g, '/');
      const content = readFileSync(full, 'utf8');
      for (const rule of forbidden) if (rule.pattern.test(content)) failures.push(`${rel}: ${rule.label}`);
      if (/\bfetch\s*\(/.test(content) && !fetchAllowlist.has(rel)) failures.push(`${rel}: unapproved fetch`);
    }
  }
}
for (const root of roots) walk(root);
const localReader = readFileSync('src/whatsapp/local-media.ts', 'utf8');
if (!localReader.includes("resolved.protocol !== 'blob:'") || !localReader.includes("resolved.protocol !== 'data:'")) failures.push('local media URL guard missing');
const background = readFileSync('entrypoints/background.ts', 'utf8');
if (!background.includes('API_BASE_URL') || !background.includes("credentials: 'omit'")) failures.push('billing network path is not restricted');
if (failures.length) {
  console.error('Privacy audit failed:\n' + failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Privacy audit passed: WhatsApp media stays local; only the background billing client may contact the configured licensing API.');
