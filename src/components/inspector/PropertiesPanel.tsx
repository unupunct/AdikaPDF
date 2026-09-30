/**
 * Right-hand inspector. With a selection: properties of the selected
 * object(s). Otherwise: default style of the active tool, existing form
 * fields to fill in, signatures, and document information.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, BadgeCheck, BadgeX, Bold, Italic, Lock, Unlock } from 'lucide-react';
import { usePDFStore, type FieldValue } from '@/store/usePDFStore';
import type { EditorObject, FieldObject, FontFamily, ImageObject, LinkObject, MeasureObject, TextObject } from '@/types';
import { measureValue } from '@/lib/measure';
import { calcOrder, calculate, checkInput, displayValue, formulaFields, parseNumber, type FieldLogic } from '@/lib/formLogic';
import { ScaleEditor } from '@/components/ribbon/MeasureTools';
import { Button, Checkbox, ColorSwatch, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { FONT_LABELS } from '@/lib/fonts';
import { layoutText } from '@/lib/textLayout';
import { readFormFields, type FormFieldInfo } from '@/actions/security';
import { setViewerFieldValue } from '@/lib/pdf/pdfService';
import { cn } from '@/lib/cn';

const FONT_OPTIONS = (Object.keys(FONT_LABELS) as FontFamily[]).map((f) => ({ value: f, label: FONT_LABELS[f] }));

export function PropertiesPanel() {
  const objects = usePDFStore((s) => s.objects);
  const selectedIds = usePDFStore((s) => s.selectedIds);
  const selected = useMemo(() => objects.filter((o) => selectedIds.includes(o.id)), [objects, selectedIds]);
  return (
    <aside data-testid="inspector" className="flex h-full w-[280px] shrink-0 flex-col border-l border-app bg-panel">
      <div className="flex h-9 items-center border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {selected.length === 1 ? objectLabel(selected[0]) : selected.length > 1 ? `${selected.length} objects` : 'Document'}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {selected.length === 1 ? <ObjectProperties obj={selected[0]} /> : selected.length > 1 ? <MultiProperties objs={selected} /> : <DocumentPanel />}
      </div>
    </aside>
  );
}

function objectLabel(o: EditorObject): string {
  const map: Record<EditorObject['type'], string> = {
    text: 'Text box',
    image: 'Image',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    highlight: 'Highlight',
    line: 'Line',
    arrow: 'Arrow',
    pen: 'Ink',
    redact: 'Redaction',
    signature: 'Signature',
    field: 'Form field',
    stamp: 'Stamp',
    link: 'Link',
    poly: 'Shape comment',
    attachment: 'File attachment',
    measure: 'Measurement',
    note: 'Note',
    markup: 'Text markup',
  };
  return map[o.type];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 border-b border-app pb-3 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Num({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v)) onChange(clampOpt(v, min, max));
    else setText(String(round(value)));
  };
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-muted">
      {label}
      <Input
        aria-label={label}
        value={text}
        inputMode="decimal"
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(clampOpt(value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1), min, max));
          }
        }}
        className="h-7 text-[12px] normal-case tracking-normal text-[var(--text)]"
      />
    </label>
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function clampOpt(v: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
}

// ================================================================ objects

function ObjectProperties({ obj }: { obj: EditorObject }) {
  const update = (patch: Partial<EditorObject>) => usePDFStore.getState().updateObject(obj.id, patch);
  const s = usePDFStore.getState();
  const hasBox = 'width' in obj;
  return (
    <>
      <Section title="Position">
        <div className="grid grid-cols-2 gap-2">
          <Num label="X (pt)" value={obj.x} onChange={(x) => update({ x })} />
          <Num label="Y (pt)" value={obj.y} onChange={(y) => update({ y })} />
          {hasBox ? (
            <>
              <Num label="Width" value={obj.width} min={4} onChange={(width) => update(obj.type === 'text' ? { width, height: layoutText({ ...obj, width }).contentHeight } : { width })} />
              {obj.type !== 'text' ? <Num label="Height" value={obj.height} min={4} onChange={(height) => update({ height })} /> : null}
            </>
          ) : null}
          {obj.type !== 'field' ? <Num label="Rotation °" value={obj.rotation} onChange={(r) => update({ rotation: ((r % 360) + 360) % 360 })} /> : null}
          {obj.type !== 'redact' && obj.type !== 'field' ? <Num label="Opacity %" value={obj.opacity * 100} min={5} max={100} onChange={(v) => update({ opacity: v / 100 })} /> : null}
        </div>
      </Section>
      <TypeSpecific obj={obj} update={update} />
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => update({ locked: !obj.locked })}>
          {obj.locked ? <Unlock size={13} /> : <Lock size={13} />}
          {obj.locked ? 'Unlock' : 'Lock'}
        </Button>
        <Button size="sm" onClick={() => s.duplicateObjects([obj.id])} disabled={obj.locked}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={() => s.deleteObjects([obj.id])} disabled={obj.locked} data-testid="inspector-delete">
          Delete
        </Button>
      </div>
    </>
  );
}

function TypeSpecific({ obj, update }: { obj: EditorObject; update: (p: Partial<EditorObject>) => void }) {
  switch (obj.type) {
    case 'text':
      return <TextProps obj={obj} update={update} />;
    case 'rect':
    case 'ellipse':
      return (
        <Section title="Appearance">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs">Stroke</span>
            <ColorSwatch label="Stroke colour" value={obj.stroke} allowNone onChange={(stroke) => update({ stroke })} />
          </div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs">Fill</span>
            <ColorSwatch label="Fill colour" value={obj.fill} allowNone onChange={(fill) => update({ fill })} />
          </div>
          <Num label="Stroke width" value={obj.strokeWidth} min={0} max={50} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
        </Section>
      );
    case 'highlight':
      return (
        <Section title="Appearance">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">Colour</span>
            <ColorSwatch label="Highlight colour" value={obj.fill} onChange={(fill) => update({ fill: fill ?? '#facc15' })} />
          </div>
        </Section>
      );
    case 'line':
    case 'arrow':
    case 'pen':
      return (
        <Section title="Appearance">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs">Colour</span>
            <ColorSwatch label="Line colour" value={obj.stroke} onChange={(stroke) => update({ stroke: stroke ?? '#000000' })} />
          </div>
          <Num label="Width" value={obj.strokeWidth} min={0.25} max={50} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
          {obj.type !== 'pen' ? (
            <Button size="sm" className="mt-2" onClick={() => update({ type: obj.type === 'line' ? 'arrow' : 'line' } as Partial<EditorObject>)}>
              Switch to {obj.type === 'line' ? 'arrow' : 'line'}
            </Button>
          ) : null}
        </Section>
      );
    case 'image':
      return <ImageProps obj={obj} update={update} />;
    case 'signature':
      return (
        <Section title="Signature">
          <Field label="Signer name">
            <Input value={obj.signerName} onChange={(e) => update({ signerName: e.target.value })} />
          </Field>
          <Checkbox checked={obj.showCaption} label="Show name and date under the signature" onChange={(showCaption) => update({ showCaption, height: obj.height + (showCaption ? 11 : -11) })} />
          <p className="mt-2 text-[11px] text-muted">
            This is an electronic (visual) signature. For a cryptographic signature that proves integrity, use Sign → Certificate ID or Token with this signature selected.
          </p>
        </Section>
      );
    case 'redact':
      return (
        <Section title="Redaction">
          <p className="mb-2 text-xs text-muted">Content under this box is destroyed when you save (the page is re-rendered with the box burned in).</p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">Fill colour</span>
            <ColorSwatch label="Redaction colour" value={obj.fill} onChange={(fill) => update({ fill: fill ?? '#000000' })} />
          </div>
        </Section>
      );
    case 'field':
      return <FieldProps obj={obj} update={update} />;
    case 'note':
      return (
        <Section title="Note">
          <Field label="Comment">
            <Textarea rows={4} value={obj.text} data-testid="inspector-note-text" onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
          </Field>
          <Field label="Author">
            <Input value={obj.author} onChange={(e) => update({ author: e.target.value })} />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">Colour</span>
            <ColorSwatch label="Note colour" value={obj.color} onChange={(color) => update({ color: color ?? '#facc15' })} />
          </div>
          <p className="mt-2 text-[11px] text-muted">Saved as a real PDF comment: Acrobat, Foxit and other readers can open, reply to or delete it.</p>
        </Section>
      );
    case 'stamp':
      return (
        <Section title="Stamp">
          {!obj.src ? (
            <>
              <Field label="Text">
                <Input value={obj.label} onChange={(e) => update({ label: e.target.value, modifiedAt: new Date().toISOString() })} />
              </Field>
              <Field label="Second line">
                <Input value={obj.subtitle} placeholder="Name, date…" onChange={(e) => update({ subtitle: e.target.value, modifiedAt: new Date().toISOString() })} />
              </Field>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs">Colour</span>
                <ColorSwatch label="Stamp colour" value={obj.color} onChange={(color) => update({ color: color ?? '#b91c1c' })} />
              </div>
            </>
          ) : null}
          <Field label="Comment">
            <Textarea rows={2} value={obj.text} onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
          </Field>
          <p className="text-[11px] text-muted">{obj.author} · saved as a PDF stamp that Acrobat and Foxit can move or delete.</p>
        </Section>
      );
    case 'link':
      return <LinkProps obj={obj} update={update} />;
    case 'poly':
      return (
        <Section title={obj.kind === 'cloud' ? 'Cloud' : obj.kind === 'polygon' ? 'Polygon' : 'Polyline'}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs">Line</span>
            <ColorSwatch label="Line colour" value={obj.stroke} onChange={(stroke) => update({ stroke: stroke ?? '#e11d48' })} />
          </div>
          {obj.kind !== 'polyline' ? (
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs">Fill</span>
              <ColorSwatch label="Fill colour" value={obj.fill} allowNone onChange={(fill) => update({ fill })} />
            </div>
          ) : null}
          <Num label="Line width" value={obj.strokeWidth} min={0.5} max={20} step={0.5} onChange={(strokeWidth) => update({ strokeWidth })} />
          <Field label="Comment">
            <Textarea rows={3} value={obj.text} onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
          </Field>
        </Section>
      );
    case 'measure':
      return <MeasureProps obj={obj} update={update} />;
    case 'attachment':
      return (
        <Section title="File attachment">
          <p className="mb-2 break-all text-xs">
            {obj.fileName} · {(obj.size / 1024).toFixed(obj.size < 10240 ? 1 : 0)} KB
          </p>
          <Field label="Description">
            <Textarea rows={2} value={obj.text} onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">Icon colour</span>
            <ColorSwatch label="Icon colour" value={obj.color} onChange={(color) => update({ color: color ?? '#2563eb' })} />
          </div>
          <p className="mt-2 text-[11px] text-muted">The file travels inside the PDF; readers open it from the paperclip or the Attachments panel.</p>
        </Section>
      );
    case 'markup':
      return (
        <Section title="Text markup">
          <Field label="Type">
            <Select value={obj.kind} ariaLabel="Markup type" onChange={(kind) => update({ kind } as Partial<EditorObject>)} options={[{ value: 'highlight', label: 'Highlight' }, { value: 'underline', label: 'Underline' }, { value: 'strikeout', label: 'Strikeout' }, { value: 'squiggly', label: 'Squiggly' }]} />
          </Field>
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs">Colour</span>
            <ColorSwatch label="Markup colour" value={obj.color} onChange={(color) => update({ color: color ?? '#facc15' })} />
          </div>
          <Field label="Comment">
            <Textarea rows={3} value={obj.text} placeholder={obj.selectedText} onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
          </Field>
          <p className="text-[11px] text-muted">
            {obj.author} · “{obj.selectedText.slice(0, 80)}
            {obj.selectedText.length > 80 ? '…' : ''}”
          </p>
        </Section>
      );
  }
}

function MeasureProps({ obj, update }: { obj: MeasureObject; update: (p: Partial<MeasureObject>) => void }) {
  const { label } = measureValue(obj.kind, obj.points, obj.scale);
  return (
    <Section title={obj.kind === 'distance' ? 'Distance' : obj.kind === 'perimeter' ? 'Perimeter' : 'Area'}>
      <p className="mb-2 text-[15px] font-semibold" data-testid="measure-value">
        {label}
      </p>
      <Field label="Scale">
        <ScaleEditor value={obj.scale} onChange={(scale) => update({ scale, modifiedAt: new Date().toISOString() })} />
      </Field>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs">Colour</span>
        <ColorSwatch label="Measurement colour" value={obj.stroke} onChange={(stroke) => update({ stroke: stroke ?? '#dc2626' })} />
      </div>
      <Field label="Comment">
        <Textarea rows={2} value={obj.text} onChange={(e) => update({ text: e.target.value, modifiedAt: new Date().toISOString() })} />
      </Field>
      <p className="text-[11px] text-muted">Saved as a PDF measurement: Acrobat and Foxit show the value and the scale.</p>
    </Section>
  );
}

function LinkProps({ obj, update }: { obj: LinkObject; update: (p: Partial<LinkObject>) => void }) {
  const pages = usePDFStore((s) => s.pages);
  const pageNo = obj.target.kind === 'page' ? pages.findIndex((p) => obj.target.kind === 'page' && p.id === obj.target.pageId) + 1 : 1;
  return (
    <Section title="Link">
      <Field label="Goes to">
        <Select
          value={obj.target.kind}
          ariaLabel="Link target"
          onChange={(kind) => update({ target: kind === 'url' ? { kind: 'url', url: '' } : { kind: 'page', pageId: pages[0]?.id ?? '' } })}
          options={[
            { value: 'url', label: 'A web page' },
            { value: 'page', label: 'A page in this document' },
          ]}
        />
      </Field>
      {obj.target.kind === 'url' ? (
        <Field label="Address">
          <Input value={obj.target.url} placeholder="https://…" data-testid="inspector-link-url" onChange={(e) => update({ target: { kind: 'url', url: e.target.value } })} />
        </Field>
      ) : (
        <Num label={`Page (1–${pages.length})`} value={pageNo} min={1} max={pages.length} onChange={(n) => update({ target: { kind: 'page', pageId: pages[Math.round(n) - 1]?.id ?? '' } })} />
      )}
      <p className="mt-2 text-[11px] text-muted">The link works once the document is saved; the dashed box is only shown while editing.</p>
    </Section>
  );
}

function TextProps({ obj, update }: { obj: TextObject; update: (p: Partial<TextObject>) => void }) {
  const relayout = (p: Partial<TextObject>) => update({ ...p, height: layoutText({ ...obj, ...p }).contentHeight });
  return (
    <Section title={obj.callout ? 'Callout' : obj.border ? 'Text box comment' : 'Text'}>
      {obj.annotation ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs">Border</span>
          <ColorSwatch label="Border colour" value={obj.border ?? null} allowNone onChange={(border) => update({ border })} />
        </div>
      ) : null}
      <Field label="Content">
        <Textarea rows={3} value={obj.text} onChange={(e) => relayout({ text: e.target.value })} data-testid="inspector-text" />
      </Field>
      <Field label="Font">
        <Select value={obj.fontFamily} options={FONT_OPTIONS} onChange={(fontFamily) => relayout({ fontFamily })} ariaLabel="Font family" />
      </Field>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Num label="Size (pt)" value={obj.fontSize} min={3} max={400} step={0.5} onChange={(fontSize) => relayout({ fontSize })} />
        <Num label="Line height" value={obj.lineHeight} min={0.8} max={4} step={0.05} onChange={(lineHeight) => relayout({ lineHeight })} />
      </div>
      <div className="mb-3 flex items-center gap-1">
        <IconToggle label="Bold" active={obj.bold} onClick={() => relayout({ bold: !obj.bold })}>
          <Bold size={14} />
        </IconToggle>
        <IconToggle label="Italic" active={obj.italic} onClick={() => relayout({ italic: !obj.italic })}>
          <Italic size={14} />
        </IconToggle>
        <span className="mx-1 h-5 w-px bg-[var(--border)]" />
        {(['left', 'center', 'right'] as const).map((a) => (
          <IconToggle key={a} label={`Align ${a}`} active={obj.align === a} onClick={() => update({ align: a })}>
            {a === 'left' ? <AlignLeft size={14} /> : a === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
          </IconToggle>
        ))}
      </div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs">Colour</span>
        <ColorSwatch label="Text colour" value={obj.color} onChange={(color) => update({ color: color ?? '#000000' })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs">Background</span>
        <ColorSwatch label="Background colour" value={obj.background} allowNone onChange={(background) => update({ background })} />
      </div>
    </Section>
  );
}

function IconToggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={cn('flex h-7 w-7 items-center justify-center rounded-md', active ? 'bg-brand-600 text-white' : 'hover-app')}>
      {children}
    </button>
  );
}

function ImageProps({ obj, update }: { obj: ImageObject; update: (p: Partial<ImageObject>) => void }) {
  const crop = obj.crop ?? { x: 0, y: 0, width: obj.naturalWidth, height: obj.naturalHeight };
  const pct = (v: number, total: number) => Math.round((v / total) * 100);
  const setCrop = (left: number, top: number, right: number, bottom: number) => {
    const x = (left / 100) * obj.naturalWidth;
    const y = (top / 100) * obj.naturalHeight;
    const width = Math.max(1, obj.naturalWidth * (1 - (left + right) / 100));
    const height = Math.max(1, obj.naturalHeight * (1 - (top + bottom) / 100));
    const next = left + top + right + bottom === 0 ? null : { x, y, width, height };
    // Keep the displayed scale: box size follows the crop.
    const sx = obj.width / crop.width;
    const sy = obj.height / crop.height;
    update({ crop: next, width: width * sx, height: height * sy });
  };
  const left = pct(crop.x, obj.naturalWidth);
  const top = pct(crop.y, obj.naturalHeight);
  const right = pct(obj.naturalWidth - crop.x - crop.width, obj.naturalWidth);
  const bottom = pct(obj.naturalHeight - crop.y - crop.height, obj.naturalHeight);
  return (
    <Section title="Crop (% of image)">
      <div className="grid grid-cols-2 gap-2">
        <Num label="Left" value={left} min={0} max={95 - right} onChange={(v) => setCrop(v, top, right, bottom)} />
        <Num label="Right" value={right} min={0} max={95 - left} onChange={(v) => setCrop(left, top, v, bottom)} />
        <Num label="Top" value={top} min={0} max={95 - bottom} onChange={(v) => setCrop(left, v, right, bottom)} />
        <Num label="Bottom" value={bottom} min={0} max={95 - top} onChange={(v) => setCrop(left, top, right, v)} />
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={() => void import('@/actions/imageEdit').then((m) => m.replacePicture(obj))} data-testid="replace-picture">
          Replace picture…
        </Button>
        <Button size="sm" onClick={() => setCrop(0, 0, 0, 0)}>
          Reset crop
        </Button>
        <Button size="sm" onClick={() => update({ height: (obj.width * crop.height) / crop.width })}>
          Restore aspect
        </Button>
      </div>
    </Section>
  );
}

function FieldProps({ obj, update }: { obj: FieldObject; update: (p: Partial<FieldObject>) => void }) {
  return (
    <Section title={`${obj.fieldKind[0].toUpperCase()}${obj.fieldKind.slice(1)} field`}>
      <Field label={obj.fieldKind === 'radio' ? 'Group name' : 'Field name'} hint={obj.fieldKind === 'radio' ? 'Radio buttons with the same group name are mutually exclusive.' : undefined}>
        <Input value={obj.name} onChange={(e) => update({ name: e.target.value })} data-testid="field-name" />
      </Field>
      {obj.fieldKind === 'text' ? (
        <>
          <Field label="Default value">
            <Input value={obj.value} onChange={(e) => update({ value: e.target.value })} />
          </Field>
          <Checkbox checked={obj.multiline} label="Multiple lines" onChange={(multiline) => update({ multiline })} />
          <Num label="Font size (0 = auto)" value={obj.fontSize} min={0} max={72} onChange={(fontSize) => update({ fontSize })} />
          <SmartFieldProps obj={obj} update={update} />
        </>
      ) : null}
      {obj.fieldKind === 'radio' ? (
        <Field label="Option value">
          <Input value={obj.value} onChange={(e) => update({ value: e.target.value })} />
        </Field>
      ) : null}
      {obj.fieldKind === 'checkbox' ? <Checkbox checked={obj.value === 'checked'} label="Checked by default" onChange={(v) => update({ value: v ? 'checked' : '' })} /> : null}
      {obj.fieldKind === 'dropdown' ? (
        <>
          <Field label="Options (one per line)">
            <Textarea rows={4} value={obj.options.join('\n')} onChange={(e) => update({ options: e.target.value.split('\n') })} />
          </Field>
          <Field label="Default selection">
            <Select value={obj.value} ariaLabel="Default option" options={[{ value: '', label: '(none)' }, ...obj.options.filter(Boolean).map((o) => ({ value: o, label: o }))]} onChange={(value) => update({ value })} />
          </Field>
        </>
      ) : null}
      {obj.fieldKind === 'button' ? <ButtonProps obj={obj} update={update} /> : null}
      {obj.fieldKind === 'barcode' ? <BarcodeProps obj={obj} update={update} /> : null}
      {obj.fieldKind !== 'signature' && obj.fieldKind !== 'button' && obj.fieldKind !== 'barcode' ? <Checkbox checked={obj.required} label="Required" onChange={(required) => update({ required })} /> : null}
    </Section>
  );
}

/** Other field names of the document (for button targets and barcode templates). */
function useFieldNames(except: string): string[] {
  const objects = usePDFStore((s) => s.objects);
  return useMemo(() => [...new Set(objects.filter((o): o is FieldObject => o.type === 'field' && o.fieldKind !== 'button' && o.fieldKind !== 'barcode' && o.name !== except).map((o) => o.name))], [objects, except]);
}

function ButtonProps({ obj, update }: { obj: FieldObject; update: (p: Partial<FieldObject>) => void }) {
  const names = useFieldNames(obj.name);
  const a = obj.action ?? { kind: 'print' as const };
  const setKind = (kind: string) => {
    const next =
      kind === 'submit'
        ? { kind: 'submit' as const, email: '', subject: 'Completed form' }
        : kind === 'url'
          ? { kind: 'url' as const, url: 'https://' }
          : kind === 'showhide'
            ? { kind: 'showhide' as const, fields: [], hide: false }
            : kind === 'page'
              ? { kind: 'page' as const, page: 1 }
              : { kind: kind as 'reset' | 'print' };
    update({ action: next });
  };
  return (
    <>
      <Field label="Caption">
        <Input value={obj.value} onChange={(e) => update({ value: e.target.value })} data-testid="button-caption" />
      </Field>
      <Field label="When clicked">
        <Select
          value={a.kind}
          ariaLabel="Button action"
          onChange={setKind}
          options={[
            { value: 'submit', label: 'E-mail the filled form' },
            { value: 'reset', label: 'Clear the form' },
            { value: 'print', label: 'Print' },
            { value: 'url', label: 'Open a web page' },
            { value: 'showhide', label: 'Show or hide fields' },
            { value: 'page', label: 'Go to a page' },
          ]}
        />
      </Field>
      {a.kind === 'submit' ? (
        <>
          <Field label="Send to (e-mail)">
            <Input value={a.email} placeholder="name@example.com" onChange={(e) => update({ action: { ...a, email: e.target.value } })} data-testid="button-email" />
          </Field>
          <Field label="Subject">
            <Input value={a.subject} onChange={(e) => update({ action: { ...a, subject: e.target.value } })} />
          </Field>
        </>
      ) : null}
      {a.kind === 'url' ? (
        <Field label="Address">
          <Input value={a.url} onChange={(e) => update({ action: { ...a, url: e.target.value } })} />
        </Field>
      ) : null}
      {a.kind === 'page' ? <Num label="Page" value={a.page} min={1} max={9999} onChange={(page) => update({ action: { ...a, page } })} /> : null}
      {a.kind === 'showhide' ? (
        <>
          <Select value={a.hide ? 'hide' : 'show'} ariaLabel="Show or hide" onChange={(v: string) => update({ action: { ...a, hide: v === 'hide' } })} options={[{ value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide' }]} />
          <div className="mt-1 max-h-32 overflow-auto rounded border border-app p-1">
            {names.length ? (
              names.map((n) => (
                <Checkbox key={n} checked={a.fields.includes(n)} label={n} onChange={(v) => update({ action: { ...a, fields: v ? [...a.fields, n] : a.fields.filter((x) => x !== n) } })} />
              ))
            ) : (
              <p className="text-[11px] text-muted">Add the fields first.</p>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

function BarcodeProps({ obj, update }: { obj: FieldObject; update: (p: Partial<FieldObject>) => void }) {
  const names = useFieldNames(obj.name);
  const b = obj.barcode ?? { symbology: 'qr' as const, template: '' };
  return (
    <>
      <Field label="Type">
        <Select
          value={b.symbology}
          ariaLabel="Barcode type"
          onChange={(v: 'qr' | 'code128') => update({ barcode: { ...b, symbology: v } })}
          options={[
            { value: 'qr', label: 'QR code' },
            { value: 'code128', label: 'Code 128 (letters and digits)' },
          ]}
        />
      </Field>
      <Field label="Content" hint="{Field name} is replaced by the field's value when the form is saved.">
        <Textarea rows={4} value={b.template} onChange={(e) => update({ barcode: { ...b, template: e.target.value } })} data-testid="barcode-template" />
      </Field>
      {names.length ? (
        <div className="flex flex-wrap gap-1">
          {names.map((n) => (
            <button key={n} type="button" className="rounded border border-app px-1.5 text-[11px] hover-app" onClick={() => update({ barcode: { ...b, template: `${b.template}{${n}}` } })} data-no-translate>
              {`{${n}}`}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Format, allowed range and calculation of a text field (saved as Acrobat form actions). */
function SmartFieldProps({ obj, update }: { obj: FieldObject; update: (p: Partial<FieldObject>) => void }) {
  // Select the (stable) objects array and derive from it: a selector returning a new
  // array each time would re-render forever.
  const objects = usePDFStore((s) => s.objects);
  const others = useMemo(() => objects.filter((o): o is FieldObject => o.type === 'field' && o.fieldKind === 'text' && o.id !== obj.id).map((o) => o.name), [objects, obj.id]);
  const logic = obj.logic ?? {};
  const set = (p: Partial<FieldLogic>) => update({ logic: { ...logic, ...p } });
  const fmt = logic.format ?? null;
  const kind = fmt?.kind ?? 'none';
  const calc = logic.calc ?? null;
  const calcKind = calc?.op ?? 'none';
  const sepOptions = [
    { value: '2', label: '1.234,56' },
    { value: '3', label: '1234,56' },
    { value: '0', label: '1,234.56' },
    { value: '1', label: '1234.56' },
  ];
  const [formulaError, setFormulaError] = useState<string | null>(null);
  return (
    <div className="mt-3 border-t border-app pt-2" data-testid="smart-field">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Format, range & calculation</div>
      <Field label="Format">
        <Select
          value={kind}
          ariaLabel="Field format"
          options={[
            { value: 'none', label: 'None (any text)' },
            { value: 'number', label: 'Number' },
            { value: 'currency', label: 'Currency' },
            { value: 'percent', label: 'Percent' },
            { value: 'date', label: 'Date' },
          ]}
          onChange={(v: string) =>
            set({
              format:
                v === 'none'
                  ? null
                  : v === 'date'
                    ? { kind: 'date', pattern: 'dd.mm.yyyy' }
                    : v === 'percent'
                      ? { kind: 'percent', decimals: 0, sep: 2 }
                      : { kind: 'number', decimals: 2, sep: 2, currency: v === 'currency' ? ' lei' : '', currencyBefore: false },
            })
          }
        />
      </Field>
      {fmt && fmt.kind !== 'date' ? (
        <div className="grid grid-cols-2 gap-2">
          <Num label="Decimals" value={fmt.decimals} min={0} max={6} onChange={(decimals) => set({ format: { ...fmt, decimals } })} />
          <Field label="Separators">
            <Select value={String(fmt.sep)} ariaLabel="Separators" options={sepOptions} onChange={(v: string) => set({ format: { ...fmt, sep: Number(v) as 0 | 1 | 2 | 3 } })} />
          </Field>
        </div>
      ) : null}
      {fmt?.kind === 'number' && fmt.currency !== '' ? (
        <Field label="Currency symbol (with its space)">
          <Input value={fmt.currency} onChange={(e) => set({ format: { ...fmt, currency: e.target.value, currencyBefore: /^\S/.test(e.target.value) && !/^\s/.test(e.target.value) && e.target.value.trim().length === 1 } })} data-testid="field-currency" />
        </Field>
      ) : null}
      {fmt?.kind === 'date' ? (
        <Field label="Date pattern">
          <Select
            value={fmt.pattern}
            ariaLabel="Date pattern"
            options={['dd.mm.yyyy', 'dd/mm/yyyy', 'yyyy-mm-dd', 'mm/dd/yyyy', 'd.m.yyyy'].map((p) => ({ value: p, label: p }))}
            onChange={(pattern: string) => set({ format: { kind: 'date', pattern } })}
          />
        </Field>
      ) : null}
      {fmt && fmt.kind !== 'date' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Minimum">
            <Input value={logic.range?.min ?? ''} placeholder="—" onChange={(e) => set({ range: { min: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')), max: logic.range?.max ?? null } })} />
          </Field>
          <Field label="Maximum">
            <Input value={logic.range?.max ?? ''} placeholder="—" onChange={(e) => set({ range: { min: logic.range?.min ?? null, max: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) } })} />
          </Field>
        </div>
      ) : null}
      <Field label="Value">
        <Select
          value={calcKind}
          ariaLabel="Calculation"
          options={[
            { value: 'none', label: 'Typed by the person filling in' },
            { value: 'sum', label: 'Sum of fields' },
            { value: 'product', label: 'Product of fields' },
            { value: 'average', label: 'Average of fields' },
            { value: 'min', label: 'Smallest of fields' },
            { value: 'max', label: 'Largest of fields' },
            { value: 'formula', label: 'Formula' },
          ]}
          onChange={(v: string) =>
            set({ calc: v === 'none' ? null : v === 'formula' ? { op: 'formula', formula: calc && calc.op !== 'formula' ? calc.fields.join(' + ') : '' } : { op: v as 'sum', fields: calc && calc.op !== 'formula' ? calc.fields : [] } })
          }
        />
      </Field>
      {calc && calc.op !== 'formula' ? (
        <div className="mb-2 flex max-h-32 flex-col gap-1 overflow-auto rounded border border-app p-1.5">
          {others.length ? (
            others.map((n) => (
              <Checkbox
                key={n}
                checked={calc.fields.includes(n)}
                label={<span data-no-translate>{n}</span>}
                onChange={(on) => set({ calc: { op: calc.op, fields: on ? [...calc.fields, n] : calc.fields.filter((x) => x !== n) } })}
              />
            ))
          ) : (
            <p className="text-[11px] text-muted">Add other text fields first.</p>
          )}
        </div>
      ) : null}
      {calc?.op === 'formula' ? (
        <Field label="Formula (field names, + − × ÷ and brackets)">
          <Input
            value={calc.formula}
            placeholder="Qty * Price"
            data-testid="field-formula"
            onChange={(e) => {
              const formula = e.target.value;
              const used = formulaFields(formula, others);
              setFormulaError(used === null ? 'This formula cannot be read.' : used.filter((u) => !others.includes(u)).length ? `Unknown field: ${used.filter((u) => !others.includes(u)).join(', ')}` : null);
              set({ calc: { op: 'formula', formula } });
            }}
          />
        </Field>
      ) : null}
      {formulaError && calc?.op === 'formula' ? <p className="-mt-1 mb-2 text-[11px] text-rose-600">{formulaError}</p> : null}
      <p className="text-[11px] text-muted">Saved as standard form actions: Acrobat, Foxit and Adika format, check and calculate the field while it is filled in.</p>
    </div>
  );
}

function MultiProperties({ objs }: { objs: EditorObject[] }) {
  const s = usePDFStore.getState();
  const align = (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    const boxes = objs.map((o) => ({ o, w: 'width' in o ? o.width : 0, h: 'height' in o ? o.height : 0 }));
    const minX = Math.min(...boxes.map((b) => b.o.x));
    const maxX = Math.max(...boxes.map((b) => b.o.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.o.y));
    const maxY = Math.max(...boxes.map((b) => b.o.y + b.h));
    s.updateObjects(
      boxes.map(({ o, w, h }) => ({
        id: o.id,
        patch:
          mode === 'left'
            ? { x: minX }
            : mode === 'right'
              ? { x: maxX - w }
              : mode === 'center'
                ? { x: (minX + maxX) / 2 - w / 2 }
                : mode === 'top'
                  ? { y: minY }
                  : mode === 'bottom'
                    ? { y: maxY - h }
                    : { y: (minY + maxY) / 2 - h / 2 },
      })),
    );
  };
  return (
    <>
      <Section title="Align">
        <div className="grid grid-cols-3 gap-1.5">
          {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((m) => (
            <Button key={m} size="sm" onClick={() => align(m)}>
              {m}
            </Button>
          ))}
        </div>
      </Section>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => s.duplicateObjects(objs.map((o) => o.id))}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={() => s.deleteObjects(objs.map((o) => o.id))}>
          Delete all
        </Button>
      </div>
    </>
  );
}

// ================================================================ document

function DocumentPanel() {
  const tool = usePDFStore((s) => s.tool);
  return (
    <>
      {tool !== 'select' && tool !== 'pan' ? <ToolDefaults /> : null}
      <FormFill />
      <SignaturesSummary />
      <DocInfo />
    </>
  );
}

function ToolDefaults() {
  const style = usePDFStore((s) => s.style);
  const tool = usePDFStore((s) => s.tool);
  const set = usePDFStore((s) => s.setStyle);
  const isText = tool === 'text' || tool === 'editText';
  return (
    <Section title="Tool defaults">
      {isText ? (
        <>
          <Field label="Font">
            <Select value={style.fontFamily} options={FONT_OPTIONS} onChange={(fontFamily) => set({ fontFamily })} ariaLabel="Default font" />
          </Field>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Num label="Size" value={style.fontSize} min={3} max={400} onChange={(fontSize) => set({ fontSize })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs">Colour</span>
            <ColorSwatch label="Default text colour" value={style.color} onChange={(color) => set({ color: color ?? '#000000' })} />
          </div>
        </>
      ) : tool === 'highlight' ? (
        <div className="flex items-center justify-between">
          <span className="text-xs">Highlight colour</span>
          <ColorSwatch label="Default highlight" value={style.highlightColor} onChange={(c) => set({ highlightColor: c ?? '#facc15' })} />
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs">Stroke</span>
            <ColorSwatch label="Default stroke" value={style.stroke} onChange={(stroke) => set({ stroke: stroke ?? '#000000' })} />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs">Fill</span>
            <ColorSwatch label="Default fill" value={style.fill} allowNone onChange={(fill) => set({ fill })} />
          </div>
          <Num label="Stroke width" value={style.strokeWidth} min={0.25} max={50} step={0.5} onChange={(strokeWidth) => set({ strokeWidth })} />
        </>
      )}
    </Section>
  );
}

function FormFill() {
  const sources = usePDFStore((s) => s.sources);
  const fieldValues = usePDFStore((s) => s.fieldValues);
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);
  const [fields, setFields] = useState<Array<{ sourceId: string; field: FormFieldInfo }>>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const all: Array<{ sourceId: string; field: FormFieldInfo }> = [];
      for (const src of Object.values(sources)) for (const field of await readFormFields(src.bytes)) all.push({ sourceId: src.id, field });
      if (alive) setFields(all.filter((f) => !['button', 'other', 'signature'].includes(f.field.kind)));
    })();
    return () => {
      alive = false;
    };
  }, [sources]);

  if (fields.length === 0) return null;
  const setValue = (sourceId: string, name: string, value: FieldValue) => {
    // The value, then every calculated field of that document (totals after their parts).
    const patch: Record<string, FieldValue> = { [`${sourceId}::${name}`]: value };
    const mine = fields.filter((f) => f.sourceId === sourceId);
    const current = (n: string) => {
      const k = `${sourceId}::${n}`;
      const f = mine.find((x) => x.field.name === n);
      return k in patch ? patch[k] : k in fieldValues ? fieldValues[k] : f?.field.value;
    };
    const logic = Object.fromEntries(mine.map((f) => [f.field.name, f.field.logic ?? {}]));
    const names = mine.map((f) => f.field.name);
    for (const n of calcOrder(logic)) {
      const l = logic[n];
      const v = calculate(l.calc!, names, (x) => parseNumber(current(x) as string));
      const dec = l.format && l.format.kind !== 'date' ? l.format.decimals + (l.format.kind === 'percent' ? 2 : 0) : 6;
      patch[`${sourceId}::${n}`] = Number.isFinite(v) ? String(Math.round(v * 10 ** dec) / 10 ** dec) : '';
    }
    usePDFStore.getState().setFieldValues(patch);
    for (const [k, v] of Object.entries(patch)) void setViewerFieldValue(sourceId, k.slice(sourceId.length + 2), v).then(() => usePDFStore.getState().bumpRenderEpoch());
  };
  const missing = fields.filter(({ sourceId, field }) => {
    if (!field.required) return false;
    const k = `${sourceId}::${field.name}`;
    const v = k in fieldValues ? fieldValues[k] : field.value;
    return v === '' || v === false || (Array.isArray(v) && !v.length);
  }).length;
  return (
    <Section title={`Form fields (${fields.length})`}>
      {missing ? (
        <p className="mb-2 text-[11px] text-rose-600" data-testid="form-required-left">{`${missing} required field${missing === 1 ? '' : 's'} still empty`}</p>
      ) : null}
      <div className="flex flex-col gap-2" data-testid="form-fill">
        {fields.map(({ sourceId, field }) => {
          const key = `${sourceId}::${field.name}`;
          const value = key in fieldValues ? fieldValues[key] : field.value;
          const disabled = readOnly || field.readOnly;
          return (
            <div key={key}>
              <div className="mb-0.5 flex items-baseline gap-1 text-[11px] font-medium">
                <span className="truncate" title={field.name} data-no-translate>
                  {field.name}
                </span>
                {field.required ? <span className="text-rose-600" title="Required">*</span> : null}
                {field.logic?.calc ? <span className="truncate font-normal text-muted">{field.logic.calc.op === 'formula' ? `= ${field.logic.calc.formula}` : `= ${field.logic.calc.op}(${field.logic.calc.fields.join(', ')})`}</span> : null}
              </div>
              {field.kind === 'checkbox' ? (
                <Checkbox checked={value === true} disabled={disabled} label={value === true ? 'Checked' : 'Unchecked'} onChange={(v) => setValue(sourceId, field.name, v)} />
              ) : field.kind === 'radio' || field.kind === 'dropdown' ? (
                <Select
                  value={String(value ?? '')}
                  disabled={disabled}
                  ariaLabel={field.name}
                  options={[{ value: '', label: '—' }, ...field.options.map((o) => ({ value: o, label: o }))]}
                  onChange={(v) => setValue(sourceId, field.name, v)}
                />
              ) : field.kind === 'list' ? (
                <Select
                  value={Array.isArray(value) ? (value[0] ?? '') : String(value ?? '')}
                  disabled={disabled}
                  ariaLabel={field.name}
                  options={[{ value: '', label: '—' }, ...field.options.map((o) => ({ value: o, label: o }))]}
                  onChange={(v) => setValue(sourceId, field.name, v ? [v] : [])}
                />
              ) : (
                <CommitInput multiline={field.multiline} disabled={disabled || !!field.logic?.calc} value={String(value ?? '')} logic={field.logic} onCommit={(v) => setValue(sourceId, field.name, v)} label={field.name} />
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Commits on blur/Enter so typing doesn't flood the undo history. */
function CommitInput({ value, onCommit, multiline, disabled, label, logic }: { value: string; onCommit: (v: string) => void; multiline: boolean; disabled: boolean; label: string; logic?: FieldLogic }) {
  // Formatted while not editing ("1.234,50 lei"), the plain value while typing.
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const shown = editing ? text : displayValue(logic?.format, value);
  const commit = () => {
    setEditing(false);
    const r = checkInput(logic, text);
    setError(r.error);
    if (r.error) return;
    if (r.value !== value) onCommit(r.value);
  };
  const common = { 'aria-label': label, disabled, value: shown, onFocus: () => setEditing(true), onChange: (e: { target: { value: string } }) => setText(e.target.value), onBlur: commit };
  return (
    <>
      {multiline ? <Textarea rows={2} {...common} /> : <Input {...common} data-testid="form-input" onKeyDown={(e) => e.key === 'Enter' && commit()} />}
      {error ? <p className="mt-0.5 text-[11px] text-rose-600" data-testid="form-input-error">{error}</p> : null}
    </>
  );
}

function SignaturesSummary() {
  const sigs = usePDFStore((s) => s.signatureStatus);
  if (sigs.length === 0) return null;
  return (
    <Section title="Digital signatures">
      {sigs.map((sig) => {
        const ok = sig.integrity === 'valid' && !sig.modifiedAfterSigning;
        return (
          <button
            type="button"
            key={sig.fieldName}
            onClick={() => usePDFStore.getState().openModal('verify')}
            className="mb-1.5 flex w-full items-start gap-2 rounded-md border border-app p-2 text-left hover-app"
          >
            {ok ? <BadgeCheck size={16} className="mt-0.5 shrink-0 text-accent-600" /> : <BadgeX size={16} className="mt-0.5 shrink-0 text-rose-600" />}
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{sig.signerName || sig.fieldName}</span>
              <span className="block text-[11px] text-muted">{ok ? (sig.chainStatus === 'trusted' ? 'Valid, trusted' : 'Intact, identity not verified') : 'Integrity problem'}</span>
            </span>
          </button>
        );
      })}
    </Section>
  );
}

function DocInfo() {
  const fileName = usePDFStore((s) => s.fileName);
  const filePath = usePDFStore((s) => s.filePath);
  const pages = usePDFStore((s) => s.pages.length);
  const objects = usePDFStore((s) => s.objects.length);
  const sourceMap = usePDFStore((s) => s.sources);
  const sources = Object.values(sourceMap);
  const size = sources.reduce((n, s) => n + s.bytes.length, 0);
  return (
    <Section title="Document">
      <dl className="grid grid-cols-[80px_1fr] gap-y-1 text-xs">
        <dt className="text-muted">File</dt>
        <dd className="truncate" title={filePath ?? fileName ?? ''}>
          {fileName ?? '—'}
        </dd>
        <dt className="text-muted">Pages</dt>
        <dd>{pages}</dd>
        <dt className="text-muted">Edits</dt>
        <dd>{objects}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{(size / 1024 / 1024).toFixed(2)} MB</dd>
        {sources.length > 1 ? (
          <>
            <dt className="text-muted">Merged</dt>
            <dd>{sources.length - 1} file(s)</dd>
          </>
        ) : null}
      </dl>
    </Section>
  );
}
