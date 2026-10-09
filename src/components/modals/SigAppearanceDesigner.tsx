/**
 * Sign → Design appearance…: named appearance profiles for visible digital
 * signatures (layout, graphic, details, font, colours, border, watermark),
 * with a live preview drawn by the same code that writes the signature, at
 * the size the signature will have.
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, ImagePlus, Plus, Star, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useSigProfiles } from '@/store/sigProfiles';
import { Button, Checkbox, ColorSwatch, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import { appearancePreviewPdf, standardProfile, type AppearanceProfile, type SigDateFormat, type SigDetails, type SigLabels, type SigLayout } from '@/lib/crypto/sigAppearance';
import { appearanceAssets, appearanceValues, localLabels } from '@/actions/sigAppearance';
import { pickFiles } from '@/lib/platform';
import { imageFileToDataUrl } from '@/lib/objectFactory';
import { uid } from '@/lib/uid';
import { cn } from '@/lib/cn';
import type { FontFamily } from '@/types';

const SCRIPT_FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Brush Script MT', 'Gabriola', 'Segoe Print'];

type GraphicChoice = 'none' | 'image' | 'name';

const DETAIL_LABELS: Array<[keyof Omit<SigDetails, 'custom'>, string]> = [
  ['signedBy', '“Digitally signed by”'],
  ['name', 'Name'],
  ['date', 'Date and time'],
  ['reason', 'Reason'],
  ['location', 'Location'],
  ['contact', 'Contact'],
  ['issuer', 'Issuer (CA)'],
];

const LABEL_FIELDS: Array<[keyof SigLabels, string]> = [
  ['signedBy', '“Digitally signed by”'],
  ['date', 'Date label'],
  ['reason', 'Reason label'],
  ['location', 'Location label'],
  ['contact', 'Contact label'],
  ['issuer', 'Issuer label'],
];

/** A new profile: the standard badge with the labels in the interface language. */
function newProfile(name: string): AppearanceProfile {
  return { ...standardProfile(localLabels()), id: uid('sigap'), name };
}

export function SigAppearanceDesigner({
  open,
  onClose,
  size,
  signerName,
  onChosen,
}: {
  open: boolean;
  onClose: () => void;
  /** The signature's size in points (the preview uses it). */
  size: { width: number; height: number };
  signerName?: string;
  /** Called with the profile to use after Save. */
  onChosen?: (id: string) => void;
}) {
  const { profiles, defaultId, upsert, remove, setDefault } = useSigProfiles();
  const saved = usePDFStore((s) => s.savedSignatures);
  const [draft, setDraft] = useState<AppearanceProfile>(() => profiles.find((p) => p.id === defaultId) ?? profiles[0] ?? newProfile('My signature'));
  const [w, setW] = useState(Math.round(size.width));
  const [h, setH] = useState(Math.round(size.height));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setW(Math.round(size.width));
    setH(Math.round(size.height));
  }, [open, size.width, size.height]);

  // Live preview: the real appearance, drawn by pdf.js.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const name = signerName || 'Maria Ionescu';
        const values = appearanceValues({ name, issuer: 'certSIGN Qualified CA', when: new Date(), reason: 'I approve this document', location: 'Cluj-Napoca', contact: 'maria@example.com' });
        const assets = await appearanceAssets(draft, name, null);
        const bytes = await appearancePreviewPdf(Math.max(10, w), Math.max(10, h), draft, values, assets);
        const { openPdf } = await import('@/lib/pdf/pdfService');
        const pdf = await openPdf(bytes);
        try {
          const page = await pdf.getPage(1);
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          const scale = Math.min(3, 440 / Math.max(w, 1), 220 / Math.max(h, 1)) * (window.devicePixelRatio || 1);
          const viewport = page.getViewport({ scale });
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
          canvas.style.height = `${viewport.height / (window.devicePixelRatio || 1)}px`;
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, background: 'rgba(0,0,0,0)' }).promise;
          setPreviewError(null);
        } finally {
          await pdf.loadingTask.destroy().catch(() => undefined);
        }
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e));
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, draft, w, h, signerName]);

  const set = (patch: Partial<AppearanceProfile>) => setDraft((d) => ({ ...d, ...patch }));
  const setDetail = (patch: Partial<SigDetails>) => setDraft((d) => ({ ...d, details: { ...d.details, ...patch } }));
  const graphicKind: GraphicChoice = draft.graphic.kind;

  const pickImage = async (): Promise<string | null> => {
    const f = (await pickFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]))[0];
    return f ? (await imageFileToDataUrl(f.bytes, f.name)).src : null;
  };

  const save = () => {
    const p = { ...draft, name: draft.name.trim() || 'My signature' };
    upsert(p);
    if (!defaultId) setDefault(p.id);
    setDraft(p);
    onChosen?.(p.id);
    usePDFStore.getState().toast('Signature appearance saved.', 'success');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Signature appearance"
      description="How visible digital signatures look. Stored only on this computer."
      width={900}
      testId="sig-designer"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button onClick={() => { save(); setDefault(draft.id); }} data-testid="sig-designer-default">
            <Star size={14} /> Save as default
          </Button>
          <Button variant="primary" onClick={save} data-testid="sig-designer-save">
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[180px_1fr] gap-4">
        {/* ------------------------------------------------ profiles */}
        <div className="flex flex-col gap-1">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Profiles</span>
            <Button size="icon" variant="ghost" aria-label="New profile" onClick={() => setDraft(newProfile(`Profile ${profiles.length + 1}`))} data-testid="sig-profile-new">
              <Plus size={14} />
            </Button>
          </div>
          {profiles.map((p) => (
            <div key={p.id} className={cn('group flex items-center gap-1 rounded-md px-2 py-1 text-xs', p.id === draft.id ? 'bg-brand-50 dark:bg-brand-900/30' : 'hover-app')}>
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setDraft(p)} data-no-translate>
                {p.name}
              </button>
              {p.id === defaultId ? <Star size={11} className="text-amber-500" aria-label="Default" /> : null}
              <button type="button" aria-label="Duplicate profile" className="hidden group-hover:block" onClick={() => setDraft({ ...p, id: uid('sigap'), name: `${p.name} (2)` })}>
                <Copy size={11} />
              </button>
              <button
                type="button"
                aria-label="Delete profile"
                className="hidden text-rose-600 group-hover:block"
                onClick={() => {
                  remove(p.id);
                  if (p.id === draft.id) setDraft(newProfile('My signature'));
                }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {!profiles.length ? <p className="text-[11px] text-muted">No profiles yet: Adika’s standard badge is used.</p> : null}
          {defaultId ? (
            <Button size="sm" variant="ghost" className="mt-2 justify-start" onClick={() => setDefault(null)}>
              Use the standard badge by default
            </Button>
          ) : null}
        </div>

        {/* ------------------------------------------------ editor */}
        <div className="min-w-0">
          <div className="mb-3 flex flex-col items-center justify-center rounded-lg border border-app bg-white p-3" style={{ minHeight: 120 }}>
            <canvas ref={canvasRef} data-testid="sig-preview" />
            {previewError ? <span className="mt-1 text-[11px] text-rose-600">{previewError}</span> : null}
            <span className="mt-1 text-[11px] text-slate-500">
              {w} × {h} pt
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Profile name">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} data-testid="sig-profile-name" />
            </Field>
            <Field label="Width (pt)">
              <Input type="number" min={20} value={w} onChange={(e) => setW(Number(e.target.value) || 0)} />
            </Field>
            <Field label="Height (pt)">
              <Input type="number" min={10} value={h} onChange={(e) => setH(Number(e.target.value) || 0)} />
            </Field>
            <Field label="Layout">
              <Select<SigLayout>
                value={draft.layout}
                onChange={(layout) => set({ layout })}
                ariaLabel="Layout"
                options={[
                  { value: 'graphic-left', label: 'Graphic left, text right' },
                  { value: 'graphic-top', label: 'Graphic on top, text below' },
                  { value: 'text', label: 'Text only' },
                  { value: 'graphic', label: 'Graphic only' },
                ]}
              />
            </Field>
            <Field label="Graphic">
              <Select<GraphicChoice>
                value={graphicKind}
                ariaLabel="Graphic"
                onChange={async (k) => {
                  if (k === 'none') set({ graphic: { kind: 'none' } });
                  if (k === 'name') set({ graphic: { kind: 'name', font: SCRIPT_FONTS[0], color: '#1d4ed8' } });
                  if (k === 'image') {
                    const src = saved[0]?.src ?? (await pickImage());
                    if (src) set({ graphic: { kind: 'image', src } });
                  }
                }}
                options={[
                  { value: 'none', label: 'None (or the ink signature you sign on)' },
                  { value: 'image', label: 'Handwritten signature or logo' },
                  { value: 'name', label: 'My name in a script font' },
                ]}
              />
            </Field>
            {draft.graphic.kind === 'name' ? (
              <Field label="Script font">
                <div className="flex gap-2">
                  <Select value={draft.graphic.font} ariaLabel="Script font" onChange={(font) => draft.graphic.kind === 'name' && set({ graphic: { ...draft.graphic, font } })} options={SCRIPT_FONTS.map((f) => ({ value: f, label: f }))} />
                  <ColorSwatch label="Name colour" value={draft.graphic.color} onChange={(c) => draft.graphic.kind === 'name' && set({ graphic: { ...draft.graphic, color: c ?? '#1d4ed8' } })} />
                </div>
              </Field>
            ) : (
              <div />
            )}
          </div>
          {draft.graphic.kind === 'image' ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {saved.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-label="Use this saved signature"
                  onClick={() => set({ graphic: { kind: 'image', src: s.src } })}
                  className={cn('flex h-10 w-24 items-center justify-center rounded border bg-white p-1', draft.graphic.kind === 'image' && draft.graphic.src === s.src ? 'border-brand-500' : 'border-app')}
                >
                  <img src={s.src} alt="" className="max-h-full max-w-full object-contain" />
                </button>
              ))}
              <Button
                size="sm"
                onClick={async () => {
                  const src = await pickImage();
                  if (src) set({ graphic: { kind: 'image', src } });
                }}
              >
                <ImagePlus size={13} /> Image file…
              </Button>
              <span className="text-[11px] text-muted">Draw or type a signature in Fill &amp; Sign to see it here.</span>
            </div>
          ) : null}

          <div className="mb-1 text-xs font-semibold">Details</div>
          <div className="mb-2 grid grid-cols-4 gap-x-3">
            {DETAIL_LABELS.map(([k, label]) => (
              <Checkbox key={k} checked={draft.details[k]} label={label} onChange={(v) => setDetail({ [k]: v } as Partial<SigDetails>)} />
            ))}
          </div>
          <div className="grid grid-cols-[1fr_200px] gap-3">
            <Field label="Custom line" hint="Placeholders: {name} {date} {reason} {location} {contact} {issuer} {cn} {o} {email}">
              <Input value={draft.details.custom} placeholder="e.g. {o} — {cn}" onChange={(e) => setDetail({ custom: e.target.value })} data-testid="sig-custom-line" />
            </Field>
            <Field label="Date format">
              <Select<SigDateFormat>
                value={draft.dateFormat}
                ariaLabel="Date format"
                onChange={(dateFormat) => set({ dateFormat })}
                options={[
                  { value: 'locale', label: 'As in the interface language' },
                  { value: 'dmy', label: '31.12.2026 14:05:00' },
                  { value: 'dmy-date', label: '31.12.2026' },
                  { value: 'ymd', label: '2026.12.31 14:05:00' },
                  { value: 'iso', label: '2026-12-31 14:05:00 +02:00' },
                ]}
              />
            </Field>
          </div>
          <details className="mb-3 text-xs">
            <summary className="cursor-default text-muted">Labels</summary>
            <div className="mt-2 grid grid-cols-3 gap-3">
              {LABEL_FIELDS.map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input value={draft.labels[k]} onChange={(e) => set({ labels: { ...draft.labels, [k]: e.target.value } })} data-no-translate />
                </Field>
              ))}
            </div>
          </details>

          <div className="mb-1 text-xs font-semibold">Style</div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Font">
              <Select<FontFamily>
                value={draft.font}
                ariaLabel="Font"
                onChange={(font) => set({ font })}
                options={[
                  { value: 'sans', label: 'Sans (Noto Sans)' },
                  { value: 'serif', label: 'Serif (Noto Serif)' },
                  { value: 'mono', label: 'Mono (Noto Sans Mono)' },
                ]}
              />
            </Field>
            <Field label="Text size">
              <Select
                value={draft.fontSize === null ? 'auto' : String(draft.fontSize)}
                ariaLabel="Text size"
                onChange={(v) => set({ fontSize: v === 'auto' ? null : Number(v) })}
                options={[{ value: 'auto', label: 'Fit the box' }, ...[6, 7, 8, 9, 10, 11, 12, 14].map((s) => ({ value: String(s), label: `${s} pt (at most)` }))]}
              />
            </Field>
            <Field label="Text colour">
              <ColorSwatch label="Text colour" value={draft.textColor} onChange={(c) => set({ textColor: c ?? '#0f172a' })} />
            </Field>
            <Field label="Alignment">
              <Select<'left' | 'center'> value={draft.align} ariaLabel="Alignment" onChange={(align) => set({ align })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centred' }]} />
            </Field>
            <Field label="Border">
              <div className="flex gap-2">
                <ColorSwatch label="Border colour" allowNone value={draft.border?.color ?? null} onChange={(c) => set({ border: c ? { color: c, width: draft.border?.width || 1 } : null })} />
                {draft.border ? <Input type="number" min={0.25} step={0.25} value={draft.border.width} aria-label="Border width" onChange={(e) => set({ border: { ...draft.border!, width: Math.max(0, Number(e.target.value) || 0) } })} /> : null}
              </div>
            </Field>
            <Field label="Background">
              <ColorSwatch label="Background" allowNone value={draft.background} onChange={(background) => set({ background })} />
            </Field>
            <Field label="Watermark logo">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    const src = await pickImage();
                    if (src) set({ watermark: { src, opacity: draft.watermark?.opacity ?? 0.15 } });
                  }}
                >
                  <ImagePlus size={13} /> {draft.watermark ? 'Change…' : 'Choose…'}
                </Button>
                {draft.watermark ? (
                  <Button size="icon" variant="ghost" aria-label="Remove watermark" onClick={() => set({ watermark: null })}>
                    <Trash2 size={13} />
                  </Button>
                ) : null}
              </div>
            </Field>
            {draft.watermark ? (
              <Field label="Watermark opacity">
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={draft.watermark.opacity}
                  aria-label="Watermark opacity"
                  onChange={(e) => set({ watermark: { ...draft.watermark!, opacity: Number(e.target.value) } })}
                  className="w-full"
                />
              </Field>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** The appearance choice in the signing dialogs: a profile (or the standard badge) and the designer. */
export function AppearanceChooser({ value, onChange, size, signerName }: { value: string | undefined; onChange: (id: string) => void; size: { width: number; height: number }; signerName?: string }) {
  const { profiles, defaultId } = useSigProfiles();
  const [designing, setDesigning] = useState(false);
  const current = value ?? defaultId ?? 'standard';
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
      <Field label="Appearance">
        <Select
          value={profiles.some((p) => p.id === current) ? current : 'standard'}
          ariaLabel="Signature appearance"
          onChange={onChange}
          options={[{ value: 'standard', label: 'Standard badge' }, ...profiles.map((p) => ({ value: p.id, label: p.id === defaultId ? `${p.name} ★` : p.name }))]}
        />
      </Field>
      <Button className="mb-3" onClick={() => setDesigning(true)} data-testid="sig-design-open">
        Design appearance…
      </Button>
      {designing ? <SigAppearanceDesigner open onClose={() => setDesigning(false)} size={size} signerName={signerName} onChosen={onChange} /> : null}
    </div>
  );
}
