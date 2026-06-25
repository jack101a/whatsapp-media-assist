import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, type AppSettings, watchSettings } from '../storage/settings';
import type { CanvasOperation, ImageFormat, MergeItem, MergeLayout, NormalizedCrop, ResizeSettings } from '../types/media';
import type { FilenamePreset, MediaProfile, PipelineStep } from '../types/profile';
import { processCanvasPipeline, processImage, PrivacySourceError } from '../engine/canvas';
import { downloadBlob } from '../engine/download';
import { captureActiveMedia } from '../whatsapp/local-media';
import { compressPdfLocally, keepWorkerAlive, mergeMedia, rasterizePdfForMerge, terminateProcessor } from '../engine/processor-client';
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

const EMPTY_TRANSFORM: TransformState = { rotation: 0 };

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
    // Cache the last token we verified so we can skip the async crypto.subtle
    // call when billing storage changes for unrelated fields (e.g. lastCheckedAt
    // timestamps written every 12 hours by the background alarm).
    let lastCheckedToken: string | undefined = undefined;

    const verify = async (entitlementToken: string | undefined, deviceId: string) => {
      if (entitlementToken === lastCheckedToken) return; // token unchanged — skip
      lastCheckedToken = entitlementToken;
      const status = await verifyEntitlementToken(entitlementToken, deviceId);
      if (active) setPremium(status.premium);
    };

    // Initial load: read storage once.
    void getBillingState().then((b) => verify(b.entitlementToken, b.deviceId));

    // Subsequent changes: billing state is delivered directly by the watcher,
    // so we never call getBillingState() again after the first load.
    const unwatch = watchBillingState((b) => void verify(b.entitlementToken, b.deviceId));
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

function transformedDimensions(image: HTMLImageElement, rotation: Rotation) {
  return rotation === 90 || rotation === 270
    ? { width: image.naturalHeight, height: image.naturalWidth }
    : { width: image.naturalWidth, height: image.naturalHeight };
}

function PreviewCanvas({ media, transform }: { media: ActiveMedia; transform: TransformState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = media.kind === 'image' && (transform.rotation !== 0 || Boolean(transform.crop));

  // Opacity: toggle the underlying WhatsApp image hidden when our canvas is active.
  // Keyed only on element identity + active — rect changes don't need to re-run this.
  const element = media.kind === 'image' ? media.element : null;
  useEffect(() => {
    if (!element || !active) return;
    const previousOpacity = element.style.opacity;
    element.style.opacity = '0';
    return () => { element.style.opacity = previousOpacity; };
  }, [element, active]);

  // Canvas draw: keyed on element identity + transform only.
  // Rect (position/size) is handled by the CSS style prop below — React updates
  // that without running this effect, so we avoid a full canvas redraw on every
  // toolbar-position tick (~90 ms while the viewer is open).
  const rotation = transform.rotation;
  const crop = transform.crop;
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
    const rotatedWidth = rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth;
    const rotatedHeight = rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight;
    const previewScale = Math.min(1, 1600 / Math.max(rotatedWidth, rotatedHeight));
    const temp = document.createElement('canvas');
    temp.width = Math.max(1, Math.round(rotatedWidth * previewScale));
    temp.height = Math.max(1, Math.round(rotatedHeight * previewScale));
    const tempContext = temp.getContext('2d', { alpha: true });
    if (!tempContext) return;
    tempContext.imageSmoothingEnabled = true;
    tempContext.imageSmoothingQuality = 'high';
    tempContext.translate(temp.width / 2, temp.height / 2);
    tempContext.rotate((rotation * Math.PI) / 180);
    const drawWidth = sourceWidth * previewScale;
    const drawHeight = sourceHeight * previewScale;
    tempContext.drawImage(media.element, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

    const activeCrop = crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const sx = Math.round(activeCrop.x * temp.width);
    const sy = Math.round(activeCrop.y * temp.height);
    const sw = Math.max(1, Math.round(activeCrop.width * temp.width));
    const sh = Math.max(1, Math.round(activeCrop.height * temp.height));
    const scale = Math.min(cssWidth / sw, cssHeight / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    context.drawImage(temp, sx, sy, sw, sh, (cssWidth - dw) / 2, (cssHeight - dh) / 2, dw, dh);
    temp.width = 1;
    temp.height = 1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, rotation, crop, active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="ma-live-preview" style={{ left: media.rect.left, top: media.rect.top, width: media.rect.width, height: media.rect.height }} />;
}

type CropRatioPreset = 'free' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
const CROP_RATIOS: { label: string; value: CropRatioPreset; ratio: number | null }[] = [
  { label: 'Free', value: 'free', ratio: null },
  { label: '1:1', value: '1:1', ratio: 1 },
  { label: '4:3', value: '4:3', ratio: 4 / 3 },
  { label: '3:4', value: '3:4', ratio: 3 / 4 },
  { label: '16:9', value: '16:9', ratio: 16 / 9 },
  { label: '9:16', value: '9:16', ratio: 9 / 16 },
];

function applyCropRatio(crop: NormalizedCrop, ratio: number): NormalizedCrop {
  // Expand/shrink height to match the ratio while keeping centre the same.
  const centreX = crop.x + crop.width / 2;
  const centreY = crop.y + crop.height / 2;
  // Use existing width as the reference dimension.
  const newHeight = Math.min(1, crop.width / ratio);
  const newWidth = Math.min(1, newHeight * ratio);
  return {
    x: Math.max(0, Math.min(1 - newWidth, centreX - newWidth / 2)),
    y: Math.max(0, Math.min(1 - newHeight, centreY - newHeight / 2)),
    width: newWidth,
    height: newHeight,
  };
}

function CropOverlay({ imageRect, initial, onCancel, onConfirm }: {
  imageRect: DOMRect;
  initial?: NormalizedCrop;
  onCancel: () => void;
  onConfirm: (crop: NormalizedCrop) => void;
}) {
  const [crop, setCrop] = useState<NormalizedCrop>(initial ?? { x: 0.06, y: 0.06, width: 0.88, height: 0.88 });
  const [ratioKey, setRatioKey] = useState<CropRatioPreset>('free');
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; start: NormalizedCrop; ratio: number | null } | null>(null);
  const activeRatio = CROP_RATIOS.find((r) => r.value === ratioKey)?.ratio ?? null;

  const setRatio = (key: CropRatioPreset, ratio: number | null) => {
    setRatioKey(key);
    if (ratio !== null) setCrop((c) => applyCropRatio(c, ratio));
  };

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
        // Enforce locked ratio on corner drags
        if (drag.current.ratio !== null) next = applyCropRatio(next, drag.current.ratio);
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
    drag.current = { mode, startX: event.clientX, startY: event.clientY, start: crop, ratio: activeRatio };
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
    {/* Ratio picker bar */}
    <div className="ma-crop-ratios">
      {CROP_RATIOS.map((r) => (
        <button
          key={r.value}
          className={`ma-ratio-btn${ratioKey === r.value ? ' active' : ''}`}
          onClick={() => setRatio(r.value, r.ratio)}
        >{r.label}</button>
      ))}
    </div>
    <div className="ma-crop-box" style={boxStyle} onPointerDown={(event) => begin('move', event)}>
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => <span key={corner} className={`ma-handle ${corner}`} onPointerDown={(event) => begin(corner, event)} />)}
    </div>
    <div className="ma-crop-controls">
      <button className="ma-compact-btn" onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}>Reset</button>
      <button className="ma-compact-btn" onClick={onCancel}>Cancel</button>
      <button className="ma-compact-btn primary" onClick={() => onConfirm(crop)}><Icon name="check" />Apply</button>
    </div>
  </div>;
}

function QuickPanelCard({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <section className="ma-quick-panel" role="dialog" aria-label={title}>
    <header><strong>{title}</strong><button className="ma-icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button></header>
    {children}
  </section>;
}

function ResizePanel({ settings, current, onApply, onClose }: {
  settings: AppSettings;
  current?: ResizeSettings;
  onApply: (resize?: ResizeSettings) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(String(current?.width ?? settings.defaultWidth ?? ''));
  const [height, setHeight] = useState(String(current?.height ?? settings.defaultHeight ?? ''));
  return <QuickPanelCard title="Resize" onClose={onClose}>
    <div className="ma-mini-grid"><label>Width<input value={width} inputMode="numeric" onChange={(event) => setWidth(event.target.value.replace(/\D/g, ''))} placeholder="Original" /></label><label>Height<input value={height} inputMode="numeric" onChange={(event) => setHeight(event.target.value.replace(/\D/g, ''))} placeholder="Auto" /></label></div>
    <div className="ma-panel-actions"><button className="ma-compact-btn" onClick={() => { onApply(undefined); onClose(); }}>Reset</button><button className="ma-compact-btn primary" onClick={() => { onApply(width || height ? { width: width ? Number(width) : undefined, height: height ? Number(height) : undefined, maintainAspectRatio: true, allowUpscale: settings.allowUpscale, fit: settings.defaultResizeFit } : undefined); onClose(); }}>Apply</button></div>
  </QuickPanelCard>;
}

function CompressPanel({ settings, onDownload, onClose, busy }: {
  settings: AppSettings;
  onDownload: (maxKB: number | undefined, format: ImageFormat) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [maxKB, setMaxKB] = useState(String(settings.defaultMaxKB ?? ''));
  const [format, setFormat] = useState<ImageFormat>(settings.defaultFormat);
  return <QuickPanelCard title="Compress & download" onClose={onClose}>
    <div className="ma-mini-grid"><label>Max KB<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label><label>Format<select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label></div>
    <div className="ma-panel-actions"><button className="ma-compact-btn primary" disabled={busy} onClick={() => onDownload(maxKB ? Number(maxKB) : undefined, format)}><Icon name="download" />{busy ? 'Working…' : 'Download'}</button></div>
  </QuickPanelCard>;
}


function PdfCompressPanel({ settings, onDownload, onClose, busy }: {
  settings: AppSettings;
  onDownload: (maxKB: number | undefined) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [maxKB, setMaxKB] = useState(String(settings.defaultMaxKB ?? ''));
  return <QuickPanelCard title="Compress PDF" onClose={onClose}>
    <label className="ma-single-field">Target maximum (KB)<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label>
    <p className="ma-panel-note">Pages are compressed locally and preserved as a multi-page PDF. Selectable text may be rasterised.</p>
    <div className="ma-panel-actions"><button className="ma-compact-btn primary" disabled={busy} onClick={() => onDownload(maxKB ? Number(maxKB) : undefined)}><Icon name="download" />{busy ? 'Working…' : 'Compress & download'}</button></div>
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
  return <div className="ma-blob-crop"><img ref={imageRef} src={url} alt="Crop selected item" onLoad={() => setRect(imageRef.current?.getBoundingClientRect() ?? null)} />{rect && <CropOverlay imageRect={rect} initial={item.crop} onCancel={onCancel} onConfirm={onConfirm} />}</div>;
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

function MergeWorkspace({ items, settings, onItemsChange, onClose, onToast }: {
  items: MergeItem[];
  settings: AppSettings;
  onItemsChange: (items: MergeItem[]) => void;
  onClose: () => void;
  onToast: (message: string, error?: boolean) => void;
}) {
  const [layout, setLayout] = useState<MergeLayout>(settings.mergeDefaultLayout);
  const [format, setFormat] = useState<ImageFormat | 'pdf'>(settings.mergeDefaultFormat);
  const [maxKB, setMaxKB] = useState(String(settings.mergeDefaultMaxKB ?? ''));
  const [gap, setGap] = useState(String(settings.mergeDefaultGap));
  const [padding, setPadding] = useState(String(settings.mergeDefaultPadding));
  const [borderWidth, setBorderWidth] = useState(String(settings.mergeDefaultBorderWidth));
  const [borderColor, setBorderColor] = useState(settings.mergeDefaultBorderColor);
  const [gridColumns, setGridColumns] = useState(String(settings.mergeDefaultGridColumns));
  const [background, setBackground] = useState(settings.mergeDefaultBackground);
  const [filename, setFilename] = useState('merged_{datetime}');
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
    if (!files) return;
    const additions: MergeItem[] = [];
    for (const file of Array.from(files)) {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const pages = await rasterizePdfForMerge(file, file.name, `local:${file.name}:${file.size}`, (current, total) => onToast(`Reading ${file.name}: page ${current}/${total}`));
        additions.push(...pages);
      } else if (file.type.startsWith('image/')) {
        additions.push({ id: createId(), blob: file, name: file.name, rotation: 0, placement: { offsetX: 0, offsetY: 0, scale: 1 }, sourceType: 'image', sourceKey: `local:${file.name}:${file.size}:${file.lastModified}` });
      }
    }
    const next = [...items, ...additions];
    onItemsChange(next);
    if (!selectedId && additions[0]) setSelectedId(additions[0].id);
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
        quality: settings.defaultQuality / 100,
        maxBytes: kbToBytes(maxKB ? Number(maxKB) : undefined),
      }, (_current, _total, note) => onToast(note));
      const safeName = renderFilename(filename, { format }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: true });
      await downloadBlob(blob, withExtension(safeName, format));
      onToast(`Downloaded A4 ${format.toUpperCase()} • ${formatBytes(blob.size)}`);
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
        <div className="ma-merge-settings"><label>Output<select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat | 'pdf')}><option value="pdf">PDF</option><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></label><label>Target max KB<input value={maxKB} inputMode="numeric" onChange={(event) => setMaxKB(event.target.value.replace(/\D/g, ''))} placeholder="No limit" /></label>{layout === 'grid' && <label>Grid columns<input value={gridColumns} inputMode="numeric" onChange={(event) => setGridColumns(event.target.value.replace(/\D/g, ''))} /></label>}<label>Gap<input value={gap} inputMode="numeric" onChange={(event) => setGap(event.target.value.replace(/\D/g, ''))} /></label><label>Page margin<input value={padding} inputMode="numeric" onChange={(event) => setPadding(event.target.value.replace(/\D/g, ''))} /></label><label>Border<input value={borderWidth} inputMode="numeric" onChange={(event) => setBorderWidth(event.target.value.replace(/\D/g, ''))} /></label><label>Page colour<input type="color" value={background} onChange={(event) => setBackground(event.target.value)} /></label><label>Border colour<input type="color" value={borderColor} onChange={(event) => setBorderColor(event.target.value)} /></label><label className="wide">Filename<input value={filename} onChange={(event) => setFilename(event.target.value)} /></label></div>
        {selected && <div className="ma-selected-controls"><strong>Selected item</strong><div><button onClick={() => setCropItem(selected)}><Icon name="crop" size={15} />Crop</button><button onClick={() => updateItem({ ...selected, rotation: ((selected.rotation + 270) % 360) as Rotation })}><Icon name="rotate-left" size={15} />Left</button><button onClick={() => updateItem({ ...selected, rotation: ((selected.rotation + 90) % 360) as Rotation })}><Icon name="rotate-right" size={15} />Right</button></div><label>Zoom <input type="range" min="60" max="160" value={Math.round((selected.placement?.scale ?? 1) * 100)} onChange={(event) => updateItem({ ...selected, placement: { ...(selected.placement ?? { offsetX: 0, offsetY: 0, scale: 1 }), scale: Number(event.target.value) / 100 } })} /></label><button className="ma-reset-position" onClick={() => updateItem({ ...selected, placement: { offsetX: 0, offsetY: 0, scale: 1 } })}>Reset position & zoom</button></div>}
      </aside>
    </div>
    <div className="ma-workspace-bar"><button className="ma-compact-btn" onClick={() => fileInput.current?.click()}><Icon name="plus" />Add local image/PDF</button><input ref={fileInput} hidden type="file" multiple accept="image/*,application/pdf" onChange={(event) => void addLocal(event.target.files)} /><span>{items.length} item{items.length === 1 ? '' : 's'} in stack · drag cards to reorder</span></div>
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
  const previousKey = useRef('');
  const mediaRef = useRef<ActiveMedia | null>(null);
  const missingSince = useRef<number | null>(null);
  const inactiveClearTimer = useRef<number | null>(null);

  const toast = useCallback((message: string, error = false) => {
    const id = createId();
    setToasts((current) => [...current, { id, message, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200);
  }, []);

  // While the merge workspace is open, keep the media-processor Worker alive so
  // it does not get torn down between individual image additions. We ping it
  // every 30 s — well within the 60 s idle shutdown window — at zero processing
  // cost (keepWorkerAlive only resets the idle timer if the Worker already exists).
  useEffect(() => {
    if (!mergeOpen) return;
    const id = window.setInterval(keepWorkerAlive, 30_000);
    return () => window.clearInterval(id);
  }, [mergeOpen]);

  // Keyboard shortcuts (only when a viewer is active and user isn't typing).
  // Escape — close any open panel or crop overlay.
  // D       — download with current defaults.
  // M       — add current image to merge stack.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!media || !settings?.enabled) return;
      const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select'
        || (event.target as HTMLElement)?.isContentEditable;
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (cropMode) { setCropMode(false); setPendingPipeline(null); }
        else if (quickPanel) setQuickPanel(null);
        else if (mergeOpen) setMergeOpen(false);
      } else if (event.key === 'd' || event.key === 'D') {
        if (!busy) void downloadCurrent();
      } else if (event.key === 'm' || event.key === 'M') {
        if (!busy) void addCurrentToMerge();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, settings?.enabled, cropMode, quickPanel, mergeOpen, busy]);

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
    let lastScan = 0;
    let graceTimer: number | null = null;

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
      if (document.hidden) return;
      const now = performance.now();
      // Adaptive throttle:
      //  • 90 ms  — viewer is open: we need quick toolbar repositioning.
      //  • 600 ms — idle: user is browsing chats, no viewer open.
      //             This alone saves ~85 % of rAF + DOM-query CPU while idle.
      const scanInterval = mediaRef.current ? 90 : 600;
      if (now - lastScan < scanInterval) return;
      lastScan = now;

      // Fast path: when we already know the viewer element, pass it so
      // findActiveMedia only searches inside that subtree instead of the
      // entire WhatsApp document. Falls back to full scan automatically
      // when the viewer has gone or a new one has appeared.
      const knownViewer = mediaRef.current?.viewer ?? null;
      const detected = findActiveMedia(knownViewer);
      const refreshed = !detected && mediaRef.current ? refreshActiveMedia(mediaRef.current) : null;
      const next = detected ?? refreshed;
      if (next) {
        accept(next);
        return;
      }

      if (!mediaRef.current) return;
      if (missingSince.current === null) {
        missingSince.current = now;
        // A single delayed recheck keeps the toolbar stable through WhatsApp's
        // transient React node replacement, without continuous polling.
        graceTimer = window.setTimeout(() => {
          graceTimer = null;
          schedule();
        }, 1650);
      }
      // Keep the session alive through a short replacement to prevent blinking.
      if (now - missingSince.current < 1600) return;

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

    // Don't schedule an rAF at all when the page is hidden — the browser won't
    // fire it until the tab is visible again, so we'd just queue a stale frame.
    const schedule = () => { if (!frame && !document.hidden) frame = window.requestAnimationFrame(scan); };
    const observer = new MutationObserver(schedule);
    // Observe WhatsApp's own root element (#app) rather than the entire document.
    // This excludes browser-level and extension-level DOM mutations that we never
    // care about, further reducing unnecessary rAF scheduling.
    const observeTarget = document.getElementById('app') ?? document.documentElement;
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'aria-hidden', 'aria-modal', 'role'],
    });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('keydown', schedule, { capture: true });
    // Only schedule a scan when the page becomes *visible* again, not when
    // it hides — there's nothing actionable to do while hidden.
    const onVisibilityChange = () => { if (!document.hidden) schedule(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    scan();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('keydown', schedule, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (frame) window.cancelAnimationFrame(frame);
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      if (inactiveClearTimer.current) window.clearTimeout(inactiveClearTimer.current);
    };
  }, [settings?.enabled]);

  // Depend only on the profiles array — not the entire settings object — so
  // this memo doesn't re-run when unrelated settings fields change (quality,
  // theme, filename template, etc.).
  const pinnedProfiles = useMemo(
    () => settings?.profiles.filter((profile) => profile.pinned).slice(0, 4) ?? [],
    [settings?.profiles],
  );

  const rotate = (direction: -1 | 1) => {
    setTransform((current) => ({ ...current, rotation: ((current.rotation + (direction === 1 ? 90 : 270)) % 360) as Rotation, crop: undefined }));
  };

  const downloadCurrent = async (maxKB?: number, formatOverride?: ImageFormat) => {
    if (!media || !settings) return;
    setBusy(true);
    try {
      const source = await captureActiveMedia(media);
      if (media.kind === 'pdf') {
        const name = withExtension(renderFilename(settings.defaultFilenameTemplate, { format: 'pdf' }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), 'pdf');
        await downloadBlob(source, name);
        toast(`Downloaded ${name}`);
        setQuickPanel(null);
        return;
      }
      const format = formatOverride ?? settings.defaultFormat;
      const result = await processImage(source, {
        rotation: transform.rotation,
        flipX: false,
        flipY: false,
        crop: transform.crop,
        resize: transform.resize ?? (settings.defaultWidth || settings.defaultHeight ? { width: settings.defaultWidth, height: settings.defaultHeight, maintainAspectRatio: true, allowUpscale: settings.allowUpscale, fit: settings.defaultResizeFit } : undefined),
        format,
        compression: {
          minBytes: kbToBytes(settings.defaultMinKB),
          maxBytes: kbToBytes(maxKB ?? settings.defaultMaxKB),
          preferredQuality: settings.defaultQuality / 100,
          minimumQuality: settings.minimumQuality / 100,
          allowDimensionReduction: settings.allowDimensionReduction,
        },
        background: '#ffffff',
      });
      const filename = withExtension(renderFilename(settings.defaultFilenameTemplate, { width: result.width, height: result.height, format }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), format);
      await downloadBlob(result.blob, filename);
      toast(`Downloaded ${filename} • ${formatBytes(result.blob.size)}`);
      setQuickPanel(null);
    } catch (error) {
      toast(error instanceof PrivacySourceError ? 'This media is not locally accessible. No outside request was made.' : (error instanceof Error ? error.message : 'Download failed.'), true);
    } finally {
      setBusy(false);
    }
  };


  const compressCurrentPdf = async (maxKB?: number) => {
    if (!media || media.kind !== 'pdf' || !settings) return;
    setBusy(true);
    try {
      const source = await captureActiveMedia(media);
      const result = await compressPdfLocally(source, kbToBytes(maxKB ?? settings.defaultMaxKB), settings.defaultQuality / 100, (current, total, note) => {
        if (current === 1 || current === total) toast(note);
      });
      const filename = withExtension(renderFilename(settings.defaultFilenameTemplate, { format: 'pdf' }, { removeSpaces: settings.removeSpacesByDefault, removeSpecialCharacters: settings.removeSpecialCharactersByDefault }), 'pdf');
      await downloadBlob(result, filename);
      toast(`Downloaded ${filename} • ${formatBytes(result.size)}`);
      setQuickPanel(null);
    } catch (error) {
      toast(error instanceof PrivacySourceError ? 'This PDF is not locally accessible. No outside request was made.' : (error instanceof Error ? error.message : 'PDF compression failed.'), true);
    } finally {
      setBusy(false);
    }
  };

  const addCurrentToMerge = async () => {
    if (!media) return;
    setBusy(true);
    try {
      if (mergeItems.some((item) => item.sourceKey === media.key || item.sourceKey?.startsWith(`${media.key}:page:`))) {
        setMergeOpen(true);
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
      if (settings?.autoOpenMergeWorkspace !== false) setMergeOpen(true);
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
      setBusy(false);
      setPendingPipeline(null);
    }
  };

  const executeProfile = async (profile: MediaProfile) => {
    if (!media || media.kind !== 'image' || !settings || !premium) return;
    try {
      const source = await captureActiveMedia(media);
      await runPipeline(profile, source);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Pipeline failed.', true);
    }
  };

  useEffect(() => () => terminateProcessor(), []);

  if (!settings || !settings.enabled || !media) return null;

  const toolbarTop = Math.max(10, media.rect.top - 45);
  const toolbarLeft = Math.max(72, media.rect.left);
  const rotateTop = media.rect.top + media.rect.height / 2 - 19;
  const transformed = media.kind === 'image' ? transformedDimensions(media.element, transform.rotation) : null;
  const cropRect = media.kind === 'image' && transformed ? containRect(media.rect, transformed.width, transformed.height) : media.rect;

  return <div className="ma-root">
    {media.kind === 'image' && <PreviewCanvas media={media} transform={transform} />}
    <div className={`ma-toolbar${settings.showToolbarLabels ? '' : ' icons-only'}`} style={{ top: toolbarTop, left: toolbarLeft }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {media.kind === 'image' && premium && pinnedProfiles.map((profile) => <button key={profile.id} className="ma-profile-btn" title={profile.name} disabled={busy} onClick={() => void executeProfile(profile)}><span>{profile.name}</span>{profile.inputCount > 1 && <b>{profileSessions[profile.id]?.items.length ?? 0}/{profile.inputCount}</b>}</button>)}
      {media.kind === 'image' && <button className="ma-tool-btn" title="Crop" onClick={() => { setCropMode(true); setQuickPanel(null); }}><Icon name="crop" /><span>Crop</span></button>}
      {media.kind === 'image' && <button className="ma-tool-btn" title="Resize" onClick={() => setQuickPanel((current) => current === 'resize' ? null : 'resize')}><Icon name="resize" /><span>Resize</span></button>}
      <button className="ma-tool-btn" title={media.kind === 'pdf' ? 'Compress PDF' : 'Compress and download'} onClick={() => setQuickPanel((current) => current === (media.kind === 'pdf' ? 'pdf-compress' : 'compress') ? null : (media.kind === 'pdf' ? 'pdf-compress' : 'compress'))}><Icon name="compress" /><span>{media.kind === 'pdf' ? 'Compress PDF' : 'Compress'}</span></button>
      <button className="ma-tool-btn merge" title="Add to merge" disabled={busy} onClick={() => void addCurrentToMerge()}><Icon name="plus" /><span>Add to merge</span>{mergeItems.length > 0 && <b className="ma-count">{mergeItems.length}</b>}</button>
      <button className="ma-tool-btn" title="Download with saved defaults" disabled={busy} onClick={() => void downloadCurrent()}><Icon name="download" /><span>Download</span></button>
      {mergeItems.length > 0 && !mergeOpen && <button className="ma-tool-btn stack" title="Open merge stack" onClick={() => setMergeOpen(true)}><Icon name="merge" /><span>Stack</span><b className="ma-count">{mergeItems.length}</b></button>}
    </div>

    {media.kind === 'image' && settings.showRotateControls && <><button className="ma-rotate-btn left" style={{ left: Math.max(82, media.rect.left + 12), top: rotateTop }} title="Rotate left" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); rotate(-1); }}><Icon name="rotate-left" size={22} /><span>Rotate left</span></button><button className="ma-rotate-btn right" style={{ left: Math.min(innerWidth - 52, media.rect.right - 50), top: rotateTop }} title="Rotate right" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); rotate(1); }}><Icon name="rotate-right" size={22} /><span>Rotate right</span></button></>}

    {quickPanel === 'resize' && media.kind === 'image' && <div style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft }}><ResizePanel settings={settings} current={transform.resize} onApply={(resize) => setTransform((current) => ({ ...current, resize }))} onClose={() => setQuickPanel(null)} /></div>}
    {quickPanel === 'compress' && media.kind === 'image' && <div style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft + 42 }}><CompressPanel settings={settings} busy={busy} onDownload={(maxKB, format) => void downloadCurrent(maxKB, format)} onClose={() => setQuickPanel(null)} /></div>}
    {quickPanel === 'pdf-compress' && media.kind === 'pdf' && <div style={{ position: 'fixed', top: toolbarTop + 43, left: toolbarLeft + 42 }}><PdfCompressPanel settings={settings} busy={busy} onDownload={(maxKB) => void compressCurrentPdf(maxKB)} onClose={() => setQuickPanel(null)} /></div>}
    {cropMode && media.kind === 'image' && <CropOverlay imageRect={cropRect} initial={transform.crop} onCancel={() => { setCropMode(false); setPendingPipeline(null); }} onConfirm={(crop) => { setTransform((current) => ({ ...current, crop })); setCropMode(false); if (pendingPipeline) void runPipeline(pendingPipeline.profile, pendingPipeline.source, crop); }} />}
    {mergeOpen && <MergeWorkspace items={mergeItems} settings={settings} onItemsChange={setMergeItems} onClose={() => setMergeOpen(false)} onToast={toast} />}
    {/* role="status" + aria-live lets screen readers announce toast messages automatically */}
    <div className="ma-toast-stack" role="status" aria-live="polite" aria-atomic="false">{toasts.map((item) => <div key={item.id} className={`ma-toast${item.error ? ' error' : ''}`}>{item.message}</div>)}</div>
  </div>;
}
