import { browser } from 'wxt/browser';
import type { BillingRequest, BillingResponse } from './messages';

export async function billingRequest<T>(request: BillingRequest): Promise<T> {
  const response = await browser.runtime.sendMessage(request) as BillingResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? 'Billing request failed.');
  return response.data as T;
}
