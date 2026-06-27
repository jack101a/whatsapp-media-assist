import { browser } from 'wxt/browser';
import type { BillingState } from './types';

const BILLING_KEY = 'mediaAssistBilling';

export async function getBillingState(): Promise<BillingState> {
  const result = await browser.storage.local.get(BILLING_KEY);
  const current = (result[BILLING_KEY] ?? {}) as Partial<BillingState>;
  let deviceId = current.deviceId;
  if (!deviceId) {
    deviceId = crypto.randomUUID().replace(/-/g, '');
    await browser.storage.local.set({ [BILLING_KEY]: { ...current, deviceId } });
  }
  return { ...current, deviceId };
}

export async function saveBillingState(state: BillingState): Promise<void> {
  await browser.storage.local.set({ [BILLING_KEY]: state });
}

export async function updateBillingState(patch: Partial<BillingState>): Promise<BillingState> {
  const current = await getBillingState();
  const next = { ...current, ...patch };
  await saveBillingState(next);
  return next;
}

export async function clearBillingSession(): Promise<BillingState> {
  const current = await getBillingState();
  const next: BillingState = { deviceId: current.deviceId };
  await saveBillingState(next);
  return next;
}

export function watchBillingState(callback: (state: BillingState) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[BILLING_KEY]?.newValue) callback(changes[BILLING_KEY]!.newValue as BillingState);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
