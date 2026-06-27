import AdmZip from 'adm-zip';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve('.');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const outputDir = join(root, 'release');
mkdirSync(outputDir, { recursive: true });
const output = join(outputDir, `media-assist-extension-${version}-public-source.zip`);

const excludedTopLevel = new Set(['.git', '.output', '.wxt', 'node_modules', 'release', 'owner-only', 'owner-secrets', '.pytest_cache']);
const excludedNames = new Set(['.DS_Store', '__pycache__', '.env']);

function shouldExclude(path, rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.length && (excludedTopLevel.has(parts[0]) || parts[0].startsWith('.tmp-'))) return true;
  if (parts.some((part) => excludedNames.has(part))) return true;
  if (/\.(?:crx|pem|pyc|sqlite3?)$/i.test(rel)) return true;
  if (rel.startsWith('deploy/backups/')) return true;
  return false;
}

const zip = new AdmZip();
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (shouldExclude(full, rel)) continue;
    const info = statSync(full);
    if (info.isDirectory()) walk(full);
    else zip.addLocalFile(full, rel.split('/').slice(0, -1).join('/'));
  }
}
walk(root);
zip.writeZip(output);
console.log(`Public source archive: ${output}`);
