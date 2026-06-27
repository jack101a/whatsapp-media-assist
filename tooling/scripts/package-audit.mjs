import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['.output/chrome-mv3', '.output/firefox-mv3'];
const expectedPermissions = ['storage', 'alarms'];
const expectedHosts = ['https://web.whatsapp.com/*', 'https://mediaassist.002529.xyz/*'];
const forbiddenNames = ['entitlement-private.pem', 'owner-secrets', '.env', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
const forbiddenRuntimeTokens = ['google-analytics.com', 'googletagmanager.com', 'sentry.io', 'segment.io', 'mixpanel.com'];
function files(root){const out=[];for(const name of readdirSync(root)){const p=join(root,name);if(statSync(p).isDirectory())out.push(...files(p));else out.push(p)}return out}
for (const root of roots) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error(`${root}: not MV3`);
  if (JSON.stringify(manifest.permissions ?? []) !== JSON.stringify(expectedPermissions)) throw new Error(`${root}: unexpected permissions ${JSON.stringify(manifest.permissions)}`);
  if (JSON.stringify(manifest.host_permissions ?? []) !== JSON.stringify(expectedHosts)) throw new Error(`${root}: unexpected host permissions ${JSON.stringify(manifest.host_permissions)}`);
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("connect-src 'self' https://mediaassist.002529.xyz")) throw new Error(`${root}: billing CSP missing`);
  if (csp.includes("worker-src 'self' blob:")) throw new Error(`${root}: insecure blob worker CSP`);
  if (manifest.action?.default_popup !== 'popup.html') throw new Error(`${root}: popup missing`);
  if (manifest.options_ui?.page !== 'options.html' || manifest.options_ui?.open_in_tab !== true) throw new Error(`${root}: full options tab missing`);
  if (!statSync(join(root, 'background.js')).isFile()) throw new Error(`${root}: billing service worker missing`);
  const contentSize = statSync(join(root, 'content-scripts/content.js')).size;
  if (contentSize > 400_000) throw new Error(`${root}: content script too large (${contentSize})`);
  for (const file of files(root)) {
    const rel = relative(root, file);
    const text = /\.(?:js|mjs|html|json|css)$/i.test(file) ? readFileSync(file, 'utf8') : '';
    for (const bad of forbiddenNames) if (rel.includes(bad) || text.includes(bad)) throw new Error(`${root}: forbidden secret token ${bad} in ${rel}`);
    for (const bad of forbiddenRuntimeTokens) if (text.includes(bad)) throw new Error(`${root}: forbidden telemetry token ${bad} in ${rel}`);
  }
  console.log(`PASS ${root}: MV3, billing-only API access, no owner secrets`);
}
