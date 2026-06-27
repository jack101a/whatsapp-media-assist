import { browser } from 'wxt/browser';
import type { MediaProfile } from '../types/profile';
import type { ImageFormat, MergeLayout } from '../types/media';

export type CropRatio = 'free' | 'original' | '1:1' | '3:4' | '4:3' | '16:9';

export interface AppSettings {
  enabled: boolean;
  theme: 'system' | 'dark' | 'light';

  showToolbarLabels: boolean;
  showRotateControls: boolean;
  autoOpenMergeWorkspace: boolean;
  toolbarLocked: boolean;
  toolbarOffsetX: number;
  toolbarOffsetY: number;

  defaultFilenameTemplate: string;
  defaultFormat: ImageFormat;
  defaultMaxKB?: number;
  defaultMinKB?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultQuality: number;
  minimumQuality: number;
  allowDimensionReduction: boolean;
  allowUpscale: boolean;
  defaultResizeFit: 'contain' | 'cover' | 'stretch';
  defaultCropRatio: CropRatio;
  removeSpacesByDefault: boolean;
  removeSpecialCharactersByDefault: boolean;

  mergeDefaultLayout: MergeLayout;
  mergeDefaultFormat: ImageFormat | 'pdf';
  mergeDefaultMaxKB?: number;
  mergeDefaultQuality: number;
  mergeDefaultGap: number;
  mergeDefaultPadding: number;
  mergeDefaultBorderWidth: number;
  mergeDefaultBorderColor: string;
  mergeDefaultBackground: string;
  mergeDefaultGridColumns: number;

  profiles: MediaProfile[];
  onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  enabled: true,
  theme: 'system',

  showToolbarLabels: true,
  showRotateControls: true,
  autoOpenMergeWorkspace: false,
  toolbarLocked: false,
  toolbarOffsetX: 0,
  toolbarOffsetY: 0,

  defaultFilenameTemplate: '{datetime}',
  defaultFormat: 'jpeg',
  defaultMaxKB: 180,
  defaultMinKB: undefined,
  defaultWidth: undefined,
  defaultHeight: undefined,
  defaultQuality: 90,
  minimumQuality: 35,
  allowDimensionReduction: true,
  allowUpscale: true,
  defaultResizeFit: 'contain',
  defaultCropRatio: 'free',
  removeSpacesByDefault: false,
  removeSpecialCharactersByDefault: true,

  mergeDefaultLayout: 'vertical',
  mergeDefaultFormat: 'jpeg',
  mergeDefaultMaxKB: 480,
  mergeDefaultQuality: 90,
  mergeDefaultGap: 36,
  mergeDefaultPadding: 72,
  mergeDefaultBorderWidth: 3,
  mergeDefaultBorderColor: '#d6d9dc',
  mergeDefaultBackground: '#ffffff',
  mergeDefaultGridColumns: 2,

  profiles: [],
  onboardingComplete: false,
};

export const SETTINGS_KEY = 'mediaAssistSettings';

function normalizeLayout(value: unknown): MergeLayout {
  if (value === 'horizontal' || value === 'grid') return value;
  return 'vertical';
}

export function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(input ?? {}) } as AppSettings;
  if (input?.autoOpenMergeWorkspace === true) merged.autoOpenMergeWorkspace = false;
  if (input?.defaultMaxKB === 200) merged.defaultMaxKB = DEFAULT_SETTINGS.defaultMaxKB;
  if (input?.defaultQuality === 92) merged.defaultQuality = DEFAULT_SETTINGS.defaultQuality;
  if (input?.mergeDefaultFormat === 'pdf') merged.mergeDefaultFormat = DEFAULT_SETTINGS.mergeDefaultFormat;
  if (input?.mergeDefaultMaxKB === 500) merged.mergeDefaultMaxKB = DEFAULT_SETTINGS.mergeDefaultMaxKB;
  merged.mergeDefaultLayout = normalizeLayout(input?.mergeDefaultLayout);
  merged.defaultQuality = Math.max(35, Math.min(100, Number(merged.defaultQuality) || DEFAULT_SETTINGS.defaultQuality));
  merged.minimumQuality = Math.max(20, Math.min(90, Number(merged.minimumQuality) || DEFAULT_SETTINGS.minimumQuality));
  merged.mergeDefaultQuality = Math.max(35, Math.min(100, Number(merged.mergeDefaultQuality) || DEFAULT_SETTINGS.mergeDefaultQuality));
  merged.toolbarLocked = Boolean(merged.toolbarLocked);
  merged.toolbarOffsetX = Math.max(-1200, Math.min(1200, Number(merged.toolbarOffsetX) || 0));
  merged.toolbarOffsetY = Math.max(-1200, Math.min(1200, Number(merged.toolbarOffsetY) || 0));
  merged.mergeDefaultGridColumns = Math.max(1, Math.min(6, Number(merged.mergeDefaultGridColumns) || 2));
  merged.mergeDefaultPadding = Math.max(0, Math.min(400, Number(merged.mergeDefaultPadding) || 0));
  merged.mergeDefaultGap = Math.max(0, Math.min(300, Number(merged.mergeDefaultGap) || 0));
  merged.mergeDefaultBorderWidth = Math.max(0, Math.min(24, Number(merged.mergeDefaultBorderWidth) || 0));
  merged.profiles = Array.isArray(merged.profiles)
    ? merged.profiles.map((profile: any) => {
        if (Array.isArray(profile.steps)) {
          return {
            ...profile,
            inputCount: Math.max(1, Math.min(20, Number(profile.inputCount) || 1)),
            mergeLayout: normalizeLayout(profile.mergeLayout),
          };
        }
        const steps: import('../types/profile').PipelineStep[] = [];
        if (profile.cropRatio) steps.push({ id: crypto.randomUUID(), type: 'crop', mode: 'preset', ratio: profile.cropRatio });
        if (profile.width || profile.height) steps.push({ id: crypto.randomUUID(), type: 'resize', width: profile.width, height: profile.height, fit: 'contain', allowUpscale: true });
        steps.push({ id: crypto.randomUUID(), type: 'format', format: profile.format ?? 'jpeg' });
        if (profile.minKB || profile.maxKB) steps.push({ id: crypto.randomUUID(), type: 'compress', minKB: profile.minKB, maxKB: profile.maxKB });
        steps.push({ id: crypto.randomUUID(), type: 'filename', preset: 'advanced', template: profile.filenameTemplate ?? '{datetime}', removeSpaces: Boolean(profile.removeSpaces), removeSpecialCharacters: profile.removeSpecialCharacters !== false });
        steps.push({ id: crypto.randomUUID(), type: 'download', automatic: profile.autoDownload !== false });
        return {
          id: profile.id ?? crypto.randomUUID(),
          name: profile.name ?? 'Pipeline',
          pinned: profile.pinned !== false,
          inputCount: Math.max(1, Math.min(20, Number(profile.requiredInputs) || 1)),
          mergeLayout: normalizeLayout(profile.layout),
          background: profile.background ?? '#ffffff',
          steps,
          createdAt: profile.createdAt ?? Date.now(),
          updatedAt: profile.updatedAt ?? Date.now(),
        };
      })
    : [];
  return merged;
}

export async function getSettings(): Promise<AppSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as Partial<AppSettings> | undefined);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await saveSettings(next);
  return next;
}

export function watchSettings(callback: (settings: AppSettings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[SETTINGS_KEY]?.newValue) {
      callback(normalizeSettings(changes[SETTINGS_KEY]!.newValue as Partial<AppSettings>));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
