/** Print dialog: pages, and layout (normal, several per sheet, booklet, poster), then the Windows print dialog. */
import { useEffect, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import type { PrintLayout, SheetSize } from '@/lib/pdf/impose';
import { parseRanges } from '@/actions/convert';

type Kind = PrintLayout['kind'];
const SHEETS: Array<{ value: SheetSize; label: string }> = [
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
  { value: 'A5', label: 'A5' },
  { value: 'Letter', label: 'Letter' },
  { value: 'Legal', label: 'Legal' },
];

export function PrintModal() {
  const open = usePDFStore((s) => s.modal === 'print');
  const total = usePDFStore((s) => s.pages.length);
  const close = () => usePDFStore.getState().openModal(null);
  const [kind, setKind] = useState<Kind>('normal');
  const [range, setRange] = useState('');
  const [perSheet, setPerSheet] = useState<2 | 4 | 6 | 9 | 16>(2);
  const [order, setOrder] = useState<'across' | 'down'>('across');
  const [borders, setBorders] = useState(true);
  const [sheet, setSheet] = useState<SheetSize>('A4');
  const [scale, setScale] = useState('200');
  const [overlap, setOverlap] = useState('10');
  const [marks, setMarks] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const layout = (): PrintLayout => {
    switch (kind) {
      case 'nup':
        return { kind, perSheet, sheet, order, borders };
      case 'booklet':
        return { kind, sheet };
      case 'poster':
        return { kind, sheet, scale: Math.max(10, Number(scale) || 200) / 100, overlapMm: Math.max(0, Number(overlap) || 0), marks };
      default:
        return { kind: 'normal' };
    }
  };
  const pages = (): number[] | undefined => {
    if (!range.trim()) return undefined;
    let list: number[];
    try {
      list = parseRanges(range, total).flat();
    } catch {
      return undefined;
    }
    return list.length ? list.map((n) => n - 1) : undefined;
  };
  const rangeBad = !!range.trim() && !pages();
  const count = pages()?.length ?? total;
  const sheets = kind === 'nup' ? Math.ceil(count / perSheet) : kind === 'booklet' ? Math.ceil(count / 4) * 2 : kind === 'normal' ? count : null;

  const go = async (save: boolean) => {
    setBusy(true);
    try {
      const m = await import('@/actions/print');
      close();
      if (save) await m.saveLaidOut({ layout: layout(), pages: pages() });
      else await m.printDocument({ layout: layout(), pages: pages() });
    } finally {
      setBusy(false);
    }
  };

  const radio = (k: Kind, label: string, hint: string) => (
    <label className="flex items-start gap-2 text-[12.5px]">
      <input type="radio" name="print-layout" className="mt-0.5" checked={kind === k} onChange={() => setKind(k)} data-testid={`print-${k}`} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-[11px] text-muted">{hint}</span>
      </span>
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Print"
      width={560}
      testId="print-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button onClick={() => void go(true)} disabled={busy || rangeBad || kind === 'normal'} data-testid="print-save" title="Save the laid-out sheets as a PDF (for example for a print shop)">
            Save as PDF…
          </Button>
          <Button variant="primary" onClick={() => void go(false)} disabled={busy || rangeBad} data-testid="print-go">
            Print…
          </Button>
        </>
      }
    >
      <Field label="Pages">
        <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder={`All (1–${total}), or e.g. 1-3, 5`} data-testid="print-range" />
      </Field>
      {rangeBad ? <p className="-mt-1 mb-2 text-[11px] text-rose-600">These pages are not in the document.</p> : null}
      <div className="mb-3 grid gap-2">
        {radio('normal', 'Normal', 'One page per sheet; printer, copies and duplex in the next dialog')}
        {radio('nup', 'Several pages per sheet', 'Saves paper: 2, 4, 6, 9 or 16 pages on each sheet')}
        {radio('booklet', 'Booklet', 'Print on both sides (flip on the short edge), fold in the middle and staple')}
        {radio('poster', 'Poster', 'One page enlarged over several sheets to tape together')}
      </div>
      {kind !== 'normal' ? (
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Sheet size">
            <Select value={sheet} onChange={(v: SheetSize) => setSheet(v)} options={SHEETS} ariaLabel="Sheet size" />
          </Field>
          {kind === 'nup' ? (
            <>
              <Field label="Pages per sheet">
                <Select value={String(perSheet)} onChange={(v: string) => setPerSheet(Number(v) as typeof perSheet)} ariaLabel="Pages per sheet" options={['2', '4', '6', '9', '16'].map((v) => ({ value: v, label: v }))} />
              </Field>
              <Field label="Order">
                <Select value={order} onChange={(v: 'across' | 'down') => setOrder(v)} ariaLabel="Order" options={[{ value: 'across', label: 'Across, then down' }, { value: 'down', label: 'Down, then across' }]} />
              </Field>
              <div className="flex items-end pb-3">
                <Checkbox checked={borders} onChange={setBorders} label="Page borders" />
              </div>
            </>
          ) : kind === 'poster' ? (
            <>
              <Field label="Size (%)">
                <Input value={scale} onChange={(e) => setScale(e.target.value)} data-testid="print-scale" />
              </Field>
              <Field label="Overlap (mm)">
                <Input value={overlap} onChange={(e) => setOverlap(e.target.value)} />
              </Field>
              <div className="flex items-end pb-3">
                <Checkbox checked={marks} onChange={setMarks} label="Cut marks and labels" />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {sheets !== null ? (
        <Callout kind="info">
          <span data-testid="print-summary">{`${count} page${count === 1 ? '' : 's'} on ${sheets} sheet${sheets === 1 ? '' : 's'}`}</span>
        </Callout>
      ) : null}
    </Dialog>
  );
}
