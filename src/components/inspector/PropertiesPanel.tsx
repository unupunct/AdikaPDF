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
      {obj.fieldKind !== 'signature' ? <Checkbox checked={obj.required} label="Required" onChange={(required) => update({ required })} /> : null}
    </Section>
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
    usePDFStore.getState().setFieldValue(`${sourceId}::${name}`, value);
    void setViewerFieldValue(sourceId, name, value).then(() => usePDFStore.getState().bumpRenderEpoch());
  };
  return (
    <Section title={`Form fields (${fields.length})`}>
      <div className="flex flex-col gap-2" data-testid="form-fill">
        {fields.map(({ sourceId, field }) => {
          const key = `${sourceId}::${field.name}`;
          const value = key in fieldValues ? fieldValues[key] : field.value;
          const disabled = readOnly || field.readOnly;
          return (
            <div key={key}>
              <div className="mb-0.5 truncate text-[11px] font-medium" title={field.name} data-no-translate>
                {field.name}
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
                <CommitInput multiline={field.multiline} disabled={disabled} value={String(value ?? '')} onCommit={(v) => setValue(sourceId, field.name, v)} label={field.name} />
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Commits on blur/Enter so typing doesn't flood the undo history. */
function CommitInput({ value, onCommit, multiline, disabled, label }: { value: string; onCommit: (v: string) => void; multiline: boolean; disabled: boolean; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return multiline ? (
    <Textarea aria-label={label} rows={2} disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
  ) : (
    <Input aria-label={label} disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
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
