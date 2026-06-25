import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const privateKey = createPrivateKey(readFileSync('owner-secrets/entitlement-private.pem'));
const publicSource = readFileSync('src/billing/public-entitlement-key.ts', 'utf8');
const match = publicSource.match(/export const ENTITLEMENT_PUBLIC_KEY = (\{[\s\S]*?\}) as JsonWebKey;/);
if (!match) throw new Error('Embedded entitlement public key was not found');
const embedded = JSON.parse(match[1]);
const derived = createPublicKey(privateKey).export({ format: 'jwk' });
for (const key of ['kty', 'crv', 'x', 'y']) {
  if (embedded[key] !== derived[key]) throw new Error(`Entitlement key mismatch: ${key}`);
}
const payload = Buffer.from('media-assist-entitlement-key-audit');
const signature = sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
if (!verify('sha256', payload, { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, signature)) {
  throw new Error('Entitlement signing key self-test failed');
}
console.log('Entitlement private key matches the public key embedded in the extension.');
