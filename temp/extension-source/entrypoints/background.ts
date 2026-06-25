import { browser } from 'wxt/browser';
import { API_BASE_URL, ENTITLEMENT_REFRESH_ALARM, ENTITLEMENT_REFRESH_MINUTES } from '../src/billing/config';
import type { BillingRequest, BillingResponse } from '../src/billing/messages';
import { clearBillingSession, getBillingState, updateBillingState } from '../src/billing/storage';
import { verifyEntitlementToken } from '../src/billing/entitlement';
import type { AccountData } from '../src/billing/types';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  entitlement_token?: string;
  email: string;
}

async function api<T>(path: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store', credentials: 'omit' });
  const payload = await response.json().catch(() => ({})) as { detail?: string } & T;
  if (!response.ok) throw new Error(payload.detail ?? `Request failed (${response.status})`);
  return payload;
}

async function refreshSession(): Promise<{ email?: string; premium: boolean; reason?: string }> {
  const state = await getBillingState();
  if (!state.refreshToken) {
    const status = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
    return { email: state.email, premium: status.premium, reason: status.reason };
  }
  try {
    const tokens = await api<TokenResponse>('/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: state.refreshToken, device_id: state.deviceId }),
    });
    const next = await updateBillingState({
      email: tokens.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      entitlementToken: tokens.entitlement_token,
      lastCheckedAt: Date.now(),
      lastError: undefined,
    });
    const status = await verifyEntitlementToken(next.entitlementToken, next.deviceId);
    return { email: next.email, premium: status.premium, reason: status.reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Could not refresh account.';
    await updateBillingState({ lastCheckedAt: Date.now(), lastError: reason });
    const cached = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
    return { email: state.email, premium: cached.premium, reason: cached.premium ? 'Using offline entitlement.' : reason };
  }
}

async function withAccessToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
  let state = await getBillingState();
  if (!state.accessToken) {
    await refreshSession();
    state = await getBillingState();
  }
  if (!state.accessToken) throw new Error('Sign in first.');
  try {
    return await call(state.accessToken);
  } catch (error) {
    if (!(error instanceof Error) || !/401|token|Authentication/i.test(error.message)) throw error;
    await refreshSession();
    state = await getBillingState();
    if (!state.accessToken) throw error;
    return call(state.accessToken);
  }
}

async function getStatus() {
  const state = await getBillingState();
  const verified = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
  if (verified.shouldRefresh && state.refreshToken) void refreshSession();
  return {
    signedIn: Boolean(state.refreshToken && state.email),
    email: state.email,
    premium: verified.premium,
    entitlement: verified.payload,
    reason: verified.reason ?? state.lastError,
    deviceId: state.deviceId,
  };
}

async function handle(request: BillingRequest): Promise<unknown> {
  switch (request.type) {
    case 'billing:get-status':
      return getStatus();
    case 'billing:get-product':
      return api('/v1/billing/product');
    case 'billing:request-otp':
      return api('/v1/auth/request-otp', { method: 'POST', body: JSON.stringify({ email: request.email }) });
    case 'billing:verify-otp': {
      const state = await getBillingState();
      const tokens = await api<TokenResponse>('/v1/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: request.email, code: request.code, device_id: state.deviceId, device_name: request.deviceName }),
      });
      await updateBillingState({
        email: tokens.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        entitlementToken: tokens.entitlement_token,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      });
      // Sync settings from server
      try {
        const settingsRes = await api<{ settings_json?: string }>('/v1/settings', {}, tokens.access_token);
        if (settingsRes && settingsRes.settings_json) {
          const parsed = JSON.parse(settingsRes.settings_json);
          await browser.storage.local.set({ mediaAssistSettings: parsed });
        }
      } catch (error) {
        console.error('Failed to sync settings from server after sign-in:', error);
      }
      return getStatus();
    }

    case 'billing:refresh':
      await refreshSession();
      return getStatus();
    case 'billing:get-account':
      return withAccessToken((token) => api<AccountData>('/v1/account', {}, token).then(async (account) => {
        if (account.entitlement.entitlement_token) await updateBillingState({ entitlementToken: account.entitlement.entitlement_token, lastCheckedAt: Date.now(), lastError: undefined });
        return account;
      }));
    case 'billing:create-checkout':
      return withAccessToken((token) => api('/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ currency: request.currency }) }, token));
    case 'billing:remove-device':
      return withAccessToken((token) => api(`/v1/devices/${encodeURIComponent(request.deviceId)}`, { method: 'DELETE' }, token));
    case 'billing:sign-out': {
      const state = await getBillingState();
      if (state.refreshToken) {
        try {
          await api('/v1/auth/sign-out', { method: 'POST', body: JSON.stringify({ refresh_token: state.refreshToken, device_id: state.deviceId }) });
        } catch {
          // Local sign-out must still work when the server is temporarily unavailable.
        }
      }
      await clearBillingSession();
      return getStatus();
    }
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(ENTITLEMENT_REFRESH_ALARM, { periodInMinutes: ENTITLEMENT_REFRESH_MINUTES });
    void getBillingState();
  });
  browser.runtime.onStartup.addListener(() => void refreshSession());
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ENTITLEMENT_REFRESH_ALARM) void refreshSession();
  });

  // Sync settings changes to the server when updated locally (2s debounce)
  let uploadTimeout: any = null;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['mediaAssistSettings']?.newValue) {
      const nextSettings = changes['mediaAssistSettings'].newValue;
      if (uploadTimeout) clearTimeout(uploadTimeout);
      uploadTimeout = setTimeout(async () => {
        const state = await getBillingState();
        if (!state.accessToken || !state.email) return;
        try {
          await api('/v1/settings', {
            method: 'POST',
            body: JSON.stringify({ settings_json: JSON.stringify(nextSettings) }),
          }, state.accessToken);
        } catch (error) {
          console.error('Failed to upload settings to server:', error);
        }
      }, 2000);
    }
  });

  browser.runtime.onMessage.addListener((request: BillingRequest): Promise<BillingResponse> => handle(request)
    .then((data) => ({ ok: true, data }))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Request failed.' })));
});

