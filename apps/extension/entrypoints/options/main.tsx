import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/pages.css';
import { getSettings, saveSettings, type AppSettings, type CropRatio, type PresetTemplate } from '../../src/storage/settings';
import type { FilenamePreset, MediaProfile, PipelineStep } from '../../src/types/profile';
import type { ImageFormat, MergeLayout } from '../../src/types/media';
import { createId } from '../../src/utils/id';
import { Icon, type IconName } from '../../src/components/Icon';
import { billingRequest } from '../../src/billing/client';
import { availableStepTypes, validatePipeline } from '../../src/profiles/pipeline';
import type { AccountData, BillingProduct } from '../../src/billing/types';

type Tab = 'general' | 'crop' | 'resize' | 'compress' | 'filename' | 'merge' | 'pipelines' | 'account' | 'backup';

const NAV: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'crop', label: 'Crop', icon: 'crop' },
  { id: 'resize', label: 'Resize', icon: 'resize' },
  { id: 'compress', label: 'Compress', icon: 'compress' },
  { id: 'filename', label: 'Download name', icon: 'download' },
  { id: 'merge', label: 'Merge & PDF', icon: 'merge' },
  { id: 'pipelines', label: 'Pipelines', icon: 'spark' },
  { id: 'account', label: 'Account & billing', icon: 'lock' },
  { id: 'backup', label: 'Backup & privacy', icon: 'file' },
];

const FILENAME_PRESETS: Array<{ value: FilenamePreset; label: string; template: string }> = [
  { value: 'original', label: 'Keep original name', template: '{original}' },
  { value: 'datetime', label: 'Current date and time', template: '{datetime}' },
  { value: 'date-counter', label: 'Date + counter', template: '{date}_{counter}' },
  { value: 'profile-datetime', label: 'Pipeline + date/time', template: '{profile}_{datetime}' },
  { value: 'prefix-datetime', label: 'Custom prefix + date/time', template: '{prefix}_{datetime}' },
  { value: 'dimensions-date', label: 'Dimensions + date', template: '{width}x{height}_{date}' },
  { value: 'advanced', label: 'Advanced template', template: '{profile}_{datetime}_{counter}' },
];

interface BillingStatus {
  signedIn: boolean;
  email?: string;
  premium: boolean;
  entitlement?: { subscriptionExpiresAt: number };
  reason?: string;
  deviceId: string;
  settingsRevision?: number;
  settingsSyncPending?: boolean;
  lastSettingsSyncAt?: number;
}

type ServerTemplate = PresetTemplate & { disabled?: boolean };

const stepLabel: Record<PipelineStep['type'], string> = {
  crop: 'Crop', rotate: 'Rotate', resize: 'Resize', format: 'Format', compress: 'File size', filename: 'Filename', download: 'Download',
};

const stepIcon: Record<PipelineStep['type'], IconName> = {
  crop: 'crop',
  rotate: 'rotate-right',
  resize: 'resize',
  format: 'file',
  compress: 'compress',
  filename: 'download',
  download: 'download',
};

function newStep(type: PipelineStep['type']): PipelineStep {
  const id = createId();
  switch (type) {
    case 'crop': return { id, type, mode: 'ask', ratio: 'free' };
    case 'rotate': return { id, type, degrees: 90 };
    case 'resize': return { id, type, width: 800, height: undefined, fit: 'contain', allowUpscale: false };
    case 'format': return { id, type, format: 'jpeg' };
    case 'compress': return { id, type, minKB: undefined, maxKB: 50, allowDimensionReduction: true };
    case 'filename': return { id, type, preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true };
    case 'download': return { id, type, automatic: true };
  }
}

const QUICK_START_TEMPLATES: Array<{ name: string; tag: string; description: string; steps: PipelineStep[] }> = [
  {
    name: 'Photo Upload',
    tag: 'PHOTO',
    description: 'Rotate if needed -> Crop to 1:1 -> Resize 160x200 -> JPEG -> Under 50 KB',
    steps: [
      { id: '', type: 'rotate', degrees: 90 },
      { id: '', type: 'crop', mode: 'preset', ratio: '1:1' },
      { id: '', type: 'resize', width: 160, height: 200, fit: 'contain', allowUpscale: true },
      { id: '', type: 'format', format: 'jpeg' },
      { id: '', type: 'compress', maxKB: 50, allowDimensionReduction: true },
      { id: '', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true },
      { id: '', type: 'download', automatic: true },
    ],
  },
  {
    name: 'Signature',
    tag: 'SIGN',
    description: 'Crop free -> Resize 256x64 -> JPEG -> Under 20 KB',
    steps: [
      { id: '', type: 'crop', mode: 'ask', ratio: 'free' },
      { id: '', type: 'resize', width: 256, height: 64, fit: 'stretch', allowUpscale: true },
      { id: '', type: 'format', format: 'jpeg' },
      { id: '', type: 'compress', maxKB: 20, allowDimensionReduction: true },
      { id: '', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true },
      { id: '', type: 'download', automatic: true },
    ],
  },
  {
    name: 'WhatsApp Share',
    tag: 'SHARE',
    description: 'Resize to 1280 wide -> JPEG -> Under 500 KB',
    steps: [
      { id: '', type: 'resize', width: 1280, height: undefined, fit: 'contain', allowUpscale: false },
      { id: '', type: 'format', format: 'jpeg' },
      { id: '', type: 'compress', maxKB: 500, allowDimensionReduction: false },
      { id: '', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true },
      { id: '', type: 'download', automatic: true },
    ],
  },
  {
    name: 'Passport Photo',
    tag: 'PASS',
    description: 'Crop free -> Resize 413x531 -> JPEG -> Under 100 KB',
    steps: [
      { id: '', type: 'crop', mode: 'ask', ratio: 'free' },
      { id: '', type: 'resize', width: 413, height: 531, fit: 'cover', allowUpscale: true },
      { id: '', type: 'format', format: 'jpeg' },
      { id: '', type: 'compress', maxKB: 100, allowDimensionReduction: true },
      { id: '', type: 'filename', preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true },
      { id: '', type: 'download', automatic: true },
    ],
  },
];

function makeQuickStartPipeline(template: typeof QUICK_START_TEMPLATES[number]): MediaProfile {
  return {
    id: createId(),
    name: template.name,
    tag: template.tag,
    pinned: true,
    inputCount: 1,
    mergeLayout: 'vertical',
    background: '#ffffff',
    steps: template.steps.map((step) => ({ ...step, id: createId() } as PipelineStep)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function blankPipeline(): MediaProfile {
  return {
    id: createId(), name: 'Upload1', tag: 'UP1', pinned: true, inputCount: 1, mergeLayout: 'vertical', background: '#ffffff',
    steps: [newStep('crop'), newStep('resize'), newStep('format'), newStep('compress'), newStep('filename'), newStep('download')],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function serverStep(step: unknown): PipelineStep | null {
  if (!isRecord(step) || typeof step.type !== 'string') return null;
  return { ...step, id: typeof step.id === 'string' ? step.id : createId() } as PipelineStep;
}

function serverPipeline(template: ServerTemplate): MediaProfile {
  const payload = template.payload;
  const steps = Array.isArray(payload.steps) ? payload.steps.map(serverStep).filter((step): step is PipelineStep => Boolean(step)) : [];
  return {
    id: template.id,
    name: template.name,
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 8) : undefined,
    pinned: payload.pinned !== false,
    inputCount: Math.max(1, Math.min(20, Number(payload.inputCount) || 1)),
    mergeLayout: payload.mergeLayout === 'horizontal' || payload.mergeLayout === 'grid' ? payload.mergeLayout : 'vertical',
    background: typeof payload.background === 'string' ? payload.background : '#ffffff',
    steps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const IMAGE_TEMPLATE_KEYS: Array<keyof AppSettings> = [
  'defaultFilenameTemplate',
  'defaultFormat',
  'defaultWidth',
  'defaultHeight',
  'defaultMinKB',
  'defaultMaxKB',
  'defaultQuality',
  'minimumQuality',
  'allowDimensionReduction',
  'allowUpscale',
  'defaultResizeFit',
  'defaultCropRatio',
  'removeSpacesByDefault',
  'removeSpecialCharactersByDefault',
];

const CROP_TEMPLATE_KEYS: Array<keyof AppSettings> = [
  'defaultCropRatio',
];

const RESIZE_TEMPLATE_KEYS: Array<keyof AppSettings> = [
  'defaultWidth',
  'defaultHeight',
  'allowUpscale',
  'defaultResizeFit',
];

const COMPRESS_TEMPLATE_KEYS: Array<keyof AppSettings> = [
  'defaultFormat',
  'defaultMinKB',
  'defaultMaxKB',
  'defaultQuality',
  'minimumQuality',
  'allowDimensionReduction',
];

const MERGE_TEMPLATE_KEYS: Array<keyof AppSettings> = [
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

function pickSettingsPatch(payload: Record<string, unknown>, keys: Array<keyof AppSettings>): Partial<AppSettings> {
  const patch: Partial<Record<keyof AppSettings, unknown>> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) patch[key] = payload[key];
  }
  return patch as Partial<AppSettings>;
}

function Toggle({ checked, onChange, label, title }: { checked: boolean; onChange: (value: boolean) => void; label: string; title?: string }) {
  return <label className="toggle" title={title}><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label className={`field${full ? ' full' : ''}`}><span>{label}</span>{children}</label>;
}

function NumberField({ value, onChange, placeholder, min = 0, max }: { value?: number; onChange: (value?: number) => void; placeholder?: string; min?: number; max?: number }) {
  return <input className="input" type="number" value={value ?? ''} placeholder={placeholder} min={min} max={max} onChange={(event) => {
    if (!event.target.value) return onChange(undefined);
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) onChange(Math.max(min, max ? Math.min(max, parsed) : parsed));
  }} />;
}

const stepDescription: Record<PipelineStep['type'], string> = {
  crop: 'Trim the image to a specific shape or ratio',
  rotate: 'Rotate the image by a fixed number of degrees',
  resize: 'Change the output pixel dimensions',
  format: 'Convert to JPEG, PNG, or WebP',
  compress: 'Reduce file size - highest quality that fits under the max KB',
  filename: 'Rename the downloaded file',
  download: 'Save the result to your device',
};

function stepSummary(step: PipelineStep): string {
  if (step.type === 'crop') return step.mode === 'ask' ? 'Manual' : `Ratio ${step.ratio}`;
  if (step.type === 'rotate') return `${step.degrees > 0 ? step.degrees + ' deg right' : Math.abs(step.degrees) + ' deg left'}`;
  if (step.type === 'resize') return [step.width, step.height].filter(Boolean).join('x') || 'Custom';
  if (step.type === 'format') return step.format.toUpperCase();
  if (step.type === 'compress') return step.maxKB ? `<= ${step.maxKB} KB` : 'Quality only';
  if (step.type === 'filename') return step.preset;
  if (step.type === 'download') return step.automatic ? 'Auto' : 'Confirm';
  return '';
}

function PipelineStrip({ steps }: { steps: PipelineStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="pipeline-strip">
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          {index > 0 && <span className="strip-arrow">-&gt;</span>}
          <span className="strip-step">
            <b>{stepLabel[step.type]}</b>
            <small>{stepSummary(step)}</small>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function StepEditor({ step, onChange, onDelete, onDragStart, onDragOver, onDrop }: {
  step: PipelineStep; onChange: (step: PipelineStep) => void; onDelete: () => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void;
}) {
  const update = (patch: Partial<PipelineStep>) => onChange({ ...step, ...patch } as PipelineStep);
  return <article className={"step-card step-card-" + step.type} draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
    <div className="step-head">
      <div className="step-title">
        <div className="step-drag-handle" title="Drag to reorder">::</div>
        <span className="step-icon"><Icon name={stepIcon[step.type]} size={16} /></span>
        <span>
          <strong>{stepLabel[step.type]}</strong>
          <small>{stepSummary(step)}</small>
        </span>
      </div>
      <button className="delete" onClick={onDelete} aria-label={"Delete " + stepLabel[step.type] + " step"}><Icon name="trash" /></button>
    </div>
    <p className="step-hint">{stepDescription[step.type]}</p>
    <div className="step-fields">
      {step.type === 'crop' && <><Field label="Mode"><select className="select" value={step.mode} onChange={(e) => update({ mode: e.target.value as 'ask' | 'preset' })}><option value="ask">Ask each time</option><option value="preset">Use preset</option></select></Field><Field label="Ratio"><select className="select" value={step.ratio} onChange={(e) => update({ ratio: e.target.value as CropRatio })}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></Field></>}
      {step.type === 'rotate' && <Field label="Rotation"><select className="select" value={step.degrees} onChange={(e) => update({ degrees: Number(e.target.value) as -90 | 90 | 180 })}><option value="-90">90 deg left</option><option value="90">90 deg right</option><option value="180">180 deg</option></select></Field>}
      {step.type === 'resize' && <><Field label="Width"><NumberField value={step.width} onChange={(width) => update({ width })} /></Field><Field label="Height"><NumberField value={step.height} onChange={(height) => update({ height })} /></Field><Field label="Fit"><select className="select" value={step.fit} onChange={(e) => update({ fit: e.target.value as 'contain' | 'cover' | 'stretch' })}><option value="contain">Contain (letterbox)</option><option value="cover">Fill &amp; Crop</option><option value="stretch">Stretch</option></select></Field><Toggle checked={step.allowUpscale} onChange={(allowUpscale) => update({ allowUpscale })} label="Allow enlargement" /></>}
      {step.type === 'format' && <Field label="Output"><select className="select" value={step.format} onChange={(e) => update({ format: e.target.value as ImageFormat | 'pdf' })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="pdf">PDF</option></select></Field>}
      {step.type === 'compress' && <>
        <Field label="Maximum KB"><NumberField value={step.maxKB} onChange={(maxKB) => update({ maxKB })} placeholder="No limit" /></Field>
        <Field label="Minimum KB"><NumberField value={step.minKB} onChange={(minKB) => update({ minKB })} placeholder="None" /></Field>
        <Toggle
          checked={Boolean(step.allowDimensionReduction)}
          onChange={(allowDimensionReduction) => update({ allowDimensionReduction })}
          label="Shrink dimensions if needed"
          title="Reduce image dimensions if quality reduction alone cannot reach the maximum size target."
        />
      </>}
      {step.type === 'filename' && <>
        <Field label="Style" full><select className="select" value={step.preset} onChange={(e) => { const preset = FILENAME_PRESETS.find((item) => item.value === e.target.value)!; update({ preset: preset.value, template: preset.template }); }}>{FILENAME_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
        {step.preset === 'prefix-datetime' && <Field label="Prefix"><input className="input" value={step.prefix ?? ''} onChange={(e) => update({ prefix: e.target.value })} /></Field>}
        {step.preset === 'advanced' && <Field label="Template" full><input className="input mono" value={step.template} onChange={(e) => update({ template: e.target.value })} /></Field>}
        <Toggle checked={step.removeSpaces} onChange={(removeSpaces) => update({ removeSpaces })} label="Remove spaces" />
        <Toggle checked={step.removeSpecialCharacters} onChange={(removeSpecialCharacters) => update({ removeSpecialCharacters })} label="Remove special characters" />
      </>}
      {step.type === 'download' && <Toggle checked={step.automatic} onChange={(automatic) => update({ automatic })} label="Download automatically" />}
    </div>
  </article>;
}

function ServerPresetList({ title, templates, disabled, onApply, onToggle, onDelete }: { title: string; templates: ServerTemplate[]; disabled?: boolean; onApply: (template: ServerTemplate) => void; onToggle: (template: ServerTemplate) => void; onDelete: (template: ServerTemplate) => void }) {
  if (!templates.length) return null;
  return <Card title={title}><div className="pipeline-list">{templates.map((template) => <article key={template.id}><div><h3>{template.name}</h3><span>{template.disabled ? 'Disabled' : (template.source === 'local' ? 'Local preset' : 'Server preset')}</span></div><div><button className="btn primary" disabled={disabled || template.disabled} onClick={() => onApply(template)}>Apply preset</button><button className="btn ghost" disabled={disabled} onClick={() => onToggle(template)}>{template.disabled ? 'Enable' : 'Disable'}</button><button className="btn danger" disabled={disabled} onClick={() => onDelete(template)}>Delete</button></div></article>)}</div></Card>;
}

function Options() {
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<MediaProfile | null>(null);
  const [addStepType, setAddStepType] = useState<PipelineStep['type']>('crop');
  const [notice, setNotice] = useState('');
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR');
  const [product, setProduct] = useState<BillingProduct | null>(null);
  const [serverTemplates, setServerTemplates] = useState<ServerTemplate[]>([]);
  const checkoutPoll = useRef<number | null>(null);

  useEffect(() => { void Promise.all([
    getSettings(),
    billingRequest<BillingStatus>({ type: 'billing:get-status' }),
    billingRequest<BillingProduct>({ type: 'billing:get-product' }).catch(() => ({ name: 'WhatsApp Media Assist Pro', duration_days: 365, prices: [{ currency: 'INR' as const, amount_minor: 50000, label: '₹500 / 365 days' }] })),
  ]).then(([settings, status, billingProduct]) => {
    setForm(settings); setSaved(settings); setBilling(status); setEmail(status.email ?? ''); setProduct(billingProduct);
    if (billingProduct.prices.length && !billingProduct.prices.some((price) => price.currency === currency)) setCurrency(billingProduct.prices[0]!.currency);
    if (status.signedIn && status.premium) {
      void billingRequest<ServerTemplate[]>({ type: 'billing:get-templates' })
        .then(setServerTemplates).catch(() => undefined);
    } else {
      setServerTemplates([]);
    }
  }); }, []);
  useEffect(() => () => { if (checkoutPoll.current !== null) window.clearInterval(checkoutPoll.current); }, []);
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved));
  const premium = billing?.premium ?? false;
  const draftValidation = useMemo(() => draft ? validatePipeline(draft) : { errors: [], warnings: [] }, [draft]);
  const unusedStepTypes = useMemo(() => draft ? availableStepTypes(draft) : [], [draft]);
  const allTemplates = useMemo(() => {
    if (!form) return [];
    const deleted = new Set(form.deletedTemplateIds);
    const disabled = new Set(form.disabledTemplateIds);
    const remote = serverTemplates.map((template) => ({ ...template, source: 'server' as const }));
    const local = form.localTemplates.map((template) => ({ ...template, source: 'local' as const }));
    return [...remote, ...local]
      .filter((template) => !deleted.has(template.id))
      .map((template) => ({ ...template, disabled: disabled.has(template.id) }));
  }, [form, serverTemplates]);
  const activeTemplates = useMemo(() => allTemplates.filter((template) => !template.disabled), [allTemplates]);
  const imageTemplates = useMemo(() => allTemplates.filter((template) => ['image_defaults', 'crop', 'resize', 'compress'].includes(template.category)), [allTemplates]);
  const activeImageTemplates = useMemo(() => activeTemplates.filter((template) => ['image_defaults', 'crop', 'resize', 'compress'].includes(template.category)), [activeTemplates]);
  const cropTemplates = useMemo(() => imageTemplates.filter((template) => {
    if (template.category === 'crop') return true;
    if (template.category !== 'image_defaults') return false;
    const ratio = template.payload.defaultCropRatio;
    return ratio && ratio !== 'free' && ratio !== 'original';
  }), [imageTemplates]);
  const activeCropTemplates = useMemo(() => activeImageTemplates.filter((template) => {
    if (template.category === 'crop') return true;
    if (template.category !== 'image_defaults') return false;
    const ratio = template.payload.defaultCropRatio;
    return ratio && ratio !== 'free' && ratio !== 'original';
  }), [activeImageTemplates]);
  const resizeTemplates = useMemo(() => imageTemplates.filter((template) => {
    if (template.category === 'resize') return true;
    if (template.category !== 'image_defaults') return false;
    return template.payload.defaultWidth || template.payload.defaultHeight;
  }), [imageTemplates]);
  const activeResizeTemplates = useMemo(() => activeImageTemplates.filter((template) => {
    if (template.category === 'resize') return true;
    if (template.category !== 'image_defaults') return false;
    return template.payload.defaultWidth || template.payload.defaultHeight;
  }), [activeImageTemplates]);
  const compressTemplates = useMemo(() => imageTemplates.filter((template) => {
    if (template.category === 'compress') return true;
    if (template.category !== 'image_defaults') return false;
    return template.payload.defaultMaxKB || template.payload.defaultQuality || template.payload.defaultFormat;
  }), [imageTemplates]);
  const activeCompressTemplates = useMemo(() => activeImageTemplates.filter((template) => {
    if (template.category === 'compress') return true;
    if (template.category !== 'image_defaults') return false;
    return template.payload.defaultMaxKB || template.payload.defaultQuality || template.payload.defaultFormat;
  }), [activeImageTemplates]);
  const mergeTemplates = useMemo(() => allTemplates.filter((template) => template.category === 'merge_pdf'), [allTemplates]);
  const activeMergeTemplates = useMemo(() => activeTemplates.filter((template) => template.category === 'merge_pdf'), [activeTemplates]);
  const pipelineTemplates = useMemo(() => allTemplates.filter((template) => template.category === 'pipelines'), [allTemplates]);

  const flash = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(''), 2600); };
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const commit = async (next = form) => { if (!next) return; await saveSettings(next); const normalized = await getSettings(); setForm(normalized); setSaved(normalized); flash('Saved'); };

  const pollForActivation = () => {
    if (checkoutPoll.current !== null) window.clearInterval(checkoutPoll.current);
    let attempts = 0;
    checkoutPoll.current = window.setInterval(() => {
      attempts += 1;
      void billingRequest<AccountData>({ type: 'billing:get-account' }).then(async (nextAccount) => {
        setAccount(nextAccount);
        const status = await billingRequest<BillingStatus>({ type: 'billing:get-status' });
        setBilling(status);
        if (status.premium || attempts >= 30) {
          if (checkoutPoll.current !== null) window.clearInterval(checkoutPoll.current);
          checkoutPoll.current = null;
          if (status.premium) flash('Pro activated');
        }
      }).catch(() => {
        if (attempts >= 30 && checkoutPoll.current !== null) {
          window.clearInterval(checkoutPoll.current);
          checkoutPoll.current = null;
        }
      });
    }, 4000);
  };

  const refreshBilling = async () => {
    setBillingBusy(true);
    try {
      const status = await billingRequest<BillingStatus>({ type: 'billing:refresh' });
      setBilling(status);
      if (status.signedIn) {
        setAccount(await billingRequest<AccountData>({ type: 'billing:get-account' }));
        const syncedSettings = await getSettings();
        setForm(syncedSettings);
        setSaved(syncedSettings);
        if (status.premium) {
          void billingRequest<ServerTemplate[]>({ type: 'billing:get-templates' })
            .then(setServerTemplates).catch(() => undefined);
        } else {
          setServerTemplates([]);
        }
      }
    } catch (error) { flash(error instanceof Error ? error.message : 'Could not refresh'); }
    finally { setBillingBusy(false); }
  };

  const savePipeline = async () => {
    if (!form || !draft || !premium) return;
    if (!draft.name.trim()) return flash('Name is required');
    if (!draft.steps.length) return flash('Add at least one step');
    const validation = validatePipeline(draft);
    if (validation.errors.length) return flash(validation.errors[0]!);
    const nextProfile = { ...draft, name: draft.name.trim(), tag: draft.tag?.trim().slice(0, 8) || undefined, inputCount: Math.max(1, Math.min(20, draft.inputCount)), updatedAt: Date.now() };
    const profiles = form.profiles.some((item) => item.id === nextProfile.id) ? form.profiles.map((item) => item.id === nextProfile.id ? nextProfile : item) : [...form.profiles, nextProfile];
    const next = { ...form, profiles };
    setDraft(null); setForm(next); await commit(next);
  };

  const applyServerTemplate = async (template: ServerTemplate) => {
    if (!form) return;
    if (template.category === 'pipelines') {
      if (!premium) return flash('Pro is required');
      const profile = serverPipeline(template);
      const validation = validatePipeline(profile);
      if (validation.errors.length) return flash(validation.errors[0]!);
      const nextProfile = { ...profile, updatedAt: Date.now() };
      const profiles = form.profiles.some((item) => item.id === nextProfile.id)
        ? form.profiles.map((item) => item.id === nextProfile.id ? nextProfile : item)
        : [...form.profiles, nextProfile];
      const next = { ...form, profiles };
      setForm(next);
      await commit(next);
      flash('Preset added');
      return;
    }

    const templatePatch =
      template.category === 'crop' ? pickSettingsPatch(template.payload, CROP_TEMPLATE_KEYS) :
      template.category === 'resize' ? pickSettingsPatch(template.payload, RESIZE_TEMPLATE_KEYS) :
      template.category === 'compress' ? pickSettingsPatch(template.payload, COMPRESS_TEMPLATE_KEYS) :
      template.category === 'image_defaults' ? pickSettingsPatch(template.payload, IMAGE_TEMPLATE_KEYS) :
      template.category === 'merge_pdf' ? pickSettingsPatch(template.payload, MERGE_TEMPLATE_KEYS) :
      null;
    if (!templatePatch) return flash('Unsupported preset');
    const next = { ...form, ...templatePatch };
    setForm(next);
    await commit(next);
    flash('Preset applied');
  };

  const applyDefaultPreset = async (templateId: string, presetKey: 'defaultCropPresetId' | 'defaultResizePresetId' | 'defaultCompressPresetId' | 'defaultMergePresetId', templates: ServerTemplate[], keys: Array<keyof AppSettings>) => {
    if (!form) return;
    if (!templateId) {
      const next = { ...form, [presetKey]: undefined };
      setForm(next);
      await commit(next);
      return;
    }
    const template = templates.find((item) => item.id === templateId);
    if (!template) return flash('Preset not found');
    const next = { ...form, ...pickSettingsPatch(template.payload, keys), [presetKey]: template.id };
    setForm(next);
    await commit(next);
    flash('Default preset saved');
  };

  const clearTemplateReferences = (settings: AppSettings, templateId: string): AppSettings => ({
    ...settings,
    defaultCropPresetId: settings.defaultCropPresetId === templateId ? undefined : settings.defaultCropPresetId,
    defaultResizePresetId: settings.defaultResizePresetId === templateId ? undefined : settings.defaultResizePresetId,
    defaultCompressPresetId: settings.defaultCompressPresetId === templateId ? undefined : settings.defaultCompressPresetId,
    defaultMergePresetId: settings.defaultMergePresetId === templateId ? undefined : settings.defaultMergePresetId,
    profiles: settings.profiles.filter((profile) => profile.id !== templateId),
  });

  const toggleTemplate = async (template: ServerTemplate) => {
    if (!form) return;
    const disabled = new Set(form.disabledTemplateIds);
    if (disabled.has(template.id)) disabled.delete(template.id);
    else disabled.add(template.id);
    const next = clearTemplateReferences({ ...form, disabledTemplateIds: [...disabled] }, template.id);
    setForm(next);
    await commit(next);
    flash(disabled.has(template.id) ? 'Preset disabled' : 'Preset enabled');
  };

  const deleteTemplate = async (template: ServerTemplate) => {
    if (!form) return;
    if (!window.confirm(`Delete ${template.name}?`)) return;
    const next = clearTemplateReferences({
      ...form,
      localTemplates: form.localTemplates.filter((item) => item.id !== template.id),
      deletedTemplateIds: template.source === 'local' ? form.deletedTemplateIds.filter((id) => id !== template.id) : [...new Set([...form.deletedTemplateIds, template.id])],
      disabledTemplateIds: form.disabledTemplateIds.filter((id) => id !== template.id),
    }, template.id);
    setForm(next);
    await commit(next);
    flash('Preset deleted');
  };

  const createLocalTemplate = async (category: ServerTemplate['category'], payload: Record<string, unknown>, fallbackName: string) => {
    if (!form) return;
    const name = window.prompt('Preset name', fallbackName)?.trim();
    if (!name) return;
    const template: PresetTemplate = { id: `local:${createId()}`, name, category, payload, source: 'local', createdAt: Date.now() };
    const next = { ...form, localTemplates: [...form.localTemplates, template] };
    setForm(next);
    await commit(next);
    flash('Preset created');
  };

  const createCropPreset = () => form && void createLocalTemplate('image_defaults', { defaultCropRatio: form.defaultCropRatio }, 'Crop preset');
  const createResizePreset = () => form && void createLocalTemplate('image_defaults', { defaultWidth: form.defaultWidth, defaultHeight: form.defaultHeight, defaultResizeFit: form.defaultResizeFit, allowUpscale: form.allowUpscale }, 'Resize preset');
  const createCompressPreset = () => form && void createLocalTemplate('image_defaults', { defaultFormat: form.defaultFormat, defaultMinKB: form.defaultMinKB, defaultMaxKB: form.defaultMaxKB, defaultQuality: form.defaultQuality, minimumQuality: form.minimumQuality, allowDimensionReduction: form.allowDimensionReduction }, 'Compression preset');
  const createMergePreset = () => form && void createLocalTemplate('merge_pdf', pickSettingsPatch(form as unknown as Record<string, unknown>, MERGE_TEMPLATE_KEYS), 'Merge preset');

  if (!form || !billing) return <main className="loading">Loading…</main>;

  return <main className="page">
    <header className="topbar"><div className="brand"><img src="/icons/icon-48.png" alt="" /><div><h1>WhatsApp Media Assist</h1><span>Settings</span></div></div><div className="actions">{notice && <span className="notice">{notice}</span>}<button className="btn ghost" disabled={!dirty} onClick={() => setForm(saved)}>Discard</button><button className="btn primary" disabled={!dirty} onClick={() => void commit()}>Save</button></div></header>
    <div className="shell">
      <aside><div className="state"><span className={form.enabled ? 'on' : ''} /><b>{form.enabled ? 'Enabled' : 'Paused'}</b></div><nav>{NAV.map((item) => <button className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} key={item.id}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav></aside>
      <section className="content">
        {tab === 'general' && <><Title title="General" /><Card title="Extension"><div className="grid"><Toggle checked={form.enabled} onChange={(value) => patch('enabled', value)} label="Enable extension" /><Toggle checked={form.showToolbarLabels} onChange={(value) => patch('showToolbarLabels', value)} label="Show button names" /><Toggle checked={form.showRotateControls} onChange={(value) => patch('showRotateControls', value)} label="Show rotate buttons" /></div></Card></>}
        {tab === 'crop' && <><Title title="Crop" action={<button className="btn primary" disabled={!premium} onClick={createCropPreset}><Icon name="plus" />New preset</button>} /><Card title="Default crop preset"><div className="grid"><Field label="Preset"><select className="select" value={form.defaultCropPresetId ?? ''} disabled={!premium || !activeCropTemplates.length} onChange={(e) => void applyDefaultPreset(e.target.value, 'defaultCropPresetId', activeCropTemplates, CROP_TEMPLATE_KEYS)}><option value="">Manual crop settings</option>{activeCropTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field><Field label="Crop ratio"><select className="select" value={form.defaultCropRatio} onChange={(e) => patch('defaultCropRatio', e.target.value as CropRatio)}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></Field></div></Card><ServerPresetList title="Available crop presets" templates={cropTemplates} disabled={!premium} onApply={(template) => void applyDefaultPreset(template.id, 'defaultCropPresetId', cropTemplates, CROP_TEMPLATE_KEYS)} onToggle={(template) => void toggleTemplate(template)} onDelete={(template) => void deleteTemplate(template)} /></>}
        {tab === 'resize' && <><Title title="Resize" action={<button className="btn primary" disabled={!premium} onClick={createResizePreset}><Icon name="plus" />New preset</button>} /><Card title="Default resize preset"><div className="grid"><Field label="Preset"><select className="select" value={form.defaultResizePresetId ?? ''} disabled={!premium || !activeResizeTemplates.length} onChange={(e) => void applyDefaultPreset(e.target.value, 'defaultResizePresetId', activeResizeTemplates, RESIZE_TEMPLATE_KEYS)}><option value="">Manual resize settings</option>{activeResizeTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field><Field label="Width"><NumberField value={form.defaultWidth} onChange={(value) => patch('defaultWidth', value)} /></Field><Field label="Height"><NumberField value={form.defaultHeight} onChange={(value) => patch('defaultHeight', value)} /></Field><Field label="Fit"><select className="select" value={form.defaultResizeFit} onChange={(e) => patch('defaultResizeFit', e.target.value as AppSettings['defaultResizeFit'])}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></Field><Toggle checked={form.allowUpscale} onChange={(value) => patch('allowUpscale', value)} label="Allow enlargement" /></div></Card><ServerPresetList title="Available resize presets" templates={resizeTemplates} disabled={!premium} onApply={(template) => void applyDefaultPreset(template.id, 'defaultResizePresetId', resizeTemplates, RESIZE_TEMPLATE_KEYS)} onToggle={(template) => void toggleTemplate(template)} onDelete={(template) => void deleteTemplate(template)} /></>}
        {tab === 'compress' && <><Title title="Compress" action={<button className="btn primary" disabled={!premium} onClick={createCompressPreset}><Icon name="plus" />New preset</button>} /><Card title="Default compression preset"><div className="grid"><Field label="Preset"><select className="select" value={form.defaultCompressPresetId ?? ''} disabled={!premium || !activeCompressTemplates.length} onChange={(e) => void applyDefaultPreset(e.target.value, 'defaultCompressPresetId', activeCompressTemplates, COMPRESS_TEMPLATE_KEYS)}><option value="">Manual compression settings</option>{activeCompressTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field><Field label="Format"><select className="select" value={form.defaultFormat} onChange={(e) => patch('defaultFormat', e.target.value as ImageFormat)}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></Field><Field label="Minimum KB"><NumberField value={form.defaultMinKB} onChange={(value) => patch('defaultMinKB', value)} /></Field><Field label="Maximum KB"><NumberField value={form.defaultMaxKB} onChange={(value) => patch('defaultMaxKB', value)} /></Field><Field label="Quality %"><input className="input" type="number" min="35" max="100" value={form.defaultQuality} onChange={(e) => patch('defaultQuality', Number(e.target.value))} /></Field><Field label="Minimum quality"><input className="input" type="number" min="20" max="90" value={form.minimumQuality} onChange={(e) => patch('minimumQuality', Number(e.target.value))} /></Field><Toggle checked={form.allowDimensionReduction} onChange={(value) => patch('allowDimensionReduction', value)} label="Reduce dimensions if needed" /></div></Card><ServerPresetList title="Available compression presets" templates={compressTemplates} disabled={!premium} onApply={(template) => void applyDefaultPreset(template.id, 'defaultCompressPresetId', compressTemplates, COMPRESS_TEMPLATE_KEYS)} onToggle={(template) => void toggleTemplate(template)} onDelete={(template) => void deleteTemplate(template)} /></>}
        {tab === 'filename' && <><Title title="Download name" /><Card title="Direct download naming"><div className="grid"><Field label="Name preset"><select className="select" value={FILENAME_PRESETS.find((item) => item.template === form.defaultFilenameTemplate)?.value ?? 'advanced'} onChange={(e) => { const preset = FILENAME_PRESETS.find((item) => item.value === e.target.value)!; patch('defaultFilenameTemplate', preset.template); }}><option value="original">Keep original name</option><option value="datetime">Current date and time</option><option value="date-counter">Date + counter</option><option value="dimensions-date">Dimensions + date</option><option value="advanced">Advanced template</option></select></Field><Field label="Template"><input className="input mono" value={form.defaultFilenameTemplate} onChange={(e) => patch('defaultFilenameTemplate', e.target.value)} /></Field><Toggle checked={form.removeSpacesByDefault} onChange={(value) => patch('removeSpacesByDefault', value)} label="Remove spaces" /><Toggle checked={form.removeSpecialCharactersByDefault} onChange={(value) => patch('removeSpecialCharactersByDefault', value)} label="Remove special characters" /></div></Card></>}
        {tab === 'merge' && <><Title title="Merge & PDF" action={<button className="btn primary" disabled={!premium} onClick={createMergePreset}><Icon name="plus" />New preset</button>} /><Card title="Default merge preset"><Field label="Preset"><select className="select" value={form.defaultMergePresetId ?? ''} disabled={!premium || !activeMergeTemplates.length} onChange={(e) => void applyDefaultPreset(e.target.value, 'defaultMergePresetId', activeMergeTemplates, MERGE_TEMPLATE_KEYS)}><option value="">Manual merge settings</option>{activeMergeTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></Field></Card><ServerPresetList title="Merge presets" templates={mergeTemplates} disabled={!premium} onApply={(template) => void applyDefaultPreset(template.id, 'defaultMergePresetId', mergeTemplates, MERGE_TEMPLATE_KEYS)} onToggle={(template) => void toggleTemplate(template)} onDelete={(template) => void deleteTemplate(template)} /><div className="two-col"><Card title="A4 layout"><div className="layout-buttons">{(['vertical','horizontal','grid'] as MergeLayout[]).map((layout) => <button key={layout} className={form.mergeDefaultLayout === layout ? 'selected' : ''} onClick={() => patch('mergeDefaultLayout', layout)}>{layout === 'vertical' ? 'Top & bottom' : layout === 'horizontal' ? 'Side by side' : 'Custom grid'}</button>)}</div><div className="grid"><Field label="Output"><select className="select" value={form.mergeDefaultFormat} onChange={(e) => patch('mergeDefaultFormat', e.target.value as ImageFormat | 'pdf')}><option value="pdf">PDF</option><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></Field><Field label="Target maximum KB"><NumberField value={form.mergeDefaultMaxKB} onChange={(value) => patch('mergeDefaultMaxKB', value)} /></Field><Field label="Quality %"><input className="input" type="number" min="35" max="100" value={form.mergeDefaultQuality} onChange={(e) => patch('mergeDefaultQuality', Number(e.target.value))} /></Field><Field label="Page margin"><NumberField value={form.mergeDefaultPadding} onChange={(value) => patch('mergeDefaultPadding', value ?? 0)} /></Field><Field label="Gap"><NumberField value={form.mergeDefaultGap} onChange={(value) => patch('mergeDefaultGap', value ?? 0)} /></Field><Field label="Border"><NumberField value={form.mergeDefaultBorderWidth} onChange={(value) => patch('mergeDefaultBorderWidth', value ?? 0)} /></Field><Field label="Grid columns"><NumberField min={1} max={6} value={form.mergeDefaultGridColumns} onChange={(value) => patch('mergeDefaultGridColumns', value ?? 2)} /></Field></div></Card><div className="a4"><div className={`a4-inner ${form.mergeDefaultLayout}`}>{Array.from({ length: form.mergeDefaultLayout === 'grid' ? 6 : 2 }, (_, i) => <span key={i}>{i+1}</span>)}</div></div></div></>}
        {tab === 'pipelines' && <div className="pipeline-page">
          <div className="pipeline-hero">
            <div>
              <span className="pipeline-eyebrow">Automation buttons</span>
              <h2>Pipelines</h2>
              <p>Build compact WhatsApp toolbar buttons from the actual crop, resize, format, file size, filename, and download steps.</p>
            </div>
            <button className="btn primary" disabled={!premium} onClick={() => setDraft(blankPipeline())}><Icon name="plus" />New pipeline</button>
          </div>
          {!premium && <div className="locked">Pro is required to create pipeline buttons. <button onClick={() => setTab('account')}>View Pro</button></div>}
          {premium && !draft && (
            <section className="pipeline-section quickstart-section" aria-label="Quick-start templates">
              <header className="pipeline-section-head">
                <div>
                  <span>Start from source presets</span>
                  <h3>Quick-start templates</h3>
                </div>
              </header>
              <div className="quickstart-grid">
                {QUICK_START_TEMPLATES.map((template) => (
                  <button key={template.name} className="quickstart-card" onClick={() => setDraft(makeQuickStartPipeline(template))}>
                    <span className="quickstart-tag">{template.tag}</span>
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                    <em>Customize</em>
                  </button>
                ))}
              </div>
            </section>
          )}
          {draft && <Card title={form.profiles.some((item) => item.id === draft.id) ? 'Edit pipeline' : 'New pipeline'} className="pipeline-builder-card" action={<button className="icon-btn" onClick={() => setDraft(null)}><Icon name="close" /></button>}>
            <PipelineStrip steps={draft.steps} />
            <div className="pipeline-draft-grid">
              <Field label="Button name"><input className="input" value={draft.name} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
              <Field label="Button tag"><input className="input" value={draft.tag ?? ''} maxLength={8} onChange={(e) => setDraft({ ...draft, tag: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 8) })} placeholder="UP1" /></Field>
              <Field label="Required media"><NumberField min={1} max={20} value={draft.inputCount} onChange={(inputCount) => setDraft({ ...draft, inputCount: inputCount ?? 1 })} /></Field>
              {draft.inputCount > 1 && <Field label="Merge layout"><select className="select" value={draft.mergeLayout} onChange={(e) => setDraft({ ...draft, mergeLayout: e.target.value as MergeLayout })}><option value="vertical">Top &amp; bottom</option><option value="horizontal">Side by side</option><option value="grid">Custom grid</option></select></Field>}
              <Toggle checked={draft.pinned} onChange={(pinned) => setDraft({ ...draft, pinned })} label="Show button on WhatsApp" />
            </div>
            <div className="pipeline-workbench">
              <div className="pipeline-workbench-head">
                <div>
                  <span>Execution order</span>
                  <h3>Steps</h3>
                </div>
                <div className="add-step compact-add-step">{unusedStepTypes.length > 0 ? <><select className="select" value={unusedStepTypes.includes(addStepType) ? addStepType : unusedStepTypes[0]} onChange={(e) => setAddStepType(e.target.value as PipelineStep['type'])}>{unusedStepTypes.map((value) => <option key={value} value={value}>{stepLabel[value]}</option>)}</select><button className="btn" onClick={() => { const type = unusedStepTypes.includes(addStepType) ? addStepType : unusedStepTypes[0]; if (type) setDraft({ ...draft, steps: [...draft.steps, newStep(type)] }); }}><Icon name="plus" />Add step</button></> : <span className="all-steps">All available steps added</span>}</div>
              </div>
              <div className="steps">{draft.steps.map((step, index) => {
                const reorder = (fromIndex: number, toIndex: number) => {
                  const list = [...draft.steps];
                  const [moving] = list.splice(fromIndex, 1);
                  if (moving) list.splice(toIndex, 0, moving);
                  setDraft({ ...draft, steps: list });
                };
                return <StepEditor
                  key={step.id}
                  step={step}
                  onChange={(updated) => setDraft({ ...draft, steps: draft.steps.map((item) => item.id === step.id ? updated : item) })}
                  onDelete={() => setDraft({ ...draft, steps: draft.steps.filter((item) => item.id !== step.id) })}
                  onDragStart={() => { (window as any).__stepDragIndex = index; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { const from = (window as any).__stepDragIndex; if (typeof from === 'number' && from !== index) reorder(from, index); }}
                />;
              })}</div>
            </div>
            {draftValidation.errors.length > 0 && <div className="validation-list">{draftValidation.errors.map((error) => <span key={error}>{error}</span>)}</div>}
            {draftValidation.warnings.length > 0 && <div className="validation-list warnings">{draftValidation.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
            <div className="card-actions"><button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={draftValidation.errors.length > 0} onClick={() => void savePipeline()}>Save pipeline</button></div>
          </Card>}
          <ServerPresetList title="Pipeline presets" templates={pipelineTemplates} disabled={!premium} onApply={(template) => void applyServerTemplate(template)} onToggle={(template) => void toggleTemplate(template)} onDelete={(template) => void deleteTemplate(template)} />
          <section className="pipeline-section saved-pipeline-section" aria-label="Saved pipelines">
            <header className="pipeline-section-head">
              <div>
                <span>Toolbar buttons</span>
                <h3>Saved pipelines</h3>
              </div>
            </header>
            <div className="pipeline-list">{form.profiles.map((profile) => <article key={profile.id}><div><h3>{profile.name}</h3><span>{profile.tag ? `[${profile.tag}] ` : ''}{profile.inputCount > 1 ? `${profile.inputCount} media - ` : ''}{profile.steps.map((step) => stepLabel[step.type]).join(' -> ')}</span></div><div>{profile.pinned && <b>Pinned</b>}<button className="btn ghost" disabled={!premium} onClick={() => setDraft(structuredClone(profile))}>Edit</button><button className="btn danger" disabled={!premium} onClick={() => { const next={...form,profiles:form.profiles.filter((item)=>item.id!==profile.id)};setForm(next);void commit(next); }}>Delete</button></div></article>)}{!form.profiles.length && <div className="empty">No pipelines yet.</div>}</div>
          </section>
        </div>}
        {tab === 'account' && <><Title title="Account & billing" />{!billing.signedIn ? <Card title="Sign in"><div className="auth-form"><Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>{otpSent && <Field label="6-digit code"><input className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g,''))} /></Field>}<button className="btn primary" disabled={billingBusy || !email || (otpSent && otp.length !== 6)} onClick={async () => { setBillingBusy(true); try { if (!otpSent) { await billingRequest({type:'billing:request-otp',email}); setOtpSent(true); flash('Code sent'); } else { const status=await billingRequest<BillingStatus>({type:'billing:verify-otp',email,code:otp,deviceName:`${navigator.platform || 'Browser'} extension`}); setBilling(status); setAccount(await billingRequest<AccountData>({type:'billing:get-account'})); const syncedSettings=await getSettings(); setForm(syncedSettings); setSaved(syncedSettings); flash('Signed in'); } } catch(error){flash(error instanceof Error?error.message:'Sign-in failed')} finally{setBillingBusy(false)} }}>{otpSent ? 'Verify code' : 'Send code'}</button></div></Card> : <><Card title="WhatsApp Media Assist Pro"><div className="plan-row"><div><span className={`plan ${premium ? 'pro' : ''}`}>{premium ? 'PRO' : 'FREE'}</span><h3>{billing.email}</h3><p>{premium && billing.entitlement ? `Active until ${new Date(billing.entitlement.subscriptionExpiresAt).toLocaleDateString()}` : billing.reason ?? 'Pipelines are available with Pro.'}</p></div><button className="btn" disabled={billingBusy} onClick={() => void refreshBilling()}>Sync now</button></div><div className="sync-line"><span className={billing.settingsSyncPending ? 'pending' : 'ok'} />{billing.settingsSyncPending ? 'Waiting to sync' : billing.lastSettingsSyncAt ? `Synced ${new Date(billing.lastSettingsSyncAt).toLocaleString()}` : 'Ready to sync'}</div><div className="checkout"><select className="select" value={currency} onChange={(e) => setCurrency(e.target.value as 'INR'|'USD')}>{(product?.prices ?? [{currency:'INR' as const,label:'₹500 / 365 days',amount_minor:50000}]).map((price) => <option key={price.currency} value={price.currency}>{price.label}</option>)}</select><button className="btn primary" disabled={billingBusy} onClick={async()=>{setBillingBusy(true);try{const checkout=await billingRequest<{checkout_url:string}>({type:'billing:create-checkout',currency});window.open(checkout.checkout_url,'_blank','noopener');flash('Checkout opened');pollForActivation();}catch(error){flash(error instanceof Error?error.message:'Checkout failed')}finally{setBillingBusy(false)}}}>{premium ? 'Renew Pro' : 'Buy Pro'}</button></div></Card><Card title="Active device" action={<button className="btn danger" onClick={async()=>{await billingRequest({type:'billing:sign-out'});setBilling(await billingRequest<BillingStatus>({type:'billing:get-status'}));setAccount(null);setOtpSent(false);setOtp('');}}>Sign out</button>}><div className="device-list">{account?.devices.length ? account.devices.map((device) => <div key={device.device_id}><span><b>{device.name}</b><small>{device.current ? 'Current device' : 'Session ending'}</small></span></div>) : <button className="btn" onClick={async()=>setAccount(await billingRequest<AccountData>({type:'billing:get-account'}))}>Load device</button>}</div></Card></>}</>}
        {tab === 'backup' && <><Title title="Backup & privacy" /><Card title="Settings backup"><div className="backup"><button className="btn" onClick={() => { const blob=new Blob([JSON.stringify(form,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='media-assist-settings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }}>Export settings</button><label className="btn file">Import settings<input type="file" accept="application/json" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;try{const imported=JSON.parse(await file.text()) as Partial<AppSettings>;const next={...form,...imported};setForm(next);await commit(next);}catch{flash('Invalid settings file')}}} /></label></div></Card><Card title="Cloud sync"><div className="sync-summary"><div><b>{billing.signedIn ? (billing.settingsSyncPending ? 'Pending' : 'Active') : 'Sign in required'}</b><span>Pipelines and preferences follow your account.</span></div>{billing.signedIn && <button className="btn" disabled={billingBusy} onClick={() => void refreshBilling()}>Sync now</button>}</div></Card><Card title="Privacy"><ul className="privacy"><li>Images and PDFs stay on your device.</li><li>Only account, device, entitlement, pipelines and preferences are synced.</li><li>Razorpay handles card, UPI, bank and wallet details.</li><li>No chats, contacts, filenames or WhatsApp media URLs are sent.</li><li>No refunds.</li><li>You are responsible for complying with WhatsApp terms and for how you use the extension.</li><li>For billing, privacy or technical issues, email <b>support.mediaassit@002529.xyz</b>.</li></ul></Card></>}
      </section>
    </div>
  </main>;
}

function Title({ title, action }: { title: string; action?: React.ReactNode }) { return <div className="title"><h2>{title}</h2>{action}</div>; }
function Card({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) { return <article className={`card${className ? ` ${className}` : ''}`}><header><h3>{title}</h3>{action}</header>{children}</article>; }

createRoot(document.getElementById('root')!).render(<Options />);
