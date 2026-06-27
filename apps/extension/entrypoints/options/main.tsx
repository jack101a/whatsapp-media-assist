import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/pages.css';
import { getSettings, saveSettings, type AppSettings, type CropRatio } from '../../src/storage/settings';
import type { FilenamePreset, MediaProfile, PipelineStep } from '../../src/types/profile';
import type { ImageFormat, MergeLayout } from '../../src/types/media';
import { createId } from '../../src/utils/id';
import { Icon, type IconName } from '../../src/components/Icon';
import { billingRequest } from '../../src/billing/client';
import { availableStepTypes, validatePipeline } from '../../src/profiles/pipeline';
import type { AccountData, BillingProduct } from '../../src/billing/types';

type Tab = 'general' | 'image' | 'merge' | 'pipelines' | 'account' | 'backup';

const NAV: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'image', label: 'Image defaults', icon: 'crop' },
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

interface ServerTemplate {
  id: string;
  name: string;
  category: 'image_defaults' | 'merge_pdf' | 'pipelines' | string;
  payload: Record<string, unknown>;
}

const stepLabel: Record<PipelineStep['type'], string> = {
  crop: 'Crop', rotate: 'Rotate', resize: 'Resize', format: 'Format', compress: 'File size', filename: 'Filename', download: 'Download',
};

function newStep(type: PipelineStep['type']): PipelineStep {
  const id = createId();
  switch (type) {
    case 'crop': return { id, type, mode: 'ask', ratio: 'free' };
    case 'rotate': return { id, type, degrees: 90 };
    case 'resize': return { id, type, width: 800, height: undefined, fit: 'contain', allowUpscale: false };
    case 'format': return { id, type, format: 'jpeg' };
    case 'compress': return { id, type, minKB: 100, maxKB: 180 };
    case 'filename': return { id, type, preset: 'datetime', template: '{datetime}', removeSpaces: true, removeSpecialCharacters: true };
    case 'download': return { id, type, automatic: true };
  }
}

function blankPipeline(): MediaProfile {
  return {
    id: createId(), name: 'Upload1', pinned: true, inputCount: 1, mergeLayout: 'vertical', background: '#ffffff',
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
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

function StepEditor({ step, onChange, onDelete, onMoveUp, onMoveDown, first, last }: {
  step: PipelineStep; onChange: (step: PipelineStep) => void; onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void; first: boolean; last: boolean;
}) {
  const update = (patch: Partial<PipelineStep>) => onChange({ ...step, ...patch } as PipelineStep);
  return <article className="step-card">
    <div className="step-head"><strong>{stepLabel[step.type]}</strong><div><button disabled={first} onClick={onMoveUp}><Icon name="up" /></button><button disabled={last} onClick={onMoveDown}><Icon name="down" /></button><button className="delete" onClick={onDelete}><Icon name="trash" /></button></div></div>
    <div className="step-fields">
      {step.type === 'crop' && <><Field label="Mode"><select className="select" value={step.mode} onChange={(e) => update({ mode: e.target.value as 'ask' | 'preset' })}><option value="ask">Ask each time</option><option value="preset">Use preset</option></select></Field><Field label="Ratio"><select className="select" value={step.ratio} onChange={(e) => update({ ratio: e.target.value as CropRatio })}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:3">4:3</option><option value="16:9">16:9</option></select></Field></>}
      {step.type === 'rotate' && <Field label="Rotation"><select className="select" value={step.degrees} onChange={(e) => update({ degrees: Number(e.target.value) as -90 | 90 | 180 })}><option value="-90">90° left</option><option value="90">90° right</option><option value="180">180°</option></select></Field>}
      {step.type === 'resize' && <><Field label="Width"><NumberField value={step.width} onChange={(width) => update({ width })} /></Field><Field label="Height"><NumberField value={step.height} onChange={(height) => update({ height })} /></Field><Field label="Fit"><select className="select" value={step.fit} onChange={(e) => update({ fit: e.target.value as 'contain' | 'cover' | 'stretch' })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></Field><Toggle checked={step.allowUpscale} onChange={(allowUpscale) => update({ allowUpscale })} label="Allow enlargement" /></>}
      {step.type === 'format' && <Field label="Output"><select className="select" value={step.format} onChange={(e) => update({ format: e.target.value as ImageFormat | 'pdf' })}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="pdf">PDF</option></select></Field>}
      {step.type === 'compress' && <><Field label="Minimum KB"><NumberField value={step.minKB} onChange={(minKB) => update({ minKB })} /></Field><Field label="Maximum KB"><NumberField value={step.maxKB} onChange={(maxKB) => update({ maxKB })} /></Field></>}
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

function ServerPresetList({ title, templates, disabled, onApply }: { title: string; templates: ServerTemplate[]; disabled?: boolean; onApply: (template: ServerTemplate) => void }) {
  if (!templates.length) return null;
  return <Card title={title}><div className="pipeline-list">{templates.map((template) => <article key={template.id}><div><h3>{template.name}</h3><span>{template.category}</span></div><div><button className="btn primary" disabled={disabled} onClick={() => onApply(template)}>Apply preset</button></div></article>)}</div></Card>;
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
    billingRequest<BillingProduct>({ type: 'billing:get-product' }).catch(() => ({ name: 'Media Assist Pro', duration_days: 365, prices: [{ currency: 'INR' as const, amount_minor: 50000, label: '₹500 / 365 days' }] })),
  ]).then(([settings, status, billingProduct]) => {
    setForm(settings); setSaved(settings); setBilling(status); setEmail(status.email ?? ''); setProduct(billingProduct);
    if (billingProduct.prices.length && !billingProduct.prices.some((price) => price.currency === currency)) setCurrency(billingProduct.prices[0]!.currency);
    if (status.signedIn) {
      void billingRequest<ServerTemplate[]>({ type: 'billing:get-templates' })
        .then(setServerTemplates).catch(() => undefined);
    }
  }); }, []);
  useEffect(() => () => { if (checkoutPoll.current !== null) window.clearInterval(checkoutPoll.current); }, []);
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved));
  const premium = billing?.premium ?? false;
  const draftErrors = useMemo(() => draft ? validatePipeline(draft) : [], [draft]);
  const unusedStepTypes = useMemo(() => draft ? availableStepTypes(draft) : [], [draft]);
  const imageTemplates = useMemo(() => serverTemplates.filter((template) => template.category === 'image_defaults'), [serverTemplates]);
  const mergeTemplates = useMemo(() => serverTemplates.filter((template) => template.category === 'merge_pdf'), [serverTemplates]);
  const pipelineTemplates = useMemo(() => serverTemplates.filter((template) => template.category === 'pipelines'), [serverTemplates]);

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
        void billingRequest<ServerTemplate[]>({ type: 'billing:get-templates' })
          .then(setServerTemplates).catch(() => undefined);
      }
    } catch (error) { flash(error instanceof Error ? error.message : 'Could not refresh'); }
    finally { setBillingBusy(false); }
  };

  const savePipeline = async () => {
    if (!form || !draft || !premium) return;
    if (!draft.name.trim()) return flash('Name is required');
    if (!draft.steps.length) return flash('Add at least one step');
    const validationErrors = validatePipeline(draft);
    if (validationErrors.length) return flash(validationErrors[0]!);
    const nextProfile = { ...draft, name: draft.name.trim(), inputCount: Math.max(1, Math.min(20, draft.inputCount)), updatedAt: Date.now() };
    const profiles = form.profiles.some((item) => item.id === nextProfile.id) ? form.profiles.map((item) => item.id === nextProfile.id ? nextProfile : item) : [...form.profiles, nextProfile];
    const next = { ...form, profiles };
    setDraft(null); setForm(next); await commit(next);
  };

  const applyServerTemplate = async (template: ServerTemplate) => {
    if (!form) return;
    if (template.category === 'pipelines') {
      if (!premium) return flash('Pro is required');
      const profile = serverPipeline(template);
      const validationErrors = validatePipeline(profile);
      if (validationErrors.length) return flash(validationErrors[0]!);
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
      template.category === 'image_defaults' ? pickSettingsPatch(template.payload, IMAGE_TEMPLATE_KEYS) :
      template.category === 'merge_pdf' ? pickSettingsPatch(template.payload, MERGE_TEMPLATE_KEYS) :
      null;
    if (!templatePatch) return flash('Unsupported preset');
    const next = { ...form, ...templatePatch };
    setForm(next);
    await commit(next);
    flash('Preset applied');
  };

  if (!form || !billing) return <main className="loading">Loading…</main>;

  return <main className="page">
    <header className="topbar"><div className="brand"><img src="/icons/icon-48.png" alt="" /><div><h1>Media Assist</h1><span>Settings</span></div></div><div className="actions">{notice && <span className="notice">{notice}</span>}<button className="btn ghost" disabled={!dirty} onClick={() => setForm(saved)}>Discard</button><button className="btn primary" disabled={!dirty} onClick={() => void commit()}>Save</button></div></header>
    <div className="shell">
      <aside><div className="state"><span className={form.enabled ? 'on' : ''} /><b>{form.enabled ? 'Enabled' : 'Paused'}</b></div><nav>{NAV.map((item) => <button className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} key={item.id}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav></aside>
      <section className="content">
        {tab === 'general' && <><Title title="General" /><Card title="Extension"><div className="grid"><Toggle checked={form.enabled} onChange={(value) => patch('enabled', value)} label="Enable extension" /><Toggle checked={form.showToolbarLabels} onChange={(value) => patch('showToolbarLabels', value)} label="Show button names" /><Toggle checked={form.showRotateControls} onChange={(value) => patch('showRotateControls', value)} label="Show rotate buttons" /></div></Card><Card title="Download defaults"><div className="grid"><Field label="Format"><select className="select" value={form.defaultFormat} onChange={(e) => patch('defaultFormat', e.target.value as ImageFormat)}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></Field><Field label="Quality %"><input className="input" type="number" min="35" max="100" value={form.defaultQuality} onChange={(e) => patch('defaultQuality', Number(e.target.value))} /></Field><Toggle checked={form.removeSpacesByDefault} onChange={(value) => patch('removeSpacesByDefault', value)} label="Remove spaces" /><Toggle checked={form.removeSpecialCharactersByDefault} onChange={(value) => patch('removeSpecialCharactersByDefault', value)} label="Remove special characters" /></div></Card></>}
        {tab === 'image' && <><Title title="Image defaults" /><ServerPresetList title="Server image presets" templates={imageTemplates} disabled={!billing.signedIn} onApply={(template) => void applyServerTemplate(template)} /><Card title="Resize"><div className="grid"><Field label="Width"><NumberField value={form.defaultWidth} onChange={(value) => patch('defaultWidth', value)} /></Field><Field label="Height"><NumberField value={form.defaultHeight} onChange={(value) => patch('defaultHeight', value)} /></Field><Field label="Fit"><select className="select" value={form.defaultResizeFit} onChange={(e) => patch('defaultResizeFit', e.target.value as AppSettings['defaultResizeFit'])}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></Field><Toggle checked={form.allowUpscale} onChange={(value) => patch('allowUpscale', value)} label="Allow enlargement" /></div></Card><Card title="Compression"><div className="grid"><Field label="Minimum KB"><NumberField value={form.defaultMinKB} onChange={(value) => patch('defaultMinKB', value)} /></Field><Field label="Maximum KB"><NumberField value={form.defaultMaxKB} onChange={(value) => patch('defaultMaxKB', value)} /></Field><Field label="Minimum quality"><input className="input" type="number" min="20" max="90" value={form.minimumQuality} onChange={(e) => patch('minimumQuality', Number(e.target.value))} /></Field><Toggle checked={form.allowDimensionReduction} onChange={(value) => patch('allowDimensionReduction', value)} label="Reduce dimensions if needed" /></div></Card></>}
        {tab === 'merge' && <><Title title="Merge & PDF" /><ServerPresetList title="Server merge presets" templates={mergeTemplates} disabled={!billing.signedIn} onApply={(template) => void applyServerTemplate(template)} /><div className="two-col"><Card title="A4 layout"><div className="layout-buttons">{(['vertical','horizontal','grid'] as MergeLayout[]).map((layout) => <button key={layout} className={form.mergeDefaultLayout === layout ? 'selected' : ''} onClick={() => patch('mergeDefaultLayout', layout)}>{layout === 'vertical' ? 'Top & bottom' : layout === 'horizontal' ? 'Side by side' : 'Custom grid'}</button>)}</div><div className="grid"><Field label="Output"><select className="select" value={form.mergeDefaultFormat} onChange={(e) => patch('mergeDefaultFormat', e.target.value as ImageFormat | 'pdf')}><option value="pdf">PDF</option><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select></Field><Field label="Target maximum KB"><NumberField value={form.mergeDefaultMaxKB} onChange={(value) => patch('mergeDefaultMaxKB', value)} /></Field><Field label="Quality %"><input className="input" type="number" min="35" max="100" value={form.mergeDefaultQuality} onChange={(e) => patch('mergeDefaultQuality', Number(e.target.value))} /></Field><Field label="Page margin"><NumberField value={form.mergeDefaultPadding} onChange={(value) => patch('mergeDefaultPadding', value ?? 0)} /></Field><Field label="Gap"><NumberField value={form.mergeDefaultGap} onChange={(value) => patch('mergeDefaultGap', value ?? 0)} /></Field><Field label="Border"><NumberField value={form.mergeDefaultBorderWidth} onChange={(value) => patch('mergeDefaultBorderWidth', value ?? 0)} /></Field><Field label="Grid columns"><NumberField min={1} max={6} value={form.mergeDefaultGridColumns} onChange={(value) => patch('mergeDefaultGridColumns', value ?? 2)} /></Field></div></Card><div className="a4"><div className={`a4-inner ${form.mergeDefaultLayout}`}>{Array.from({ length: form.mergeDefaultLayout === 'grid' ? 6 : 2 }, (_, i) => <span key={i}>{i+1}</span>)}</div></div></div></>}
        {tab === 'pipelines' && <><Title title="Pipelines" action={<button className="btn primary" disabled={!premium} onClick={() => setDraft(blankPipeline())}><Icon name="plus" />New pipeline</button>} />{!premium && <div className="locked">Pro is required to create pipeline buttons. <button onClick={() => setTab('account')}>View Pro</button></div>}{draft && <Card title={form.profiles.some((item) => item.id === draft.id) ? 'Edit pipeline' : 'New pipeline'} action={<button className="icon-btn" onClick={() => setDraft(null)}><Icon name="close" /></button>}><div className="grid"><Field label="Button name"><input className="input" value={draft.name} maxLength={20} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Required media"><NumberField min={1} max={20} value={draft.inputCount} onChange={(inputCount) => setDraft({ ...draft, inputCount: inputCount ?? 1 })} /></Field>{draft.inputCount > 1 && <Field label="Merge layout"><select className="select" value={draft.mergeLayout} onChange={(e) => setDraft({ ...draft, mergeLayout: e.target.value as MergeLayout })}><option value="vertical">Top & bottom</option><option value="horizontal">Side by side</option><option value="grid">Custom grid</option></select></Field>}<Toggle checked={draft.pinned} onChange={(pinned) => setDraft({ ...draft, pinned })} label="Show button on WhatsApp" /></div><div className="steps">{draft.steps.map((step, index) => <StepEditor key={step.id} step={step} first={index === 0} last={index === draft.steps.length - 1} onChange={(updated) => setDraft({ ...draft, steps: draft.steps.map((item) => item.id === step.id ? updated : item) })} onDelete={() => setDraft({ ...draft, steps: draft.steps.filter((item) => item.id !== step.id) })} onMoveUp={() => { const list=[...draft.steps]; if(index>0){const current=list[index]!;list[index]=list[index-1]!;list[index-1]=current;} setDraft({...draft,steps:list}); }} onMoveDown={() => { const list=[...draft.steps]; if(index<list.length-1){const current=list[index]!;list[index]=list[index+1]!;list[index+1]=current;} setDraft({...draft,steps:list}); }} />)}</div>{draftErrors.length > 0 && <div className="validation-list">{draftErrors.map((error) => <span key={error}>{error}</span>)}</div>}<div className="add-step">{unusedStepTypes.length > 0 ? <><select className="select" value={unusedStepTypes.includes(addStepType) ? addStepType : unusedStepTypes[0]} onChange={(e) => setAddStepType(e.target.value as PipelineStep['type'])}>{unusedStepTypes.map((value) => <option key={value} value={value}>{stepLabel[value]}</option>)}</select><button className="btn" onClick={() => { const type = unusedStepTypes.includes(addStepType) ? addStepType : unusedStepTypes[0]; if (type) setDraft({ ...draft, steps: [...draft.steps, newStep(type)] }); }}><Icon name="plus" />Add step</button></> : <span className="all-steps">All available steps added</span>}</div><div className="card-actions"><button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn primary" disabled={draftErrors.length > 0} onClick={() => void savePipeline()}>Save pipeline</button></div></Card>}<ServerPresetList title="Server pipeline presets" templates={pipelineTemplates} disabled={!premium} onApply={(template) => void applyServerTemplate(template)} />
          <div className="pipeline-list">{form.profiles.map((profile) => <article key={profile.id}><div><h3>{profile.name}</h3><span>{profile.inputCount > 1 ? `${profile.inputCount} media · ` : ''}{profile.steps.map((step) => stepLabel[step.type]).join(' → ')}</span></div><div>{profile.pinned && <b>Pinned</b>}<button className="btn ghost" disabled={!premium} onClick={() => setDraft(structuredClone(profile))}>Edit</button><button className="btn danger" disabled={!premium} onClick={() => { const next={...form,profiles:form.profiles.filter((item)=>item.id!==profile.id)};setForm(next);void commit(next); }}>Delete</button></div></article>)}{!form.profiles.length && <div className="empty">No pipelines yet.</div>}</div></>}
        {tab === 'account' && <><Title title="Account & billing" />{!billing.signedIn ? <Card title="Sign in"><div className="auth-form"><Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>{otpSent && <Field label="6-digit code"><input className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g,''))} /></Field>}<button className="btn primary" disabled={billingBusy || !email || (otpSent && otp.length !== 6)} onClick={async () => { setBillingBusy(true); try { if (!otpSent) { await billingRequest({type:'billing:request-otp',email}); setOtpSent(true); flash('Code sent'); } else { const status=await billingRequest<BillingStatus>({type:'billing:verify-otp',email,code:otp,deviceName:`${navigator.platform || 'Browser'} extension`}); setBilling(status); setAccount(await billingRequest<AccountData>({type:'billing:get-account'})); flash('Signed in'); } } catch(error){flash(error instanceof Error?error.message:'Sign-in failed')} finally{setBillingBusy(false)} }}>{otpSent ? 'Verify code' : 'Send code'}</button></div></Card> : <><Card title="Media Assist Pro"><div className="plan-row"><div><span className={`plan ${premium ? 'pro' : ''}`}>{premium ? 'PRO' : 'FREE'}</span><h3>{billing.email}</h3><p>{premium && billing.entitlement ? `Active until ${new Date(billing.entitlement.subscriptionExpiresAt).toLocaleDateString()}` : billing.reason ?? 'Pipelines are available with Pro.'}</p></div><button className="btn" disabled={billingBusy} onClick={() => void refreshBilling()}>Sync now</button></div><div className="sync-line"><span className={billing.settingsSyncPending ? 'pending' : 'ok'} />{billing.settingsSyncPending ? 'Waiting to sync' : billing.lastSettingsSyncAt ? `Synced ${new Date(billing.lastSettingsSyncAt).toLocaleString()}` : 'Ready to sync'}</div><div className="checkout"><select className="select" value={currency} onChange={(e) => setCurrency(e.target.value as 'INR'|'USD')}>{(product?.prices ?? [{currency:'INR' as const,label:'₹500 / 365 days',amount_minor:50000}]).map((price) => <option key={price.currency} value={price.currency}>{price.label}</option>)}</select><button className="btn primary" disabled={billingBusy} onClick={async()=>{setBillingBusy(true);try{const checkout=await billingRequest<{checkout_url:string}>({type:'billing:create-checkout',currency});window.open(checkout.checkout_url,'_blank','noopener');flash('Checkout opened');pollForActivation();}catch(error){flash(error instanceof Error?error.message:'Checkout failed')}finally{setBillingBusy(false)}}}>{premium ? 'Renew Pro' : 'Buy Pro'}</button></div></Card><Card title="Active device" action={<button className="btn danger" onClick={async()=>{await billingRequest({type:'billing:sign-out'});setBilling(await billingRequest<BillingStatus>({type:'billing:get-status'}));setAccount(null);setOtpSent(false);setOtp('');}}>Sign out</button>}><div className="device-list">{account?.devices.length ? account.devices.map((device) => <div key={device.device_id}><span><b>{device.name}</b><small>{device.current ? 'Current device' : 'Session ending'}</small></span></div>) : <button className="btn" onClick={async()=>setAccount(await billingRequest<AccountData>({type:'billing:get-account'}))}>Load device</button>}</div></Card></>}</>}
        {tab === 'backup' && <><Title title="Backup & privacy" /><Card title="Settings backup"><div className="backup"><button className="btn" onClick={() => { const blob=new Blob([JSON.stringify(form,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='media-assist-settings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }}>Export settings</button><label className="btn file">Import settings<input type="file" accept="application/json" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;try{const imported=JSON.parse(await file.text()) as Partial<AppSettings>;const next={...form,...imported};setForm(next);await commit(next);}catch{flash('Invalid settings file')}}} /></label></div></Card><Card title="Cloud sync"><div className="sync-summary"><div><b>{billing.signedIn ? (billing.settingsSyncPending ? 'Pending' : 'Active') : 'Sign in required'}</b><span>Pipelines and preferences follow your account.</span></div>{billing.signedIn && <button className="btn" disabled={billingBusy} onClick={() => void refreshBilling()}>Sync now</button>}</div></Card><Card title="Privacy"><ul className="privacy"><li>Images and PDFs stay on your device.</li><li>Only account, payment, device, pipelines and preferences are synced.</li><li>No chats, contacts, filenames or WhatsApp media URLs are sent.</li></ul></Card></>}
      </section>
    </div>
  </main>;
}

function Title({ title, action }: { title: string; action?: React.ReactNode }) { return <div className="title"><h2>{title}</h2>{action}</div>; }
function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) { return <article className="card"><header><h3>{title}</h3>{action}</header>{children}</article>; }

createRoot(document.getElementById('root')!).render(<Options />);
