import { browser } from 'wxt/browser';
import { API_BASE_URL, ENTITLEMENT_REFRESH_ALARM, ENTITLEMENT_REFRESH_MINUTES } from '../src/billing/config';
import type { BillingRequest, BillingResponse } from '../src/billing/messages';
import { clearBillingSession, getBillingState, updateBillingState } from '../src/billing/storage';
import { verifyEntitlementToken } from '../src/billing/entitlement';
import type { AccountData, SettingsSyncData } from '../src/billing/types';
import { getSettings, normalizeSettings, saveSettings, SETTINGS_KEY, type AppSettings } from '../src/storage/settings';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  entitlement_token?: string;
  email: string;
  settings_sync?: SettingsSyncData;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly payload?: unknown) {
    super(message);
  }
}

let applyingRemoteSettings = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInFlight: Promise<void> | null = null;
let settingsGeneration = 0;

async function api<T>(path: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store', credentials: 'omit' });
  const payload = await response.json().catch(() => ({})) as { detail?: string | { message?: string } } & T;
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : payload.detail?.message;
    throw new ApiError(response.status, detail ?? `Request failed (${response.status})`, payload);
  }
  return payload;
}

async function applyRemoteSettings(sync: SettingsSyncData): Promise<void> {
  if (!sync.settings) {
    await updateBillingState({ settingsRevision: sync.revision, settingsSyncPending: false, lastSettingsSyncAt: Date.now() });
    return;
  }
  applyingRemoteSettings = true;
  try {
    await saveSettings(normalizeSettings(sync.settings as Partial<AppSettings>));
    await updateBillingState({ settingsRevision: sync.revision, settingsSyncPending: false, lastSettingsSyncAt: Date.now() });
  } finally {
    applyingRemoteSettings = false;
  }
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
    if (error instanceof ApiError && error.status === 401) {
      await clearBillingSession();
      return { premium: false, reason: 'This account was signed in on another device.' };
    }
    await updateBillingState({ lastCheckedAt: Date.now(), lastError: reason });
    const cached = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
    return { email: state.email, premium: cached.premium, reason: cached.premium ? 'Using short offline access.' : reason };
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
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    await refreshSession();
    state = await getBillingState();
    if (!state.accessToken) throw error;
    return call(state.accessToken);
  }
}

async function uploadSettings(): Promise<void> {
  const state = await getBillingState();
  if (!state.refreshToken || !state.settingsSyncPending) return;
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const uploadGeneration = settingsGeneration;
    const settings = await getSettings();
    try {
      const result = await withAccessToken((token) => api<SettingsSyncData>('/v1/settings', {
        method: 'PUT',
        body: JSON.stringify({ expected_revision: state.settingsRevision ?? 0, settings }),
      }, token));
      const changedDuringUpload = settingsGeneration !== uploadGeneration;
      await updateBillingState({ settingsRevision: result.revision, settingsSyncPending: changedDuringUpload, lastSettingsSyncAt: Date.now(), lastError: undefined });
      if (changedDuringUpload) armSettingsUpload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const remote = await withAccessToken((token) => api<SettingsSyncData>('/v1/settings', {}, token));
        await applyRemoteSettings(remote);
        return;
      }
      await updateBillingState({ settingsSyncPending: true, lastError: error instanceof Error ? error.message : 'Settings sync failed.' });
      throw error;
    }
  })().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

function armSettingsUpload(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void uploadSettings().catch(() => undefined);
  }, 1200);
}

function scheduleSettingsUpload(): void {
  settingsGeneration += 1;
  void updateBillingState({ settingsSyncPending: true }).then(armSettingsUpload);
}

async function hydrateAfterLogin(tokens: TokenResponse): Promise<void> {
  const local = await getSettings();
  await updateBillingState({
    email: tokens.email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    entitlementToken: tokens.entitlement_token,
    settingsRevision: tokens.settings_sync?.revision ?? 0,
    settingsSyncPending: false,
    lastCheckedAt: Date.now(),
    lastError: undefined,
  });
  if (tokens.settings_sync?.settings) {
    await applyRemoteSettings(tokens.settings_sync);
  } else {
    await updateBillingState({ settingsSyncPending: true });
    const result = await withAccessToken((token) => api<SettingsSyncData>('/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: tokens.settings_sync?.revision ?? 0, settings: local }),
    }, token));
    await updateBillingState({ settingsRevision: result.revision, settingsSyncPending: false, lastSettingsSyncAt: Date.now() });
  }
}

async function verifyPremiumOnline() {
  try {
    const account = await withAccessToken((token) => api<AccountData>('/v1/account', {}, token));
    if (account.entitlement.entitlement_token) {
      await updateBillingState({
        entitlementToken: account.entitlement.entitlement_token,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      });
    }
    const state = await getBillingState();
    const verified = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
    return { premium: verified.premium, reason: verified.reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Online entitlement check failed.';
    const state = await getBillingState();
    if (!state.refreshToken || (error instanceof ApiError && error.status === 401)) {
      await clearBillingSession();
      return { premium: false, reason: 'This account is active on another device.' };
    }
    await updateBillingState({ lastError: reason });
    return { premium: false, reason };
  }
}

async function getStatus() {
  const state = await getBillingState();
  const verified = await verifyEntitlementToken(state.entitlementToken, state.deviceId);
  if (verified.shouldRefresh && state.refreshToken) void refreshSession();
  if (state.settingsSyncPending && state.refreshToken) void uploadSettings().catch(() => undefined);
  return {
    signedIn: Boolean(state.refreshToken && state.email),
    email: state.email,
    premium: verified.premium,
    entitlement: verified.payload,
    reason: verified.reason ?? state.lastError,
    deviceId: state.deviceId,
    settingsRevision: state.settingsRevision ?? 0,
    settingsSyncPending: Boolean(state.settingsSyncPending),
    lastSettingsSyncAt: state.lastSettingsSyncAt,
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
      await hydrateAfterLogin(tokens);
      return getStatus();
    }
    case 'billing:refresh':
      await refreshSession();
      await uploadSettings().catch(() => undefined);
      return getStatus();
    case 'billing:get-templates': {
      const status = await getStatus();
      if (!status.premium) throw new ApiError(403, status.reason || 'Pro is required to sync preset templates');
      return withAccessToken((token) => api<{id: string; name: string; category: string; payload: Record<string, unknown>}[]>('/v1/templates', {}, token));
    }
    case 'billing:verify-online':
      return verifyPremiumOnline();
    case 'billing:get-account':
      return withAccessToken((token) => api<AccountData>('/v1/account', {}, token).then(async (account) => {
        if (account.entitlement.entitlement_token) await updateBillingState({ entitlementToken: account.entitlement.entitlement_token, lastCheckedAt: Date.now(), lastError: undefined });
        const currentState = await getBillingState();
        if (account.settings_sync.revision > (currentState.settingsRevision ?? 0)) await applyRemoteSettings(account.settings_sync);
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
          // Local sign-out must still work when the server is unavailable.
        }
      }
      await clearBillingSession();
      const settings = await getSettings();
      await saveSettings({ ...settings, profiles: [] });
      return getStatus();
    }
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(ENTITLEMENT_REFRESH_ALARM, { periodInMinutes: ENTITLEMENT_REFRESH_MINUTES });
    void getBillingState();
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshSession().then(() => uploadSettings()).catch(() => undefined);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ENTITLEMENT_REFRESH_ALARM) void refreshSession().then(() => uploadSettings()).catch(() => undefined);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]?.newValue && !applyingRemoteSettings) scheduleSettingsUpload();
  });
  browser.runtime.onMessage.addListener((request: BillingRequest): Promise<BillingResponse> => handle(request)
    .then((data) => ({ ok: true, data }))
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Request failed.' })));
});
