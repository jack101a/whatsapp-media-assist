export interface OnlineEntitlementPayload {
  licenseId: string;
  tier: 'premium';
  issuedAt: number;
  refreshAfter: number;
  expiresAt: number;
  subscriptionExpiresAt: number;
  customer: string;
  userId: string;
  deviceId: string;
  features: string[];
  nonce: string;
}

export interface BillingState {
  deviceId: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  entitlementToken?: string;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface EntitlementStatus {
  premium: boolean;
  payload?: OnlineEntitlementPayload;
  reason?: string;
  shouldRefresh: boolean;
}

export interface AccountDevice {
  device_id: string;
  name: string;
  current: boolean;
  last_seen_at: string;
  created_at: string;
}

export interface AccountData {
  email: string;
  devices: AccountDevice[];
  entitlement: {
    plan: 'free' | 'pro';
    status: string;
    expires_at?: string;
    refresh_after?: string;
    offline_until?: string;
    entitlement_token?: string;
  };
}


export interface BillingProduct {
  name: string;
  duration_days: number;
  prices: Array<{ currency: 'INR' | 'USD'; amount_minor: number; label: string }>;
}
