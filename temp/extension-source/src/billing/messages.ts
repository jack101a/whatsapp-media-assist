export type BillingRequest =
  | { type: 'billing:get-status' }
  | { type: 'billing:get-product' }
  | { type: 'billing:request-otp'; email: string }
  | { type: 'billing:verify-otp'; email: string; code: string; deviceName: string }
  | { type: 'billing:refresh' }
  | { type: 'billing:get-account' }
  | { type: 'billing:create-checkout'; currency: 'INR' | 'USD' }
  | { type: 'billing:remove-device'; deviceId: string }
  | { type: 'billing:sign-out' };

export interface BillingResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
