import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { getSettings, saveSettings, type AppSettings, watchSettings } from '../storage/settings';
import type { CanvasOperation, ImageFormat, MergeItem, MergeLayout, NormalizedCrop, ResizeSettings } from '../types/media';
import type { FilenamePreset, MediaProfile, PipelineStep } from '../types/profile';
import { processCanvasPipeline, processImage, PrivacySourceError } from '../engine/canvas';
import { downloadBlob } from '../engine/download';
import { captureActiveMedia } from '../whatsapp/local-media';
import { compressPdfLocally, mergeMedia, rasterizePdfForMerge, terminateProcessor } from '../engine/processor-client';
import { findActiveMedia, refreshActiveMedia, type ActiveMedia } from '../whatsapp/media-detector';
import { formatBytes, kbToBytes } from '../utils/bytes';
import { renderFilename, withExtension } from '../utils/filename';
import { createId } from '../utils/id';
import { Icon } from './Icon';
import { getBillingState, watchBillingState } from '../billing/storage';
import { verifyEntitlementToken } from '../billing/entitlement';

type Rotation = 0 | 90 | 180 | 270;
type QuickPanel = 'resize' | 'compress' | 'pdf-compress' | null;
interface ToastItem { id: string; message: string; error?: boolean }
interface TransformState { rotation: Rotation; crop?: NormalizedCrop; resize?: ResizeSettings }
interface ProfileSession { profile: MediaProfile; items: MergeItem[] }
interface PendingPipeline { profile: MediaProfile; source: Blob }
interface ServerTemplate { id: string; name: string; category: string; payload: Partial<AppSettings> }

const EMPTY_TRANSFORM: TransformState = { rotation: 0 };
const STANDARD_IMAGE_FORMAT: ImageFormat = 'jpeg';
const STANDARD_IMAGE_QUALITY = 0.96;
const STANDARD_MINIMUM_QUALITY = 0.9;
const FILENAME_TEMPLATE_KEYS: (keyof AppSettings)[] = [
  'defaultFilenameTemplate',
  'removeSpacesByDefault',
  'removeSpecialCharactersByDefault',
];
const CROP_TEMPLATE_KEYS: (keyof AppSettings)[] = [
  'defaultCropRatio',
];
const RESIZE_TEMPLATE_KEYS: (keyof AppSettings)[] = [
  'defaultWidth',
  'defaultHeight',
  'allowUpscale',
  'defaultResizeFit',
];
const COMPRESS_TEMPLATE_KEYS: (keyof AppSettings)[] = [
  'defaultFormat',
  'defaultMaxKB',
  'defaultMinKB',
  'defaultQuality',
  'minimumQuality',
  'allowDimensionReduction',
];
const MERGE_TEMPLATE_KEYS: (keyof AppSettings)[] = [
  'mergeDefaultLayout',
  'mergeDefaultFormat',
  'mergeDefaultMaxKB',
  'mergeDefaultQuality',
  'mergeDefaultGap',
  'mergeDefaultPadding',
  'mergeDefaultBorderWidth',
  'mergeDefaultBorderColor',
  'mergeDefaultBackground',
  'mergeDefaultGridColumns',
];

function clampQualityPercent(value: number | undefined, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return Math.max(35, Math.min(100, fallback));
  return Math.max(35, Math.min(100, next));
}

function clampToolbarOffset(value: number): number {
  return Math.max(-1200, Math.min(1200, Math.round(value)));
}

function whatsappStyleFilename(kind: ActiveMedia['kind'], format: ImageFormat | 'pdf'): string {
  const stamp = new Date()
    .toLocaleString('en-CA', { hour12: false })
    .replace(',', ' at')
    .replace(/\//g, '-')
    .replace(/:/g, '.');
  return withExtension(`WhatsApp ${kind === 'pdf' ? 'Document' : 'Image'} ${stamp}`, format);
}

function pickSettingsPatch(payload: Partial<AppSettings>, keys: (keyof AppSettings)[]): Partial<AppSettings> {
  return keys.reduce<Partial<AppSettings>>((patch, key) => {
    if (payload[key] !== undefined) (patch as Record<string, unknown>)[key] = payload[key];
    return patch;
  }, {});
}

function templateKeysForPreset(presetKey?: 'defaultCropPresetId' | 'defaultResizePresetId' | 'defaultCompressPresetId'): (keyof AppSettings)[] {
  if (presetKey === 'defaultCropPresetId') return CROP_TEMPLATE_KEYS;
  if (presetKey === 'defaultResizePresetId') return RESIZE_TEMPLATE_KEYS;
  if (presetKey === 'defaultCompressPresetId') return COMPRESS_TEMPLATE_KEYS;
  return FILENAME_TEMPLATE_KEYS;
}

function useSettingsState() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    void getSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);
  return settings;
}

function usePremiumState() {
  const [premium, setPremium] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const billing = await getBillingState();
      const status = await verifyEntitlementToken(billing.entitlementToken, billing.deviceId);
      if (active) setPremium(status.premium);
    };
    void refresh();
    const unwatch = watchBillingState(() => void refresh());
    return () => { active = false; unwatch(); };
  }, []);
  return premium;
}

function stepOf<T extends PipelineStep['type']>(profile: MediaProfile, type: T): Extract<PipelineStep, { type: T }> | undefined {
  return profile.steps.find((step): step is Extract<PipelineStep, { type: T }> => step.type === type);
}

function presetTemplate(preset: FilenamePreset, custom: string): string {
  if (preset === 'original') return '{original}';
  if (preset === 'datetime') return '{datetime}';
  if (preset === 'date-counter') return '{date}_{counter}';
  if (preset === 'profile-datetime') return '{profile}_{datetime}';
  if (preset === 'prefix-datetime') return '{prefix}_{datetime}';
  if (preset === 'dimensions-date') return '{width}x{height}_{date}';
  return custom || '{profile}_{datetime}_{counter}';
}

function useBlobUrl(blob: Blob) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}

function containRect(container: DOMRect, width: number, height: number): DOMRect {
  const scale = Math.min(container.width / Math.max(1, width), container.height / Math.max(1, height));
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  return new DOMRect(
    container.left + (container.width - outputWidth) / 2,
    container.top + (container.height - outputHeight) / 2,
    outputWidth,
    outputHeight,
  );
}

function clipRectToViewport(rect: DOMRect): DOMRect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return rect;
  return new DOMRect(left, top, right - left, bottom - top);
}

function cropFromVisibleRect(crop: NormalizedCrop, visibleRect: DOMRect, sourceRect: DOMRect): NormalizedCrop {
  const left = visibleRect.left + crop.x * visibleRect.width;
  const top = visibleRect.top + crop.y * visibleRect.height;
  const right = left + crop.width * visibleRect.width;
  const bottom = top + crop.height * visibleRect.height;
  const x = Math.max(0, Math.min(1, (left - sourceRect.left) / Math.max(1, sourceRect.width)));
  const y = Math.max(0, Math.min(1, (top - sourceRect.top) / Math.max(1, sourceRect.height)));
  const cropRight = Math.max(0, Math.min(1, (right - sourceRect.left) / Math.max(1, sourceRect.width)));
  const cropBottom = Math.max(0, Math.min(1, (bottom - sourceRect.top) / Math.max(1, sourceRect.height)));
  return { x, y, width: Math.max(0.005, cropRight - x), height: Math.max(0.005, cropBottom - y) };
}

function pipelineTag(profile: MediaProfile): string {
  const explicit = profile.tag?.trim();
  if (explicit) return explicit.slice(0, 8);
  const initials = profile.name.split(/\s+/).map((part) => part[0]).join('').toUpperCase();
  return (initials || profile.name || 'PIPE').slice(0, 5);
}

function transformedDimensions(image: HTMLImageElement, rotation: Rotation) {
  return rotation === 90 || rotation === 270
    ? { width: image.naturalHeight, height: image.naturalWidth }
    : { width: image.naturalWidth, height: image.naturalHeight };
}

function PreviewCanvas({ media, transform }: { media: ActiveMedia; transform: TransformState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = media.kind === 'image' && (transform.rotation !== 0 || Boolean(transform.crop));

  useEffect(() => {
    if (media.kind !== 'image' || !active) return;
    const image = media.element;
    const previousOpacity = image.style.opacity;
    image.style.opacity = '0';
    return () => { image.style.opacity = previousOpacity; };
  }, [media, active]);

  useEffect(() => {
    if (media.kind !== 'image' || !active || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const cssWidth = Math.max(1, Math.round(media.rect.width));
    const cssHeight = Math.max(1, Math.round(media.rect.height));
    canvas.width = cssWidth;
    canvas.height = cssHeight;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    context.clearRect(0, 0, cssWidth, cssHeight);

    const sourceWidth = media.element.naturalWidth;
    const sourceHeight = media.element.naturalHeight;
    const rotatedWidth = transform.rotation === 90 || transform.rotation === 270 ? sourceHeight : sourceWidth;
    const rotatedHeight = transform.rotation === 90 || transform.rotation === 270 ? sourceWidth : sourceHeight;
    const previewScale = Math.min(1, 1600 / Math.max(rotatedWidth, rotatedHeight));
    const temp = document.createElement('canvas');
    temp.width = Math.max(1, Math.round(rotatedWidth * previewScale));
    temp.height = Math.max(1, Math.round(rotatedHeight * previewScale));
    const tempContext = temp.getContext('2d', { alpha: true });
    if (!tempContext) return;
    tempContext.imageSmoothingEnabled = true;
    tempContext.imageSmoothingQuality = 'high';
    tempContext.translate(temp.width / 2, temp.height / 2);
    tempContext.rotate((transform.rotation * Math.PI) / 180);
    const drawWidth = sourceWidth * previewScale;
    const drawHeight = sourceHeight * previewScale;
    tempContext.drawImage(media.element, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

    const crop = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const sx = Math.round(crop.x * temp.width);
    const sy = Math.round(crop.y * temp.height);
    const sw = Math.max(1, Math.round(crop.width * temp.width));
    const sh = Math.max(1, Math.round(crop.height * temp.height));
    const scale = Math.min(cssWidth / sw, cssHeight / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    context.drawImage(temp, sx, sy, sw, sh, (cssWidth - dw) / 2, (cssHeight - dh) / 2, dw, dh);
    temp.width = 1;
    temp.height = 1;
  }, [media, transform, active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="ma-live-preview" style={{ left: media.rect.left, top: media.rect.top, width: media.rect.width, height: media.rect.height }} />;
}

function CropOverlay({ imageRect, sourceRect, initial, onCancel, onConfirm, templates, defaultTemplateId, onApplyTemplate }: {
  imageRect: DOMRect;
  sourceRect: DOMRect;
  initial?: NormalizedCrop;
  onCancel: () => void;
  onConfirm: (crop: NormalizedCrop) => void;
  templates?: ServerTemplate[];
  defaultTemplateId?: string;
  onApplyTemplate?: (templateId: string) => void;
}) {
  const [crop, setCrop] = useState<NormalizedCrop>(initial ?? { x: 0.06, y: 0.06, width: 0.88, height: 0.88 });
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplateId ?? '');
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; start: NormalizedCrop } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      const dx = (event.clientX - drag.current.startX) / imageRect.width;
      const dy = (event.clientY - drag.current.startY) / imageRect.height;
      const start = drag.current.start;
      const minimum = 0.04;
      let next = { ...start };
      if (drag.current.mode === 'move') {
        next.x = Math.max(0, Math.min(1 - start.width, start.x + dx));
        next.y = Math.max(0, Math.min(1 - start.height, start.y + dy));
      } else {
        const left = drag.current.mode.includes('w') ? Math.max(0, Math.min(start.x + start.width - minimum, start.x + dx)) : start.x;
        const right = drag.current.mode.includes('e') ? Math.min(1, Math.max(start.x + minimum, start.x + start.width + dx)) : start.x + start.width;
        const top = drag.current.mode.includes('n') ? Math.max(0, Math.min(start.y + start.height - minimum, start.y + dy)) : start.y;
        const bottom = drag.current.mode.includes('s') ? Math.min(1, Math.max(start.y + minimum, start.y + start.height + dy)) : start.y + start.height;
        next = { x: left, y: top, width: right - left, height: bottom - top };
      }
      setCrop(next);
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [imageRect]);

  const begin = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se', event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = { mode, startX: event.clientX, startY: event.clientY, start: crop };
  };

  const applyTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates?.find((item) => item.id === templateId);
    if (!template) return;
    onApplyTemplate?.(templateId);
    const ratioValue = template.payload.defaultCropRatio;
    if (!ratioValue || ratioValue === 'free' || ratioValue === 'original') return;
    const [rw, rh] = String(ratioValue).split(':').map(Number);
    if (!rw || !rh) return;
    const target = rw / rh;
    const displayRatio = imageRect.width / imageRect.height;
    const width = target > displayRatio ? 0.92 : Math.min(0.92, 0.92 * target / displayRatio);
    const height = target > displayRatio ? Math.min(0.92, 0.92 * displayRatio / target) : 0.92;
    setCrop({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  };

  const boxStyle = {
    left: imageRect.left + crop.x * imageRect.width,
    top: imageRect.top + crop.y * imageRect.height,
    width: crop.width * imageRect.width,
    height: crop.height * imageRect.height,
    '--crop-width': `${crop.width * imageRect.width}px`,
    '--crop-height': `${crop.height * imageRect.height}px`,
  } as React.CSSProperties;

  return <div className="ma-crop-mask">
    <div className="ma-crop-box" style={boxStyle} onPointerDown={(event) => begin('move', event)}>
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => <span key={corner} className={`ma-handle ${corner}`} onPointerDown={(event) => begin(corner, event)} />)}
    </div>
    <div className="ma-crop-controls">
      {!!templates?.length && <select className="ma-compact-select" aria-label="Crop presets" value={selectedTemplateId} onChange={(event) => applyTemplate(event.target.value)}><option value="">Crop preset</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>}
      <button className="ma-compact-btn" onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}>Reset</button>
      <button className="ma-compact-btn" onClick={onCancel}>Cancel</button>
      <button className="ma-compact-btn primary" onClick={() => onConfirm(cropFromVisibleRect(crop, imageRect, sourceRect))}><Icon name="check" />Apply</button>
    </div>
  </div>;
}

function QuickPanelCard({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <section className="ma-quick-panel" role="dialog" aria-label={title}>
    <header><strong>{title}</strong><button className="ma-icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button></header>
    {children}
  </section>;
}

function ResizePanel({ settings, current, onApply, onClose, busy, templates, defaultTemplateId, onApplyTemplate }: {
  settings: AppSettings;
  current?: ResizeSettings;
  onApply: (resize?: ResizeSettings) => void;
  onClose: () => void;
  busy: boolean;
  templates?: ServerTemplate[];
  defaultTemplateId?: string;
  onApplyTemplate?: (templateId: string) => void;
}) {
  const [width, setWidth] = useState(String(current?.width ?? settings.defaultWidth ?? ''));
  const [height, setHeight] = useState(String(current?.height ?? settings.defaultHeight ?? ''));
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplateId ?? '');
  const applyTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates?.find((item) => item.id === templateId);
    if (!template) return;
    setWidth(String(template.payload.defaultWidth ?? ''));
    setHeight(String(template.payload.defaultHeight ?? ''));
    onApplyTemplate?.(templateId);
  };
  return <QuickPanelCard title="Resize" onClose={onClose}>
    {!!templates?.length && <label className="ma-single-field">Preset<select value={selectedTemplateId} onChange={(event) => applyTemplate(event.target.value)}><option value="">Choose resize preset</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}
    <div className="ma-mini-grid"><label>Width<input value={width} inputMode="numeric" onChange={(event) => setWidth(event.target.value.replace(/\D/g, ''))} placeholder="Original" /></label><label>Height<input value={height} inputMode="numeric" onChange={(event) => setHeight(event.target.value.replace(/\D/g, ''))} placeholder="Auto" /></label></div>
    <div className="ma-panel-actions"><button className="ma-compact-btn" disabled={busy} onClick={() => { onApply(undefined); onClose(); }}>Reset</button><button className="ma-compact-btn primary" disabled={busy} onClick={() => { onApply(width || height ? { width: width ? Number(width) : undefined, height: height ? Number(height) : undefined, maintainAspectRatio: true, allowUpscale: settings.allowUpscale, fit: settings.defaultResizeFit } : undefined); onClose(); }}>{busy ? 'Working...' : 'Apply'}</button></div>
  </QuickPanelCard>;
}

function CompressPanel({ settings, onDownload, onClose, busy, templates, defaultTemplateId, onApplyTemplate }: {
  settings: AppSettings;
  onDownload: (maxKB: number | undefined, format: ImageFormat, quality: number) => void;
  onClose: () => void;
  busy: boolean;
  templates?: ServerTemplate[];
  defaultTemplateId?: string;
  onApplyTemplate?: (templateId: string) => void;
}) {
  const [maxKB, setMaxKB] = useState(String(settings.defaultMaxKB ?? ''));
  const [format, setFormat] = useState<ImageFormat>(settings.defaultFormat);
  const [quality, setQuality] = useState(String(settings.defaultQuality));
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplateId ?? '');
  const applyTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates?.find((item) => item.id === templateId);
    if (!template) return;
    setMaxKB(String(template.payload.defaultMaxKB ?? ''));
    if (template.payload.defaultFormat) setFormat(template.payload.defaultFormat);
    setQuality(String(template.payload.defaultQuality ?? settings.defaultQuality));
    onApplyTemplate?.(templateId);
  };
  return <QuickPanelCard title="Compress" onClose={onClose}>
    {!!templates?.length && <label className="ma-single-field">Preset<select value={selectedTemplateId} onChange={(event) => applyTemplate(event.target.value)}><option value="">Choose compression preset</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}
    <div className="ma-mini-grid"><label>Max KB<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label><label>Format<select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label><label>Quality %<input value={quality} inputMode="numeric" onChange={(event) => setQuality(event.target.value.replace(/\D/g, ''))} placeholder="90" /></label></div>
    <div className="ma-panel-actions"><button className="ma-compact-btn primary" disabled={busy} onClick={() => onDownload(maxKB ? Number(maxKB) : undefined, format, clampQualityPercent(quality ? Number(quality) : undefined, settings.defaultQuality))}><Icon name="download" />{busy ? 'Working...' : 'Apply'}</button></div>
  </QuickPanelCard>;
}


function PdfCompressPanel({ settings, onDownload, onClose, busy }: {
  settings: AppSettings;
  onDownload: (maxKB: number | undefined, quality: number) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [maxKB, setMaxKB] = useState(String(settings.defaultMaxKB ?? ''));
  const [quality, setQuality] = useState(String(settings.defaultQuality));
  return <QuickPanelCard title="Compress PDF" onClose={onClose}>
    <div className="ma-mini-grid"><label>Target max KB<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label><label>Quality %<input value={quality} inputMode="numeric" onChange={(event) => setQuality(event.target.value.replace(/\D/g, ''))} placeholder="90" /></label></div>
    <p className="ma-panel-note">Pages are compressed locally and preserved as a multi-page PDF. Selectable text may be rasterised.</p>
    <div className="ma-panel-actions"><button className="ma-compact-btn primary" disabled={busy} onClick={() => onDownload(maxKB ? Number(maxKB) : undefined, clampQualityPercent(quality ? Number(quality) : undefined, settings.defaultQuality))}><Icon name="download" />{busy ? 'Working…' : 'Compress & download'}</button></div>
  </QuickPanelCard>;
}

function Modal({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return <div className="ma-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ma-modal" role="dialog" aria-modal="true" aria-label={title}>
      <header className="ma-modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="ma-icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
      <div className="ma-modal-body">{children}</div>
      {footer && <footer className="ma-modal-actions">{footer}</footer>}
    </section>
  </div>;
}

function PreviewItem({ item }: { item: MergeItem }) {
  const url = useBlobUrl(item.blob);
  const crop = item.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const imageStyle = {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    left: `${-(crop.x / crop.width) * 100}%`,
    top: `${-(crop.y / crop.height) * 100}%`,
    transform: `rotate(${item.rotation}deg)`,
  } as React.CSSProperties;
  return <div className="ma-preview-media"><img src={url} alt="" style={imageStyle} /></div>;
}

function A4Item({ item, selected, onSelect, onChange }: {
  item: MergeItem;
  selected: boolean;
  onSelect: () => void;
  onChange: (item: MergeItem) => void;
}) {
  const placement = item.placement ?? { offsetX: 0, offsetY: 0, scale: 1 };
  const drag = useRef<{ x: number; y: number; placement: typeof placement; width: number; height: number } | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      const dx = (event.clientX - drag.current.x) / Math.max(1, drag.current.width);
      const dy = (event.clientY - drag.current.y) / Math.max(1, drag.current.height);
      onChange({ ...item, placement: {
        ...drag.current.placement,
        offsetX: Math.max(-0.5, Math.min(0.5, drag.current.placement.offsetX + dx)),
        offsetY: Math.max(-0.5, Math.min(0.5, drag.current.placement.offsetY + dy)),
      } });
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [item, onChange]);

  return <div className={`ma-a4-item${selected ? ' selected' : ''}`} onClick={(event) => { event.stopPropagation(); onSelect(); }} onPointerDown={(event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, placement, width: rect?.width ?? 1, height: rect?.height ?? 1 };
    onSelect();
  }} style={{ transform: `translate(${placement.offsetX * 55}%, ${placement.offsetY * 55}%) scale(${placement.scale})` }}>
    <PreviewItem item={item} />
  </div>;
}

function MergeLayoutPreview({ items, layout, background, gap, padding, borderWidth, borderColor, gridColumns, selectedId, onSelect, onItemChange }: {
  items: MergeItem[];
  layout: MergeLayout;
  background: string;
  gap: number;
  padding: number;
  borderWidth: number;
  borderColor: string;
  gridColumns: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onItemChange: (item: MergeItem) => void;
}) {
  const style = {
    background,
    padding: `${Math.max(8, Math.min(50, padding / 5))}px`,
    gap: `${Math.max(3, Math.min(24, gap / 4))}px`,
    gridTemplateRows: layout === 'vertical' ? `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` : undefined,
    gridTemplateColumns: layout === 'horizontal'
      ? `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))`
      : layout === 'grid'
        ? `repeat(${Math.max(1, Math.min(6, gridColumns))}, minmax(0, 1fr))`
        : undefined,
  } as React.CSSProperties;
  return <div className="ma-a4-stage">
    <div className={`ma-a4-page ${layout}`} style={style} onClick={() => onSelect('')}>
      {items.map((item) => <div key={item.id} className="ma-a4-cell" style={{ borderWidth: Math.max(0, Math.min(8, borderWidth / 2)), borderColor }}>
        <A4Item item={item} selected={selectedId === item.id} onSelect={() => onSelect(item.id)} onChange={onItemChange} />
      </div>)}
    </div>
    <span className="ma-a4-caption">A4 portrait · drag an item to adjust its position</span>
  </div>;
}

function BlobCropEditor({ item, onCancel, onConfirm }: { item: MergeItem; onCancel: () => void; onConfirm: (crop: NormalizedCrop) => void }) {
  const url = useBlobUrl(item.blob);
  const imageRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const update = () => imageRef.current && setRect(imageRef.current.getBoundingClientRect());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return <div className="ma-blob-crop"><img ref={imageRef} src={url} alt="Crop selected item" onLoad={() => setRect(imageRef.current?.getBoundingClientRect() ?? null)} />{rect && <CropOverlay imageRect={rect} sourceRect={rect} initial={item.crop} onCancel={onCancel} onConfirm={onConfirm} />}</div>;
}

function MergeItemCard({ item, index, selected, onSelect, onChange, onRemove, onCrop, onDragStart, onDrop }: {
  item: MergeItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (item: MergeItem) => void;
  onRemove: () => void;
  onCrop: () => void;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
}) {
  const url = useBlobUrl(item.blob);
  return <article className={`ma-merge-item${selected ? ' selected' : ''}`} draggable onDragStart={() => onDragStart(index)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(index); }} onClick={onSelect}>
    <div className="ma-drag-handle" title="Drag to reorder">⋮⋮</div>
    <div className="ma-thumb-wrap"><img className="ma-thumb" src={url} alt={`Selected media ${index + 1}`} style={{ transform: `rotate(${item.rotation}deg)` }} /></div>
    <div className="ma-item-meta"><strong>{item.name}</strong><span>{item.sourceType === 'pdf-page' ? `PDF page ${item.pageNumber ?? ''}` : formatBytes(item.blob.size)}</span></div>
    <div className="ma-item-controls"><button title="Crop" onClick={(event) => { event.stopPropagation(); onCrop(); }}><Icon name="crop" size={15} /></button><button title="Rotate left" onClick={(event) => { event.stopPropagation(); onChange({ ...item, rotation: ((item.rotation + 270) % 360) as Rotation }); }}><Icon name="rotate-left" size={15} /></button><button title="Rotate right" onClick={(event) => { event.stopPropagation(); onChange({ ...item, rotation: ((item.rotation + 90) % 360) as Rotation }); }}><Icon name="rotate-right" size={15} /></button><button title="Remove" onClick={(event) => { event.stopPropagation(); onRemove(); }}><Icon name="trash" size={15} /></button></div>
  </article>;
}

function MergeWorkspace({ items, settings, onItemsChange, onClose, onToast, templates = [] }: {
  items: MergeItem[];
  settings: AppSettings;
  onItemsChange: (items: MergeItem[]) => void;
  onClose: () => void;
  onToast: (message: string, error?: boolean) => void;
  templates?: ServerTemplate[];
}) {
  const [layout, setLayout] = useState<MergeLayout>(settings.mergeDefaultLayout);
  const [format, setFormat] = useState<ImageFormat | 'pdf'>(settings.mergeDefaultFormat);
  const [maxKB, setMaxKB] = useState(String(settings.mergeDefaultMaxKB ?? ''));
  const [quality, setQuality] = useState(String(settings.mergeDefaultQuality));
  const [gap, setGap] = useState(String(settings.mergeDefaultGap));
  const [padding, setPadding] = useState(String(settings.mergeDefaultPadding));
  const [borderWidth, setBorderWidth] = useState(String(settings.mergeDefaultBorderWidth));
  const [borderColor, setBorderColor] = useState(settings.mergeDefaultBorderColor);
  const [gridColumns, setGridColumns] = useState(String(settings.mergeDefaultGridColumns));
  const [background, setBackground] = useState(settings.mergeDefaultBackground);
  const [filename, setFilename] = useState('merged_{datetime}');
  const [selectedTemplateId, setSelectedTemplateId] = useState(settings.defaultMergePresetId ?? '');
  const [processing, setProcessing] = useState(false);
  const [cropItem, setCropItem] = useState<MergeItem | null>(null);
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? '');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const allImages = items.every((item) => item.sourceType !== 'pdf-page');
  const selected = items.find((item) => item.id === selectedId);

  useEffect(() => {
    if (layout === 'grid' && !allImages) setLayout('vertical');
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? '');
  }, [items, layout, allImages, selectedId]);

  const updateItem = useCallback((next: MergeItem) => onItemsChange(items.map((item) => item.id === next.id ? next : item)), [items, onItemsChange]);
  const reorder = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) return setDragIndex(null);
    const next = [...items];
    const [moving] = next.splice(dragIndex, 1);
    if (moving) next.splice(targetIndex, 0, moving);
    onItemsChange(next);
    setDragIndex(null);
  };

  const addLocal = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const additions: MergeItem[] = [];
      for (const file of Array.from(files)) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pages = await rasterizePdfForMerge(file, file.name, `local:${file.name}:${file.size}`, (current, total) => onToast(`Reading ${file.name}: page ${current}/${total}`));
          additions.push(...pages);
        } else if (file.type.startsWith('image/')) {
          additions.push({ id: createId(), blob: file, name: file.name, rotation: 0, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceType: 'image', sourceKey: `local:${file.name}:${file.size}:${file.lastModified}` });
        }
      }
      if (!additions.length) return onToast('Choose image or PDF files.', true);
      const next = [...items, ...additions];
      onItemsChange(next);
      if (!selectedId && additions[0]) setSelectedId(additions[0].id);
      onToast(`${additions.length} item${additions.length === 1 ? '' : 's'} added.`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not add local file.', true);
    }
  };

  const applyMergeTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    const payload = template.payload;
    if (payload.mergeDefaultLayout === 'vertical' || payload.mergeDefaultLayout === 'horizontal' || payload.mergeDefaultLayout === 'grid') setLayout(payload.mergeDefaultLayout);
    if (payload.mergeDefaultFormat === 'pdf' || payload.mergeDefaultFormat === 'jpeg' || payload.mergeDefaultFormat === 'png' || payload.mergeDefaultFormat === 'webp') setFormat(payload.mergeDefaultFormat);
    if (payload.mergeDefaultMaxKB !== undefined) setMaxKB(String(payload.mergeDefaultMaxKB));
    if (payload.mergeDefaultQuality !== undefined) setQuality(String(payload.mergeDefaultQuality));
    if (payload.mergeDefaultGap !== undefined) setGap(String(payload.mergeDefaultGap));
    if (payload.mergeDefaultPadding !== undefined) setPadding(String(payload.mergeDefaultPadding));
    if (payload.mergeDefaultBorderWidth !== undefined) setBorderWidth(String(payload.mergeDefaultBorderWidth));
    if (typeof payload.mergeDefaultBorderColor === 'string') setBorderColor(payload.mergeDefaultBorderColor);
    if (typeof payload.mergeDefaultBackground === 'string') setBackground(payload.mergeDefaultBackground);
    if (payload.mergeDefaultGridColumns !== undefined) setGridColumns(String(payload.mergeDefaultGridColumns));
    void saveSettings({ ...settings, ...pickSettingsPatch(payload, MERGE_TEMPLATE_KEYS), defaultMergePresetId: template.id });
    onToast(`${template.name} preset applied.`);
  };

  const exportMerge = async () => {
    if (!items.length) return;
    if (layout === 'grid' && !allImages) return onToast('Grid layout is available only when every item is an image.', true);
    setProcessing(true);
    try {
      const blob = await mergeMedia(items, {
        layout,
        format,
        background,
        gap: Math.max(0, Number(gap) || 0),
        padding: Math.max(0, Number(padding) || 0),
        borderWidth: Math.max(0, Number(borderWidth) || 0),
        borderColor,
        gridColumns: Math.max(1, Math.min(6, Number(gridColumns) || 2)),
        quality: clampQualityPercent(quality ? Number(quality) : undefined, settings.mergeDefaultQuality) / 100,
        maxBytes: kbToBytes(maxKB ? Number(maxKB) : undefined),
      }, (_current, _total, note) => onToast(note));
      const safeName = renderFilename(filename, { format }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: true });
      await downloadBlob(blob, withExtension(safeName, format));
      onToast(`Downloaded A4 ${format.toUpperCase()} • ${formatBytes(blob.size)}`);
      onItemsChange([]);
      setSelectedId('');
      onClose();
      terminateProcessor();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Merge failed.', true);
    } finally {
      setProcessing(false);
    }
  };

  return <Modal title="A4 merge workspace" subtitle="Images and PDF pages stay in memory only while this tab is open" onClose={onClose} footer={<><button className="ma-compact-btn danger" onClick={() => { onItemsChange([]); setSelectedId(''); }}>Clear stack</button><button className="ma-compact-btn" onClick={onClose}>Close</button><button className="ma-compact-btn primary" disabled={!items.length || processing} onClick={() => void exportMerge()}><Icon name="download" />{processing ? 'Processing…' : 'Download A4'}</button></>}>
    <div className="ma-workspace-grid">
      <MergeLayoutPreview items={items} layout={layout} background={background} gap={Number(gap) || 0} padding={Number(padding) || 0} borderWidth={Number(borderWidth) || 0} borderColor={borderColor} gridColumns={Number(gridColumns) || 2} selectedId={selectedId} onSelect={setSelectedId} onItemChange={updateItem} />
      <aside className="ma-merge-sidebar">
        <div className="ma-layout-tabs"><button className={layout === 'vertical' ? 'active' : ''} onClick={() => setLayout('vertical')}>Top & bottom</button><button className={layout === 'horizontal' ? 'active' : ''} onClick={() => setLayout('horizontal')}>Side by side</button><button className={layout === 'grid' ? 'active' : ''} disabled={!allImages} title={!allImages ? 'Grid is available only for images' : ''} onClick={() => setLayout('grid')}>Grid</button></div>
        <div className="ma-merge-settings">{templates.length > 0 && <label className="wide">Preset<select value={selectedTemplateId} onChange={(event) => applyMergeTemplate(event.target.value)}><option value="">Choose merge preset</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>}<label>Output<select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat | 'pdf')}><option value="pdf">PDF</option><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label><label>Target max KB<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label><label>Quality %<input value={quality} inputMode="numeric" onChange={(event) => setQuality(event.target.value.replace(/\D/g, ''))} placeholder="90" /></label>{layout === 'grid' && <label>Grid columns<input value={gridColumns} inputMode="numeric" onChange={(event) => setGridColumns(event.target.value.replace(/\D/g, ''))} /></label>}<label>Gap<input value={gap} inputMode="numeric" onChange={(event) => setGap(event.target.value.replace(/\D/g, ''))} /></label><label>Page margin<input value={padding} inputMode="numeric" onChange={(event) => setPadding(event.target.value.replace(/\D/g, ''))} /></label><label>Border<input value={borderWidth} inputMode="numeric" onChange={(event) => setBorderWidth(event.target.value.replace(/\D/g, ''))} /></label><label>Page colour<input type="color" value={background} onChange={(event) => setBackground(event.target.value)} /></label><label>Border colour<input type="color" value={borderColor} onChange={(event) => setBorderColor(event.target.value)} /></label><label className="wide">Filename<input value={filename} onChange={(event) => setFilename(event.target.value)} /></label></div>
        {selected && <div className="ma-selected-controls"><strong>Selected item</strong><div><button onClick={() => setCropItem(selected)}><Icon name="crop" size={15} />Crop</button><button onClick={() => updateItem({ ...selected, rotation: ((selected.rotation + 270) % 360) as Rotation })}><Icon name="rotate-left" size={15} />Left</button><button onClick={() => updateItem({ ...selected, rotation: ((selected.rotation + 90) % 360) as Rotation })}><Icon name="rotate-right" size={15} />Right</button></div><label>Zoom <input type="range" min="60" max="160" value={Math.round((selected.placement?.scale ?? 1) * 100)} onChange={(event) => updateItem({ ...selected, placement: { ...(selected.placement ?? { offsetX: 0, offsetY: 0, scale: 1 }), scale: Number(event.target.value) / 100 } })} /></label><button className="ma-reset-position" onClick={() => updateItem({ ...selected, placement: { offsetX: 0, offsetY: 0, scale: 1 } })}>Reset position & zoom</button></div>}
      </aside>
    </div>
    <div className="ma-workspace-bar"><button className="ma-compact-btn" onClick={() => fileInput.current?.click()}><Icon name="plus" />Add local image/PDF</button><input ref={fileInput} hidden type="file" multiple accept="image/*,.pdf,application/pdf" onChange={(event) => { const input = event.currentTarget; void addLocal(input.files).finally(() => { input.value = ''; }); }} /><span>{items.length} item{items.length === 1 ? '' : 's'} in stack · drag cards to reorder</span></div>
    {items.length ? <div className="ma-merge-list">{items.map((item, index) => <MergeItemCard key={item.id} item={item} index={index} selected={selectedId === item.id} onSelect={() => setSelectedId(item.id)} onChange={updateItem} onCrop={() => setCropItem(item)} onRemove={() => onItemsChange(items.filter((entry) => entry.id !== item.id))} onDragStart={setDragIndex} onDrop={reorder} />)}</div> : <div className="ma-empty">Open an image or PDF and click + Add to merge.</div>}
    {cropItem && <BlobCropEditor item={cropItem} onCancel={() => setCropItem(null)} onConfirm={(crop) => { updateItem({ ...cropItem, crop }); setCropItem(null); }} />}
  </Modal>;
}

export function ContentApp() {
  const settings = useSettingsState();
  const premium = usePremiumState();
  const [media, setMedia] = useState<ActiveMedia | null>(null);
  const [transform, setTransform] = useState<TransformState>(EMPTY_TRANSFORM);
  const [cropMode, setCropMode] = useState(false);
  const [quickPanel, setQuickPanel] = useState<QuickPanel>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeItems, setMergeItems] = useState<MergeItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [profileSessions, setProfileSessions] = useState<Record<string, ProfileSession>>({});
  const [pendingPipeline, setPendingPipeline] = useState<PendingPipeline | null>(null);
  const [toolbarPreviewOffset, setToolbarPreviewOffset] = useState<{ x: number; y: number } | null>(null);
  const [serverTemplates, setServerTemplates] = useState<ServerTemplate[]>([]);
  const previousKey = useRef('');
  const mediaRef = useRef<ActiveMedia | null>(null);
  const missingSince = useRef<number | null>(null);
  const inactiveClearTimer = useRef<number | null>(null);

  const toast = useCallback((message: string, error = false) => {
    const id = createId();
    setToasts((current) => [...current, { id, message, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200);
  }, []);

  useEffect(() => {
    if (!settings?.enabled) {
      previousKey.current = '';
      mediaRef.current = null;
      missingSince.current = null;
      setMedia(null);
      setTransform(EMPTY_TRANSFORM);
      setCropMode(false);
      setQuickPanel(null);
      setMergeOpen(false);
      setMergeItems([]);
      setProfileSessions({});
      setPendingPipeline(null);
      terminateProcessor();
      return;
    }

    let frame = 0;
    let scanTimer: number | null = null;
    let lastScan = 0;
    let graceTimer: number | null = null;
    let closingHintUntil = 0;

    const resetViewerTools = () => {
      previousKey.current = '';
      mediaRef.current = null;
      setMedia(null);
      setTransform(EMPTY_TRANSFORM);
      setCropMode(false);
      setQuickPanel(null);
      setPendingPipeline(null);
    };

    const accept = (next: ActiveMedia) => {
      missingSince.current = null;
      closingHintUntil = 0;
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (inactiveClearTimer.current) {
        window.clearTimeout(inactiveClearTimer.current);
        inactiveClearTimer.current = null;
      }
      const changedMedia = next.key !== previousKey.current;
      const current = mediaRef.current;
      const rectChanged = !current
        || Math.abs(current.rect.left - next.rect.left) > 0.5
        || Math.abs(current.rect.top - next.rect.top) > 0.5
        || Math.abs(current.rect.width - next.rect.width) > 0.5
        || Math.abs(current.rect.height - next.rect.height) > 0.5
        || current.element !== next.element;
      mediaRef.current = next;
      if (changedMedia) {
        previousKey.current = next.key;
        setTransform(EMPTY_TRANSFORM);
        setCropMode(false);
        setQuickPanel(null);
      }
      if (changedMedia || rectChanged || !current) setMedia(next);
    };

    const scan = () => {
      frame = 0;
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (document.hidden) return;
      const now = performance.now();
      const scanInterval = mediaRef.current ? 60 : 120;
      if (now - lastScan < scanInterval) {
        scanTimer = window.setTimeout(schedule, scanInterval - (now - lastScan));
        return;
      }
      lastScan = now;

      // Search the known viewer first. A full document scan is only needed
      // while idle or after WhatsApp replaces the viewer root.
      const knownViewer = mediaRef.current?.viewer ?? null;
      const detected = findActiveMedia(knownViewer);
      const refreshed = !detected && mediaRef.current ? refreshActiveMedia(mediaRef.current) : null;
      const fallback = !detected && !refreshed ? findActiveMedia() : null;
      const next = detected ?? refreshed ?? fallback;
      if (next) {
        accept(next);
        return;
      }

      if (!mediaRef.current) return;
      const closeHinted = closingHintUntil > now;
      if (missingSince.current === null) {
        missingSince.current = now;
        // A single delayed recheck keeps the toolbar stable through WhatsApp's
        // transient React node replacement, without continuous polling.
        graceTimer = window.setTimeout(() => {
          graceTimer = null;
          schedule();
        }, closeHinted ? 140 : 1000);
      }
      // Keep the session alive through a brief replacement to prevent blinking.
      if (now - missingSince.current < (closeHinted ? 120 : 960)) return;

      resetViewerTools();
      missingSince.current = null;
      // Keep an explicit merge stack long enough to move between media items,
      // then release its blobs if the user abandons the viewer.
      if (!inactiveClearTimer.current) {
        inactiveClearTimer.current = window.setTimeout(() => {
          setMergeOpen(false);
          setMergeItems([]);
          setProfileSessions({});
          terminateProcessor();
          inactiveClearTimer.current = null;
        }, 10 * 60_000);
      }
    };

    const schedule = () => { if (!frame && !document.hidden) frame = window.requestAnimationFrame(scan); };
    const markClosingHint = () => {
      if (!mediaRef.current) return;
      closingHintUntil = performance.now() + 500;
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer);
        graceTimer = null;
      }
      schedule();
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') markClosingHint();
      schedule();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !mediaRef.current) {
        schedule();
        return;
      }
      const control = target.closest('button,[role="button"],[aria-label],[title]');
      const label = [control?.getAttribute('aria-label'), control?.getAttribute('title'), control?.textContent].filter(Boolean).join(' ').toLowerCase();
      if (target === mediaRef.current.viewer || /\b(close|back|dismiss)\b/.test(label)) markClosingHint();
      schedule();
    };
    const observer = new MutationObserver(schedule);
    const observeTarget = document.getElementById('app') ?? document.documentElement;
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'aria-hidden', 'aria-modal', 'role'],
    });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('keydown', handleKeydown, { capture: true });
    window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
    scan();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('keydown', handleKeydown, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('visibilitychange', schedule);
      if (frame) window.cancelAnimationFrame(frame);
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      if (inactiveClearTimer.current) window.clearTimeout(inactiveClearTimer.current);
    };
  }, [settings?.enabled]);

  useEffect(() => {
    let active = true;
    if (!premium) {
      setServerTemplates([]);
      return () => { active = false; };
    }
    void browser.runtime.sendMessage({ type: 'billing:get-templates' })
      .then((response: { ok: boolean; data?: ServerTemplate[] }) => {
        if (active && response.ok) setServerTemplates(response.data ?? []);
      })
      .catch(() => {
        if (active) setServerTemplates([]);
      });
    return () => { active = false; };
  }, [premium]);

  const pinnedProfiles = useMemo(() => premium ? settings?.profiles.filter((profile) => profile.pinned) ?? [] : [], [premium, settings]);
  const visiblePinnedProfiles = pinnedProfiles.slice(0, 5);
  const overflowPinnedProfiles = pinnedProfiles.slice(5);
  const activeTemplates = useMemo(() => {
    if (!premium || !settings) return [];
    const deleted = new Set(settings.deletedTemplateIds);
    const disabled = new Set(settings.disabledTemplateIds);
    const localTemplates = settings.localTemplates.map((template) => ({ ...template, payload: template.payload as Partial<AppSettings> }));
    return [...serverTemplates, ...localTemplates].filter((template) => !deleted.has(template.id) && !disabled.has(template.id));
  }, [premium, serverTemplates, settings]);
  const imageTemplates = useMemo(() => activeTemplates.filter((template) => template.category === 'image_defaults'), [activeTemplates]);
  const mergeTemplates = useMemo(() => activeTemplates.filter((template) => template.category === 'merge_pdf'), [activeTemplates]);
  const cropTemplates = useMemo(() => imageTemplates.filter((template) => {
    const ratio = template.payload.defaultCropRatio;
    return ratio && ratio !== 'free' && ratio !== 'original';
  }), [imageTemplates]);
  const resizeTemplates = useMemo(() => imageTemplates.filter((template) => template.payload.defaultWidth || template.payload.defaultHeight), [imageTemplates]);
  const compressTemplates = useMemo(() => imageTemplates.filter((template) => template.payload.defaultMaxKB || template.payload.defaultQuality || template.payload.defaultFormat), [imageTemplates]);

  const rotate = (direction: -1 | 1) => {
    setTransform((current) => ({ ...current, rotation: ((current.rotation + (direction === 1 ? 90 : 270)) % 360) as Rotation, crop: undefined }));
  };

  const updateToolbarSettings = useCallback((patch: Partial<AppSettings>) => {
    if (!settings) return;
    void saveSettings({ ...settings, ...patch });
  }, [settings]);

  const beginToolbarDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!settings || settings.toolbarLocked) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = toolbarPreviewOffset ?? {
      x: settings.toolbarOffsetX,
      y: settings.toolbarOffsetY,
    };
    let latest = startOffset;
    const move = (moveEvent: PointerEvent) => {
      latest = {
        x: clampToolbarOffset(startOffset.x + moveEvent.clientX - startX),
        y: clampToolbarOffset(startOffset.y + moveEvent.clientY - startY),
      };
      setToolbarPreviewOffset(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setToolbarPreviewOffset(null);
      void saveSettings({
        ...settings,
        toolbarOffsetX: latest.x,
        toolbarOffsetY: latest.y,
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [settings, toolbarPreviewOffset]);

  const downloadCurrent = async (
    maxKB?: number,
    formatOverride?: ImageFormat,
    qualityOverride?: number,
    transformOverride: TransformState = transform,
    filenameMode: 'custom' | 'whatsapp' = 'custom',
  ) => {
    if (!media || !settings) return;
    setBusy(true);
    try {
      const source = await captureActiveMedia(media);
      if (media.kind === 'pdf') {
        const name = filenameMode === 'whatsapp'
          ? whatsappStyleFilename('pdf', 'pdf')
          : withExtension(renderFilename(settings.defaultFilenameTemplate, { format: 'pdf' }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), 'pdf');
        await downloadBlob(source, name);
        toast(`Downloaded ${name}`);
        setQuickPanel(null);
        setTransform(EMPTY_TRANSFORM);
        return;
      }
      const isCompressionAction = maxKB !== undefined || formatOverride !== undefined || qualityOverride !== undefined;
      const format = formatOverride ?? STANDARD_IMAGE_FORMAT;
      const result = await processImage(source, {
        rotation: transformOverride.rotation,
        flipX: false,
        flipY: false,
        crop: transformOverride.crop,
        resize: transformOverride.resize,
        format,
        compression: {
          minBytes: isCompressionAction && maxKB !== undefined ? kbToBytes(settings.defaultMinKB) : undefined,
          maxBytes: isCompressionAction ? kbToBytes(maxKB) : undefined,
          preferredQuality: isCompressionAction ? clampQualityPercent(qualityOverride, settings.defaultQuality) / 100 : STANDARD_IMAGE_QUALITY,
          minimumQuality: isCompressionAction ? settings.minimumQuality / 100 : STANDARD_MINIMUM_QUALITY,
          allowDimensionReduction: isCompressionAction ? settings.allowDimensionReduction : false,
        },
        background: '#ffffff',
      });
      const filename = filenameMode === 'whatsapp'
        ? whatsappStyleFilename('image', format)
        : withExtension(renderFilename(settings.defaultFilenameTemplate, { width: result.width, height: result.height, format }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), format);
      await downloadBlob(result.blob, filename);
      setTransform(EMPTY_TRANSFORM);
      toast(`Downloaded ${filename} • ${formatBytes(result.blob.size)}`);
      setQuickPanel(null);
    } catch (error) {
      toast(error instanceof PrivacySourceError ? 'This media is not locally accessible. No outside request was made.' : (error instanceof Error ? error.message : 'Download failed.'), true);
    } finally {
      terminateProcessor();
      setBusy(false);
    }
  };


  const compressCurrentPdf = async (maxKB?: number, qualityOverride?: number, filenameMode: 'custom' | 'whatsapp' = 'custom') => {
    if (!media || media.kind !== 'pdf' || !settings) return;
    setBusy(true);
    try {
      const source = await captureActiveMedia(media);
      const result = await compressPdfLocally(source, kbToBytes(maxKB), clampQualityPercent(qualityOverride, settings.defaultQuality) / 100, (current, total, note) => {
        if (current === 1 || current === total) toast(note);
      });
      const filename = filenameMode === 'whatsapp'
        ? whatsappStyleFilename('pdf', 'pdf')
        : withExtension(renderFilename(settings.defaultFilenameTemplate, { format: 'pdf' }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), 'pdf');
      await downloadBlob(result, filename);
      toast(`Downloaded ${filename} • ${formatBytes(result.size)}`);
      setQuickPanel(null);
    } catch (error) {
      toast(error instanceof PrivacySourceError ? 'This PDF is not locally accessible. No outside request was made.' : (error instanceof Error ? error.message : 'PDF compression failed.'), true);
    } finally {
      setTransform(EMPTY_TRANSFORM);
      terminateProcessor();
      setBusy(false);
    }
  };

  const addCurrentToMerge = async () => {
    if (!media) return;
    setBusy(true);
    try {
      if (mergeItems.some((item) => item.sourceKey === media.key || item.sourceKey?.startsWith(`${media.key}:page:`))) {
        toast('Already in merge stack.');
        return;
      }
      const blob = await captureActiveMedia(media);
      if (media.kind === 'pdf') {
        const pages = await rasterizePdfForMerge(blob, 'WhatsApp PDF', media.key, (current, total) => toast(`Reading PDF page ${current}/${total}`));
        setMergeItems((current) => [...current, ...pages]);
        toast(`Added ${pages.length} PDF page${pages.length === 1 ? '' : 's'} to merge.`);
      } else {
        setMergeItems((current) => [...current, { id: createId(), blob, name: `Image ${current.length + 1}`, rotation: transform.rotation, crop: transform.crop, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceKey: media.key, sourceType: 'image' }]);
        toast('Added current image to merge.');
      }
    } catch (error) {
      toast(error instanceof PrivacySourceError ? 'This media cannot be added privately from its current source.' : (error instanceof Error ? error.message : 'Could not add media.'), true);
    } finally {
      setBusy(false);
    }
  };

  const runPipeline = async (profile: MediaProfile, source: Blob, manualCrop?: NormalizedCrop) => {
    if (!media || !settings || !premium) return;
    const cropStep = stepOf(profile, 'crop');
    if (cropStep?.mode === 'ask' && !manualCrop) {
      setPendingPipeline({ profile, source });
      setCropMode(true);
      return;
    }
    setBusy(true);
    try {
      const formatStep = stepOf(profile, 'format');
      const compressStep = stepOf(profile, 'compress');
      const filenameStep = stepOf(profile, 'filename');
      const downloadStep = stepOf(profile, 'download');
      const requestedFormat = formatStep?.format ?? settings.defaultFormat;
      const intermediateFormat: ImageFormat = requestedFormat === 'pdf' ? 'jpeg' : requestedFormat;
      const operations: CanvasOperation[] = [];

      // Manual changes visible in the viewer are the starting state for a pipeline.
      if (transform.rotation) operations.push({ type: 'rotate', degrees: transform.rotation });
      if (transform.crop && !(cropStep?.mode === 'ask' && manualCrop)) operations.push({ type: 'crop', crop: transform.crop });
      if (transform.resize) operations.push({ type: 'resize', settings: transform.resize });

      for (const step of profile.steps) {
        if (step.type === 'rotate') operations.push({ type: 'rotate', degrees: step.degrees });
        if (step.type === 'crop') {
          if (step.mode === 'ask') operations.push({ type: 'crop', crop: manualCrop });
          else if (step.ratio !== 'free' && step.ratio !== 'original') {
            const [widthRatio, heightRatio] = step.ratio.split(':').map(Number);
            if (widthRatio && heightRatio) operations.push({ type: 'crop', ratio: widthRatio / heightRatio });
          }
        }
        if (step.type === 'resize') operations.push({
          type: 'resize',
          settings: { width: step.width, height: step.height, maintainAspectRatio: true, allowUpscale: step.allowUpscale, fit: step.fit },
        });
      }

      const processed = await processCanvasPipeline(source, operations, {
        format: intermediateFormat,
        compression: {
          minBytes: profile.inputCount === 1 && requestedFormat !== 'pdf' ? kbToBytes(compressStep?.minKB) : undefined,
          maxBytes: profile.inputCount === 1 && requestedFormat !== 'pdf' ? kbToBytes(compressStep?.maxKB) : undefined,
          preferredQuality: settings.defaultQuality / 100,
          minimumQuality: settings.minimumQuality / 100,
          allowDimensionReduction: settings.allowDimensionReduction,
        },
        background: profile.background,
      });

      const filenameTemplate = filenameStep ? presetTemplate(filenameStep.preset, filenameStep.template) : '{profile}_{datetime}';
      const filenameOptions = {
        removeSpaces: filenameStep?.removeSpaces ?? true,
        removeSpecialCharacters: filenameStep?.removeSpecialCharacters ?? true,
      };

      if (profile.inputCount > 1) {
        const existing = profileSessions[profile.id]?.items ?? [];
        const item: MergeItem = { id: createId(), blob: processed.blob, name: `${profile.name} ${existing.length + 1}`, rotation: 0, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceKey: media.key, sourceType: 'image' };
        const items = [...existing.filter((entry) => entry.sourceKey !== media.key), item];
        if (items.length < profile.inputCount) {
          setProfileSessions((current) => ({ ...current, [profile.id]: { profile, items } }));
          toast(`${profile.name}: ${items.length}/${profile.inputCount}`);
          return;
        }
        const output = await mergeMedia(items.slice(0, profile.inputCount), {
          layout: profile.mergeLayout,
          format: requestedFormat,
          background: profile.background,
          gap: settings.mergeDefaultGap,
          padding: settings.mergeDefaultPadding,
          borderWidth: settings.mergeDefaultBorderWidth,
          borderColor: settings.mergeDefaultBorderColor,
          gridColumns: settings.mergeDefaultGridColumns,
          quality: settings.defaultQuality / 100,
          maxBytes: kbToBytes(compressStep?.maxKB),
        });
        const filename = withExtension(renderFilename(filenameTemplate, { profile: profile.name, format: requestedFormat, prefix: filenameStep?.prefix }, filenameOptions), requestedFormat);
        if (downloadStep?.automatic === false && !window.confirm(`Download ${filename}?`)) return;
        await downloadBlob(output, filename);
        setProfileSessions((current) => { const next = { ...current }; delete next[profile.id]; return next; });
        toast(`${profile.name} completed.`);
        return;
      }

      let output = processed.blob;
      let extension: ImageFormat | 'pdf' = requestedFormat;
      if (requestedFormat === 'pdf') {
        output = await mergeMedia([{ id: createId(), blob: processed.blob, name: profile.name, rotation: 0, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceType: 'image' }], {
          layout: 'vertical', format: 'pdf', background: profile.background, gap: settings.mergeDefaultGap, padding: settings.mergeDefaultPadding,
          borderWidth: settings.mergeDefaultBorderWidth, borderColor: settings.mergeDefaultBorderColor, gridColumns: 1,
          quality: settings.defaultQuality / 100, maxBytes: kbToBytes(compressStep?.maxKB),
        });
      }
      const filename = withExtension(renderFilename(filenameTemplate, { profile: profile.name, format: extension, width: processed.width, height: processed.height, prefix: filenameStep?.prefix }, filenameOptions), extension);
      if (downloadStep?.automatic === false && !window.confirm(`Download ${filename}?`)) return;
      await downloadBlob(output, filename);
      toast(`${profile.name} completed • ${formatBytes(output.size)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Pipeline failed.', true);
    } finally {
      setTransform(EMPTY_TRANSFORM);
      terminateProcessor();
      setBusy(false);
      setPendingPipeline(null);
    }
  };

  const executeProfile = async (profile: MediaProfile) => {
    if (!media || media.kind !== 'image' || !settings || !premium || busy) return;
    setBusy(true);
    try {
      const response = await browser.runtime.sendMessage({ type: 'billing:verify-online' }) as { ok: boolean; data?: { premium?: boolean; reason?: string }; error?: string };
      if (!response.ok || !response.data?.premium) {
        toast(response.data?.reason || response.error || 'Sign in on this device to use pipelines.', true);
        return;
      }
      const source = await captureActiveMedia(media);
      // runPipeline owns the remaining busy lifecycle after this validation.
      setBusy(false);
      await runPipeline(profile, source);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Pipeline failed.', true);
    } finally {
      setBusy(false);
    }
  };

  const downloadWithDefaultResize = () => {
    if (!settings) return;
    const resize = settings.defaultWidth || settings.defaultHeight
      ? { width: settings.defaultWidth, height: settings.defaultHeight, maintainAspectRatio: true, allowUpscale: settings.allowUpscale, fit: settings.defaultResizeFit }
      : undefined;
    void downloadCurrent(undefined, undefined, undefined, { ...transform, resize }, 'whatsapp');
  };

  const applyImageTemplate = async (templateId: string, presetKey?: 'defaultCropPresetId' | 'defaultResizePresetId' | 'defaultCompressPresetId') => {
    if (!settings || !templateId) return;
    const template = imageTemplates.find((item) => item.id === templateId);
    if (!template) return;
    const next = { ...settings, ...pickSettingsPatch(template.payload, templateKeysForPreset(presetKey)), ...(presetKey ? { [presetKey]: template.id } : {}) };
    await saveSettings(next as AppSettings);
    toast(`${template.name} preset applied.`);
  };

  useEffect(() => {
    if (settings?.toolbarUiVisible !== false) return;
    setQuickPanel(null);
    setCropMode(false);
    setPendingPipeline(null);
  }, [settings?.toolbarUiVisible]);

  useEffect(() => () => terminateProcessor(), []);

  if (!settings || !settings.enabled || !media) return null;

  const viewerRect = media.viewer.getBoundingClientRect();
  const defaultToolbarDrop = Math.max(32, Math.min(72, viewerRect.height * 0.1));
  const toolbarOffset = toolbarPreviewOffset ?? { x: settings.toolbarOffsetX, y: settings.toolbarOffsetY };
  const toolbarTop = Math.max(8, Math.min(innerHeight - 40, viewerRect.top + 8 + defaultToolbarDrop + toolbarOffset.y));
  const toolbarLeft = Math.max(12, Math.min(innerWidth - 88, viewerRect.left + 12 + toolbarOffset.x));
  const toolbarSpaceBeforeOfficialControls = Math.max(88, innerWidth - toolbarLeft - 380);
  const toolbarMaxWidth = Math.min(Math.max(88, viewerRect.width * 0.56), toolbarSpaceBeforeOfficialControls);
  const toolbarUiVisible = settings.toolbarUiVisible !== false;
  const hasPipelineRail = media.kind === 'image' && premium && pinnedProfiles.length > 0;
  const rotateButtonSize = 68;
  const rotateIconSize = 42;
  const rotateTop = Math.max(8, Math.min(innerHeight - rotateButtonSize - 8, media.rect.top + media.rect.height / 2 - rotateButtonSize / 2));
  const rotateLeft = Math.max(12, Math.min(innerWidth - rotateButtonSize - 12, media.rect.left + 12));
  const rotateRight = Math.max(12, Math.min(innerWidth - rotateButtonSize - 12, media.rect.right - rotateButtonSize - 12));
  const transformed = media.kind === 'image' ? transformedDimensions(media.element, transform.rotation) : null;
  const cropSourceRect = media.kind === 'image' && transformed ? containRect(media.rect, transformed.width, transformed.height) : media.rect;
  const cropRect = clipRectToViewport(cropSourceRect);

  return <div className="ma-root">
    {toolbarUiVisible && media.kind === 'image' && <PreviewCanvas media={media} transform={transform} />}
    {!mergeOpen && <div className={`ma-toolbar${settings.showToolbarLabels ? '' : ' icons-only'}${toolbarUiVisible ? '' : ' ui-hidden'}`} style={{ top: toolbarTop, left: toolbarLeft, maxWidth: toolbarMaxWidth }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className={`ma-toolbar-start${toolbarUiVisible && hasPipelineRail ? ' with-pipelines' : ''}`}>
        <div className="ma-toolbar-controls">
          <button className={`ma-toolbar-control${settings.toolbarLocked ? ' disabled' : ''}`} title={settings.toolbarLocked ? 'Unlock toolbar to move' : 'Drag toolbar'} disabled={settings.toolbarLocked} onPointerDown={beginToolbarDrag}><Icon name="more" size={15} /></button>
          <button className={`ma-toolbar-control${settings.toolbarLocked ? ' locked' : ''}`} title={settings.toolbarLocked ? 'Unlock toolbar' : 'Lock toolbar'} onClick={() => updateToolbarSettings({ toolbarLocked: !settings.toolbarLocked })}><Icon name="lock" size={15} /></button>
          <button className={`ma-toolbar-control${toolbarUiVisible ? '' : ' muted'}`} title={toolbarUiVisible ? 'Hide WhatsApp Media Assist UI' : 'Show WhatsApp Media Assist UI'} onClick={() => updateToolbarSettings({ toolbarUiVisible: !toolbarUiVisible })}><Icon name={toolbarUiVisible ? 'eye' : 'eye-off'} size={15} /></button>
        </div>
        {toolbarUiVisible && hasPipelineRail && <div className="ma-pipeline-rail">
          {visiblePinnedProfiles.map((profile) => <button key={profile.id} className="ma-profile-btn" title={profile.name} disabled={busy} onClick={() => void executeProfile(profile)}><span>{pipelineTag(profile)}</span>{profile.inputCount > 1 && <b>{profileSessions[profile.id]?.items.length ?? 0}/{profile.inputCount}</b>}</button>)}
          {overflowPinnedProfiles.length > 0 && <select className="ma-profile-select" aria-label="More pipelines" disabled={busy} value="" onChange={(event) => { const profile = overflowPinnedProfiles.find((item) => item.id === event.target.value); event.currentTarget.value = ''; if (profile) void executeProfile(profile); }}><option value="">More</option>{overflowPinnedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>}
        </div>}
      </div>
      {toolbarUiVisible && <div className="ma-tool-strip">
        {media.kind === 'image' && <button className="ma-tool-btn" title="Crop" onClick={() => { setCropMode(true); setQuickPanel(null); }}><Icon name="crop" /><span>Crop</span></button>}
        {media.kind === 'image' && <button className="ma-tool-btn" title={premium ? 'Resize' : 'Resize with saved defaults and download'} disabled={busy} onClick={() => premium ? setQuickPanel((current) => current === 'resize' ? null : 'resize') : downloadWithDefaultResize()}><Icon name="resize" /><span>Resize</span></button>}
        <button className="ma-tool-btn" title={media.kind === 'pdf' ? 'Compress PDF' : 'Compress and download'} onClick={() => setQuickPanel((current) => current === (media.kind === 'pdf' ? 'pdf-compress' : 'compress') ? null : (media.kind === 'pdf' ? 'pdf-compress' : 'compress'))}><Icon name="compress" /><span>{media.kind === 'pdf' ? 'Compress PDF' : 'Compress'}</span></button>
        {premium && <div className="ma-button-group">
          <button className="ma-tool-btn merge" title="Add to merge" disabled={busy} onClick={() => void addCurrentToMerge()}><Icon name="plus" /><span>Add to merge</span>{mergeItems.length > 0 && <b className="ma-count">{mergeItems.length}</b>}</button>
          {mergeItems.length > 0 && !mergeOpen && <button className="ma-tool-btn stack" title="Open merge stack" onClick={() => setMergeOpen(true)}><Icon name="merge" /><span>Stack</span><b className="ma-count">{mergeItems.length}</b></button>}
        </div>}
        <button className="ma-tool-btn" title="Download with saved defaults" disabled={busy} onClick={() => void downloadCurrent()}><Icon name="download" /><span>Download</span></button>
      </div>}
    </div>}

    {!mergeOpen && toolbarUiVisible && media.kind === 'image' && settings.showRotateControls && <><button className="ma-rotate-btn left" style={{ left: rotateLeft, top: rotateTop }} title="Rotate left" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); rotate(-1); }}><Icon name="rotate-left" size={rotateIconSize} /><span>Rotate left</span></button><button className="ma-rotate-btn right" style={{ left: rotateRight, top: rotateTop }} title="Rotate right" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); rotate(1); }}><Icon name="rotate-right" size={rotateIconSize} /><span>Rotate right</span></button></>}

    {!mergeOpen && toolbarUiVisible && quickPanel === 'resize' && media.kind === 'image' && premium && <div className="ma-floating-panel" style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft }}><ResizePanel settings={settings} current={transform.resize} busy={busy} templates={resizeTemplates} defaultTemplateId={settings.defaultResizePresetId} onApplyTemplate={(templateId) => void applyImageTemplate(templateId, 'defaultResizePresetId')} onApply={(resize) => void downloadCurrent(undefined, undefined, undefined, { ...transform, resize }, 'whatsapp')} onClose={() => setQuickPanel(null)} /></div>}
    {!mergeOpen && toolbarUiVisible && quickPanel === 'compress' && media.kind === 'image' && <div className="ma-floating-panel" style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft + 42 }}><CompressPanel settings={settings} busy={busy} templates={compressTemplates} defaultTemplateId={settings.defaultCompressPresetId} onApplyTemplate={(templateId) => void applyImageTemplate(templateId, 'defaultCompressPresetId')} onDownload={(maxKB, format, quality) => void downloadCurrent(maxKB, format, quality, transform, 'whatsapp')} onClose={() => setQuickPanel(null)} /></div>}
    {!mergeOpen && toolbarUiVisible && quickPanel === 'pdf-compress' && media.kind === 'pdf' && <div className="ma-floating-panel" style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft + 42 }}><PdfCompressPanel settings={settings} busy={busy} onDownload={(maxKB, quality) => void compressCurrentPdf(maxKB, quality, 'whatsapp')} onClose={() => setQuickPanel(null)} /></div>}
    {!mergeOpen && toolbarUiVisible && cropMode && media.kind === 'image' && <CropOverlay imageRect={cropRect} sourceRect={cropSourceRect} initial={transform.crop} templates={cropTemplates} defaultTemplateId={settings.defaultCropPresetId} onApplyTemplate={(templateId) => void applyImageTemplate(templateId, 'defaultCropPresetId')} onCancel={() => { setCropMode(false); setPendingPipeline(null); }} onConfirm={(crop) => { const nextTransform = { ...transform, crop }; setTransform(nextTransform); setCropMode(false); if (pendingPipeline) void runPipeline(pendingPipeline.profile, pendingPipeline.source, crop); else void downloadCurrent(undefined, undefined, undefined, nextTransform, 'whatsapp'); }} />}
    {mergeOpen && <MergeWorkspace items={mergeItems} settings={settings} templates={mergeTemplates} onItemsChange={setMergeItems} onClose={() => setMergeOpen(false)} onToast={toast} />}
    <div className="ma-toast-stack">{toasts.map((item) => <div key={item.id} className={`ma-toast${item.error ? ' error' : ''}`}>{item.message}</div>)}</div>
  </div>;
}
