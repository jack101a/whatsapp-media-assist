import { ENTITLEMENT_PUBLIC_KEY } from './public-entitlement-key';
import type { EntitlementStatus, OnlineEntitlementPayload } from './types';

const decoder = new TextDecoder();

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

export async function verifyEntitlementToken(token: string | undefined, expectedDeviceId: string, now = Date.now(), publicKey: JsonWebKey = ENTITLEMENT_PUBLIC_KEY): Promise<EntitlementStatus> {
  if (!token) return { premium: false, reason: 'No active Pro entitlement.', shouldRefresh: false };
  const parts = token.trim().split('.');
  if (parts.length !== 2) return { premium: false, reason: 'Invalid entitlement format.', shouldRefresh: true };
  try {
    const [payloadPart, signaturePart] = parts as [string, string];
    const payloadBytes = fromBase64Url(payloadPart);
    const signature = fromBase64Url(signaturePart);
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, payloadBytes);
    if (!valid) return { premium: false, reason: 'Entitlement signature is invalid.', shouldRefresh: true };
    const payload = JSON.parse(decoder.decode(payloadBytes)) as OnlineEntitlementPayload;
    if (payload.tier !== 'premium') return { premium: false, reason: 'This account is not Pro.', shouldRefresh: true };
    if (payload.deviceId !== expectedDeviceId) return { premium: false, reason: 'Entitlement belongs to another device.', shouldRefresh: true };
    if (payload.subscriptionExpiresAt <= now) return { premium: false, payload, reason: 'Pro access expired.', shouldRefresh: true };
    if (payload.expiresAt <= now) return { premium: false, payload, reason: 'Connect to refresh Pro access.', shouldRefresh: true };
    return { premium: true, payload, shouldRefresh: payload.refreshAfter <= now };
  } catch {
    return { premium: false, reason: 'Entitlement could not be verified.', shouldRefresh: true };
  }
}
