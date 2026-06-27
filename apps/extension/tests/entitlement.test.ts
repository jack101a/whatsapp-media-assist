import { createPrivateKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyEntitlementToken } from '../src/billing/entitlement';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
Object.defineProperty(globalThis, 'atob', { value: (value: string) => Buffer.from(value, 'base64').toString('binary') });

describe('online entitlement', () => {
  it('verifies a device-bound signed entitlement', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const payload = Buffer.from(JSON.stringify({
      licenseId: 'sub-1', tier: 'premium', issuedAt: Date.now(), refreshAfter: Date.now() + 1000,
      expiresAt: Date.now() + 60_000, subscriptionExpiresAt: Date.now() + 86_400_000,
      customer: 'test@example.com', userId: 'user-1', deviceId: 'device-1', features: ['pipelines'], nonce: 'test',
    }));
    const signature = sign('sha256', payload, { key: createPrivateKey({ key: privateKey.export({ format: 'jwk' }), format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    const token = `${payload.toString('base64url')}.${signature.toString('base64url')}`;
    const result = await verifyEntitlementToken(token, 'device-1', Date.now(), publicKey.export({ format: 'jwk' }));
    expect(result.premium).toBe(true);
  });

  it('rejects a token on another device', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const payload = Buffer.from(JSON.stringify({
      licenseId: 'sub-1', tier: 'premium', issuedAt: Date.now(), refreshAfter: Date.now() + 1000,
      expiresAt: Date.now() + 60_000, subscriptionExpiresAt: Date.now() + 86_400_000,
      customer: 'test@example.com', userId: 'user-1', deviceId: 'device-1', features: [], nonce: 'test',
    }));
    const signature = sign('sha256', payload, { key: createPrivateKey({ key: privateKey.export({ format: 'jwk' }), format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    const token = `${payload.toString('base64url')}.${signature.toString('base64url')}`;
    expect((await verifyEntitlementToken(token, 'device-2', Date.now(), publicKey.export({ format: 'jwk' }))).premium).toBe(false);
  });
});
