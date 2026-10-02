/**
 * Filling a document's own form fields on the page (like Acrobat's Hand
 * tool): a text box, checkbox, radio button or list over each widget. Values
 * go through commitFieldValue, so the form's scripts and calculations run;
 * the page raster shows the result.
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { PageRef } from '@/types';
import { usePDFStore, type FieldValue } from '@/store/usePDFStore';
import { useFormView } from '@/store/formView';
import { getAnnotations, getPdfPage } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { commitFieldValue, sourceFields } from '@/actions/formFill';
import type { FormFieldInfo } from '@/actions/security';
import { displayValue } from '@/lib/formLogic';

interface WidgetAnnot {
  subtype: string;
  rect: [number, number, number, number];
  fieldName?: string;
  fieldType?: string;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  buttonValue?: string;
  exportValue?: string;
  combo?: boolean;
  multiLine?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  comb?: boolean;
  maxLen?: number;
  options?: Array<{ exportValue: string; displayValue: string }>;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  w: WidgetAnnot;
}

export const FormFillLayer = memo(function FormFillLayer({ page, zoom, active }: { page: PageRef; zoom: number; active: boolean }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [fields, setFields] = useState<Record<string, FormFieldInfo>>({});
  const sources = usePDFStore((s) => s.sources);
  const sourceId = page.kind === 'source' ? page.sourceId : undefined;
  const src = sourceId ? sources[sourceId] : undefined;

  useEffect(() => {
    let alive = true;
    if (!sourceId || !src) return;
    void (async () => {
      const loaded = await Promise.all([getAnnotations(sourceId, page.sourceIndex), getPdfPage(sourceId, page.sourceIndex), sourceFields(sourceId)]).catch(() => null);
      if (!loaded || !alive) return;
      const [annots, pdfPage, list] = loaded;
      const vp = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
      const out: Box[] = [];
      for (const a of annots as unknown as WidgetAnnot[]) {
        if (a.subtype !== 'Widget' || !a.fieldName || a.pushButton || a.fieldType === 'Sig' || a.hidden) continue;
        const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
        out.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), w: a });
      }
      setFields(Object.fromEntries(list.map((f) => [f.name, f])));
      setBoxes(out);
    })();
    return () => {
      alive = false;
    };
  }, [page, sourceId, src]);

  if (!active || !sourceId || boxes.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 16 }} data-testid="form-fill-layer">
      {boxes.map((b, i) => {
        const field = fields[b.w.fieldName!];
        if (!field) return null;
        return <Widget key={i} box={b} zoom={zoom} sourceId={sourceId} field={field} />;
      })}
    </div>
  );
});

function Widget({ box, zoom, sourceId, field }: { box: Box; zoom: number; sourceId: string; field: FormFieldInfo }) {
  const key = `${sourceId}::${field.name}`;
  const stored = usePDFStore((s) => (key in s.fieldValues ? s.fieldValues[key] : undefined));
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);
  const hidden = useFormView((v) => v.hidden[key] === true);
  const formatted = useFormView((v) => v.formatted[key]);
  const value: FieldValue = stored !== undefined ? stored : field.value;
  if (hidden) return null;
  const disabled = readOnly || field.readOnly || box.w.readOnly === true;
  const style = { left: box.left * zoom, top: box.top * zoom, width: box.width * zoom, height: box.height * zoom };
  const tint = 'pointer-events-auto absolute rounded-[1px] bg-[rgba(204,215,255,0.45)] outline-none hover:outline hover:outline-1 hover:outline-brand-500/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500';
  const commit = (v: FieldValue) => void commitFieldValue(sourceId, field.name, v);

  if (box.w.checkBox || box.w.radioButton) {
    const on = box.w.checkBox ? value === true : value === box.w.buttonValue;
    return (
      <button
        type="button"
        role={box.w.checkBox ? 'checkbox' : 'radio'}
        aria-checked={on}
        aria-label={field.label ?? field.name}
        data-testid="page-field"
        data-field={field.name}
        disabled={disabled}
        className={tint}
        style={style}
        onClick={() => commit(box.w.checkBox ? !on : (box.w.buttonValue ?? ''))}
      />
    );
  }
  if (box.w.fieldType === 'Ch') {
    const opts = box.w.options ?? field.options.map((o) => ({ exportValue: o, displayValue: o }));
    const cur = Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
    return (
      <select
        aria-label={field.label ?? field.name}
        data-testid="page-field"
        data-field={field.name}
        data-no-translate
        disabled={disabled}
        value={cur}
        className={`${tint} cursor-pointer appearance-none text-transparent focus:bg-white focus:text-slate-900`}
        style={{ ...style, fontSize: Math.max(8, Math.min(14, box.height * 0.6)) * zoom }}
        onChange={(e) => commit(field.kind === 'list' ? (e.target.value ? [e.target.value] : []) : e.target.value)}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.exportValue} value={o.exportValue}>
            {o.displayValue}
          </option>
        ))}
      </select>
    );
  }
  return (
    <TextWidget
      style={style}
      className={tint}
      zoom={zoom}
      height={box.height}
      multiline={box.w.multiLine === true || field.multiline}
      maxLength={box.w.maxLen || undefined}
      disabled={disabled}
      name={field.name}
      value={String(value ?? '')}
      shown={formatted && formatted.value === value ? formatted.text : displayValue(field.logic?.format, String(value ?? ''))}
      onCommit={commit}
    />
  );
}

/** A text field: transparent over the page appearance until it has the focus, then the plain value to edit. */
function TextWidget(props: {
  style: React.CSSProperties;
  className: string;
  zoom: number;
  height: number;
  multiline: boolean;
  maxLength?: number;
  disabled: boolean;
  name: string;
  value: string;
  shown: string;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.value);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setText(props.value);
  }, [props.value, editing]);
  const fontSize = (props.multiline ? 11 : Math.max(7, Math.min(16, props.height * 0.62))) * props.zoom;
  const commit = () => {
    setEditing(false);
    if (cancelled.current) cancelled.current = false;
    else if (text !== props.value) props.onCommit(text);
  };
  const common = {
    'aria-label': props.name,
    'data-testid': 'page-field',
    'data-field': props.name,
    'data-no-translate': true,
    spellCheck: true,
    disabled: props.disabled,
    maxLength: props.maxLength,
    value: editing ? text : props.shown,
    onFocus: () => {
      setText(props.value);
      setEditing(true);
    },
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: commit,
    // Unfocused, the page shows the field's own appearance; focused, a plain box to type in.
    className: `${props.className} border-0 px-[2px] py-0 ${editing ? 'bg-white text-slate-900 shadow-[0_0_0_1px_rgba(59,130,246,0.7)]' : 'text-transparent caret-transparent'}`,
    style: { ...props.style, fontSize, lineHeight: 1.15 },
  };
  return props.multiline ? (
    <textarea {...common} className={`${common.className} resize-none`} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
