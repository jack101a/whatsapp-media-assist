import AdmZip from 'adm-zip';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const release = 'release';
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
rmSync(`.output/media-assist-extension-${version}-sources.zip`, { force: true });

const chromeName = `media-assist-extension-${version}-chrome.zip`;
const firefoxName = `media-assist-extension-${version}-firefox.zip`;
for (const name of [chromeName, firefoxName]) {
  const source = join('.output', name);
  if (!existsSync(source)) throw new Error(`Missing ${source}`);
  cpSync(source, join(release, name));
}

execFileSync(process.execPath, ['scripts/source-archive.mjs', '--public'], { stdio: 'inherit' });
cpSync('store-assets', join(release, 'store-assets'), { recursive: true });
cpSync('.output/chrome-mv3', join(release, 'chrome-unpacked'), { recursive: true });
cpSync('.output/firefox-mv3', join(release, 'firefox-unpacked'), { recursive: true });

const docs = ['README.md', 'PRIVACY_POLICY.md', 'STORE_LISTING.md', 'DEPLOYMENT.md', 'SECURITY.md', 'BUILD-VERIFICATION.txt', 'INSTALL-AND-PUBLISH.txt', 'PATCH-NOTES-1.3.0.md', 'LICENSE'];
for (const file of docs) cpSync(file, join(release, file));

function addTree(zip, root, prefix, excluded = () => false) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).replaceAll('\\', '/');
      if (excluded(rel, name)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else zip.addLocalFile(full, join(prefix, rel).replaceAll('\\', '/').split('/').slice(0, -1).join('/'));
    }
  };
  walk(root);
}

const serverZipName = `media-assist-server-${version}-deploy.zip`;
const serverZip = new AdmZip();
addTree(serverZip, 'server', 'server', (rel, name) => name === '.env' || name === '__pycache__' || /\.pyc$/.test(name));
addTree(serverZip, 'deploy', 'deploy', (rel, name) => name === '.env' || rel.startsWith('backups/'));
serverZip.addLocalFile('DEPLOYMENT.md');
serverZip.addLocalFile('SECURITY.md');
serverZip.writeZip(join(release, serverZipName));

const ownerName = `media-assist-owner-secrets-${version}-PRIVATE.zip`;
const ownerZip = new AdmZip();
ownerZip.addLocalFile('owner-secrets/entitlement-private.pem', 'owner-secrets');
ownerZip.addLocalFile('owner-secrets/README-PRIVATE.txt', 'owner-secrets');
ownerZip.addLocalFile('src/billing/public-entitlement-key.ts', 'matching-public-key');
ownerZip.writeZip(join(release, ownerName));

writeFileSync(join(release, 'RELEASE-NOTES.txt'), `Media Assist ${version}\n\nDeploy the server first, then validate account/payment activation before store submission. The PRIVATE owner-secrets ZIP must never be uploaded or shared.\n`);

const completeName = `media-assist-${version}-complete-release.zip`;
const completeZip = new AdmZip();
for (const name of readdirSync(release)) {
  if (name === completeName || name.endsWith('SHA256.txt') || name.includes('owner-secrets')) continue;
  const full = join(release, name);
  if (statSync(full).isDirectory()) addTree(completeZip, full, name);
  else completeZip.addLocalFile(full);
}
completeZip.writeZip(join(release, completeName));

const checksumTargets = readdirSync(release).filter((name) => name.endsWith('.zip'));
const checksums = checksumTargets.map((name) => `${createHash('sha256').update(readFileSync(join(release, name))).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(join(release, `MEDIA-ASSIST-${version}-SHA256.txt`), checksums);
console.log(`Release prepared in ${release}/`);
