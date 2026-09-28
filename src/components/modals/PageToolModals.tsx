/** Link, Crop pages and Page marks (watermark, header & footer, Bates, background) dialogs. */
import { useEffect, useMemo, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { useModalArgs } from '@/store/useModalArgs';
import { Button, Callout, Checkbox, ColorSwatch, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import { parseRanges } from '@/actions/convert';
import { applyCrop, applyPageMarks, removeAllPageMarks } from '@/actions/pageTools';
import { makeLink } from '@/lib/objectFactory';
import { displaySize } from '@/lib/geometry';
import { pickFiles } from '@/lib/platform';
import type { FontFamily } from '@/types';
import type { PageMarksOptions } from '@/lib/pdf/pageMarks';

const close = () => usePDFStore.getState().openModal(null);
const MM = 72 / 25.4;
const mm = (pt: number) => Math.round((pt / MM) * 10) / 10;

function NumInput({ label, value, onChange, min, max, step = 1, testId }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; testId?: string }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </Field>
  );
}

/** "All pages" / current / range picker; returns 1-based page numbers (undefined = all). */
function usePageScope(): { node: React.ReactNode; pages: () => number[] | undefined } {
  const count = usePDFStore((s) => s.pages.length);
  const currentIndex = usePDFStore((s) => Math.max(0, s.pages.findIndex((p) => p.id === s.currentPageId)));
  const [scope, setScope] = useState<'all' | 'current' | 'range'>('all');
  const [range, setRange] = useState('1-');
  const node = (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Pages">
        <Select
          value={scope}
          onChange={setScope}
          ariaLabel="Pages"
          options={[
            { value: 'all', label: `All ${count} pages` },
            { value: 'current', label: `Current page (${currentIndex + 1})` },
            { value: 'range', label: 'Range…' },
          ]}
        />
      </Field>
      {scope === 'range' ? (
        <Field label="Range" hint="e.g. 1-3, 7">
          <Input value={range} onChange={(e) => setRange(e.target.value)} />
        </Field>
      ) : null}
    </div>
  );
  const pages = () => (scope === 'all' ? undefined : scope === 'current' ? [currentIndex + 1] : [...new Set(parseRanges(range, count).flat())].sort((a, b) => a - b));
  return { node, pages };
}

// ================================================================ link

export function LinkModal() {
  const open = usePDFStore((s) => s.modal === 'link');
  const pages = usePDFStore((s) => s.pages);
  const draft = useModalArgs((s) => s.linkDraft);
  const [kind, setKind] = useState<'url' | 'page'>('url');
  const [url, setUrl] = useState('https://');
  const [pageNo, setPageNo] = useState(1);
  useEffect(() => {
    if (open) {
      setKind('url');
      setUrl('https://');
      setPageNo(1);
    }
  }, [open]);
  const valid = kind === 'url' ? /\S+\.\S+|^mailto:|^tel:/i.test(url.replace(/^https?:\/\//i, '')) : pageNo >= 1 && pageNo <= pages.length;
  const create = () => {
    if (!draft || !valid) return;
    const target = kind === 'url' ? { kind: 'url' as const, url: url.trim() } : { kind: 'page' as const, pageId: pages[pageNo - 1].id };
    usePDFStore.getState().addObject(makeLink(draft.pageId, draft.rect, target));
    useModalArgs.setState({ linkDraft: null });
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Create link"
      description="Clicking the area you drew opens a web page or jumps to a page."
      width={440}
      testId="link-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={create} data-testid="link-create">
            Create link
          </Button>
        </>
      }
    >
      <Field label="Link to">
        <Select
          value={kind}
          onChange={setKind}
          ariaLabel="Link to"
          options={[
            { value: 'url', label: 'A web page or e-mail address' },
            { value: 'page', label: 'A page in this document' },
          ]}
        />
      </Field>
      {kind === 'url' ? (
        <Field label="Address" hint="https://…, mailto:name@example.com">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} data-autofocus data-testid="link-url" />
        </Field>
      ) : (
        <NumInput label={`Page (1–${pages.length})`} value={pageNo} min={1} max={pages.length} onChange={(v) => setPageNo(Math.round(v))} testId="link-page" />
      )}
    </Dialog>
  );
}

// ================================================================ crop

export function CropModal() {
  const open = usePDFStore((s) => s.modal === 'crop');
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const draft = useModalArgs((s) => s.cropDraft);
  const scope = usePageScope();
  const [m, setM] = useState({ top: 10, right: 10, bottom: 10, left: 10 });
  const ref = pages.find((p) => p.id === (draft?.pageId ?? currentPageId)) ?? pages[0];
  const size = ref ? displaySize(ref) : { width: 595, height: 842 };
  useEffect(() => {
    if (!open) return;
    if (draft) {
      const r = draft.rect;
      setM({ top: mm(r.y), left: mm(r.x), right: mm(size.width - r.x - r.width), bottom: mm(size.height - r.y - r.height) });
    } else setM({ top: 10, right: 10, bottom: 10, left: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);
  const keptW = size.width - (m.left + m.right) * MM;
  const keptH = size.height - (m.top + m.bottom) * MM;
  const ok = keptW >= 10 && keptH >= 10 && Object.values(m).every((v) => v >= 0);
  const apply = async () => {
    close();
    useModalArgs.setState({ cropDraft: null });
    await applyCrop({ top: m.top * MM, right: m.right * MM, bottom: m.bottom * MM, left: m.left * MM }, scope.pages());
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          useModalArgs.setState({ cropDraft: null });
          close();
        }
      }}
      title="Crop pages"
      description="Hides the margins of the pages (the content outside stays in the file, as in Acrobat)."
      width={480}
      testId="crop-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={() => void apply()} data-testid="crop-apply">
            Crop
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-2">
        <NumInput label="Top (mm)" value={m.top} min={0} step={0.5} onChange={(top) => setM({ ...m, top })} testId="crop-top" />
        <NumInput label="Bottom (mm)" value={m.bottom} min={0} step={0.5} onChange={(bottom) => setM({ ...m, bottom })} testId="crop-bottom" />
        <NumInput label="Left (mm)" value={m.left} min={0} step={0.5} onChange={(left) => setM({ ...m, left })} testId="crop-left" />
        <NumInput label="Right (mm)" value={m.right} min={0} step={0.5} onChange={(right) => setM({ ...m, right })} testId="crop-right" />
      </div>
      <p className="mb-3 text-xs text-muted">
        Page size after cropping: {mm(Math.max(0, keptW))} × {mm(Math.max(0, keptH))} mm{draft ? ' (from the box you drew)' : ''}. Tip: use the Crop tool to draw the box on the page.
      </p>
      {scope.node}
      {!ok ? <Callout kind="error">The margins are larger than the page.</Callout> : null}
    </Dialog>
  );
}

// ================================================================ page marks

type MarksTab = 'watermark' | 'header' | 'background';

const FONT_OPTIONS: Array<{ value: FontFamily; label: string }> = [
  { value: 'sans', label: 'Sans (Noto Sans)' },
  { value: 'serif', label: 'Serif (Noto Serif)' },
  { value: 'mono', label: 'Monospace' },
];

export function PageMarksModal() {
  const open = usePDFStore((s) => s.modal === 'pageMarks');
  const tabArg = useModalArgs((s) => s.pageMarksTab);
  const [tab, setTab] = useState<MarksTab>('watermark');
  const scope = usePageScope();
  // Watermark
  const [wKind, setWKind] = useState<'text' | 'image'>('text');
  const [wText, setWText] = useState('CONFIDENTIAL');
  const [wFont, setWFont] = useState<FontFamily>('sans');
  const [wBold, setWBold] = useState(true);
  const [wSize, setWSize] = useState(64);
  const [wColor, setWColor] = useState('#b91c1c');
  const [wOpacity, setWOpacity] = useState(25);
  const [wRotation, setWRotation] = useState(45);
  const [wPos, setWPos] = useState<'center' | 'top' | 'bottom'>('center');
  const [wBehind, setWBehind] = useState(false);
  const [wImage, setWImage] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [wScale, setWScale] = useState(50);
  // Header & footer
  const [slots, setSlots] = useState({ headerLeft: '', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: 'Page {page} of {pages}', footerRight: '' });
  const [hSize, setHSize] = useState(9);
  const [hColor, setHColor] = useState('#000000');
  const [hMargins, setHMargins] = useState({ top: 12, bottom: 12, left: 15, right: 15 });
  const [startNo, setStartNo] = useState(1);
  const [bates, setBates] = useState(false);
  const [bPrefix, setBPrefix] = useState('');
  const [bSuffix, setBSuffix] = useState('');
  const [bDigits, setBDigits] = useState(6);
  const [bStart, setBStart] = useState(1);
  // Background
  const [bgColor, setBgColor] = useState('#fef9c3');
  const [bgOpacity, setBgOpacity] = useState(100);

  useEffect(() => {
    if (open) setTab(tabArg);
  }, [open, tabArg]);

  const hasHeaderText = Object.values(slots).some((v) => v.trim()) || bates;
  const canApply = tab === 'watermark' ? (wKind === 'text' ? !!wText.trim() : !!wImage) : tab === 'header' ? hasHeaderText : true;

  const options = useMemo((): PageMarksOptions => {
    if (tab === 'watermark') {
      return {
        watermark: {
          kind: wKind,
          ...(wKind === 'text' ? { text: wText, font: { family: wFont, bold: wBold, italic: false }, fontSize: wSize, color: wColor } : { imageBytes: wImage?.bytes, imageScale: wScale / 100 }),
          opacity: wOpacity / 100,
          rotation: wRotation,
          position: wPos,
          behind: wBehind,
        },
      };
    }
    if (tab === 'header') {
      const withBates = { ...slots };
      if (bates && !Object.values(slots).some((v) => v.includes('{bates}'))) withBates.footerRight = withBates.footerRight ? `${withBates.footerRight} {bates}` : '{bates}';
      return {
        headerFooter: {
          ...withBates,
          font: { family: 'sans', bold: false, italic: false },
          fontSize: hSize,
          color: hColor,
          margins: { top: hMargins.top * MM, bottom: hMargins.bottom * MM, left: hMargins.left * MM, right: hMargins.right * MM },
          startNumber: startNo,
          ...(bates ? { bates: { prefix: bPrefix, suffix: bSuffix, digits: bDigits, start: bStart } } : {}),
          date: new Date(),
        },
      };
    }
    return { background: { color: bgColor, opacity: bgOpacity / 100 } };
  }, [tab, wKind, wText, wFont, wBold, wSize, wColor, wImage, wScale, wOpacity, wRotation, wPos, wBehind, slots, bates, hSize, hColor, hMargins, startNo, bPrefix, bSuffix, bDigits, bStart, bgColor, bgOpacity]);

  const apply = async () => {
    const pages = scope.pages();
    close();
    await applyPageMarks({ ...options, pages });
  };

  const slot = (key: keyof typeof slots, label: string) => (
    <Field label={label}>
      <Input value={slots[key]} onChange={(e) => setSlots({ ...slots, [key]: e.target.value })} data-testid={`hf-${key}`} />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Watermark, header & footer, background"
      width={620}
      testId="page-marks-modal"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              close();
              void removeAllPageMarks();
            }}
            data-testid="marks-remove"
          >
            Remove all
          </Button>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => void apply()} data-testid="marks-apply">
            Apply
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'watermark', label: 'Watermark' },
          { value: 'header', label: 'Header & footer / Bates' },
          { value: 'background', label: 'Background' },
        ]}
      />
      {tab === 'watermark' ? (
        <>
          <Field label="Type">
            <Select value={wKind} onChange={setWKind} ariaLabel="Watermark type" options={[{ value: 'text', label: 'Text' }, { value: 'image', label: 'Image' }]} />
          </Field>
          {wKind === 'text' ? (
            <>
              <Field label="Text">
                <Input value={wText} onChange={(e) => setWText(e.target.value)} data-testid="wm-text" />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Font">
                  <Select value={wFont} onChange={setWFont} ariaLabel="Watermark font" options={FONT_OPTIONS} />
                </Field>
                <NumInput label="Size (pt)" value={wSize} min={6} max={300} onChange={setWSize} />
                <Field label="Colour">
                  <ColorSwatch label="Watermark colour" value={wColor} onChange={(c) => setWColor(c ?? '#b91c1c')} />
                </Field>
              </div>
              <Checkbox checked={wBold} onChange={setWBold} label="Bold" />
            </>
          ) : (
            <div className="mb-3 flex items-center gap-3">
              <Button
                onClick={async () => {
                  const [f] = await pickFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]);
                  if (f) setWImage({ name: f.name, bytes: f.bytes });
                }}
              >
                Choose image…
              </Button>
              <span className="truncate text-xs text-muted">{wImage?.name ?? 'No image chosen'}</span>
              <div className="ml-auto w-28">
                <NumInput label="Width (% of page)" value={wScale} min={5} max={100} onChange={setWScale} />
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <NumInput label="Opacity (%)" value={wOpacity} min={5} max={100} onChange={setWOpacity} />
            <NumInput label="Rotation (°)" value={wRotation} min={-180} max={180} onChange={setWRotation} />
            <Field label="Position">
              <Select value={wPos} onChange={setWPos} ariaLabel="Watermark position" options={[{ value: 'center', label: 'Centre' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }]} />
            </Field>
          </div>
          <Checkbox checked={wBehind} onChange={setWBehind} label="Behind the page content" />
        </>
      ) : tab === 'header' ? (
        <>
          <p className="mb-2 text-xs text-muted">Codes: {'{page}'} page number, {'{pages}'} page count, {'{date}'} today, {'{file}'} file name, {'{bates}'} Bates number.</p>
          <div className="grid grid-cols-3 gap-2">
            {slot('headerLeft', 'Header left')}
            {slot('headerCenter', 'Header centre')}
            {slot('headerRight', 'Header right')}
            {slot('footerLeft', 'Footer left')}
            {slot('footerCenter', 'Footer centre')}
            {slot('footerRight', 'Footer right')}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <NumInput label="Font size" value={hSize} min={4} max={48} onChange={setHSize} />
            <Field label="Colour">
              <ColorSwatch label="Header colour" value={hColor} onChange={(c) => setHColor(c ?? '#000000')} />
            </Field>
            <NumInput label="Start page no." value={startNo} min={0} onChange={(v) => setStartNo(Math.round(v))} />
            <div />
            <NumInput label="Top margin (mm)" value={hMargins.top} min={0} step={0.5} onChange={(top) => setHMargins({ ...hMargins, top })} />
            <NumInput label="Bottom (mm)" value={hMargins.bottom} min={0} step={0.5} onChange={(bottom) => setHMargins({ ...hMargins, bottom })} />
            <NumInput label="Left (mm)" value={hMargins.left} min={0} step={0.5} onChange={(left) => setHMargins({ ...hMargins, left })} />
            <NumInput label="Right (mm)" value={hMargins.right} min={0} step={0.5} onChange={(right) => setHMargins({ ...hMargins, right })} />
          </div>
          <Checkbox checked={bates} onChange={setBates} label="Bates numbering (legal page stamps)" />
          {bates ? (
            <div className="mt-2 grid grid-cols-4 gap-2">
              <Field label="Prefix">
                <Input value={bPrefix} onChange={(e) => setBPrefix(e.target.value)} data-testid="bates-prefix" />
              </Field>
              <NumInput label="Digits" value={bDigits} min={1} max={12} onChange={(v) => setBDigits(Math.round(v))} />
              <NumInput label="Start at" value={bStart} min={0} onChange={(v) => setBStart(Math.round(v))} />
              <Field label="Suffix">
                <Input value={bSuffix} onChange={(e) => setBSuffix(e.target.value)} />
              </Field>
            </div>
          ) : null}
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Colour">
            <ColorSwatch label="Background colour" value={bgColor} onChange={(c) => setBgColor(c ?? '#ffffff')} />
          </Field>
          <NumInput label="Opacity (%)" value={bgOpacity} min={5} max={100} onChange={setBgOpacity} />
        </div>
      )}
      <div className="mt-3">{scope.node}</div>
      <p className="text-[11px] text-muted">Marks are added to the page content (other readers show and print them). “Remove all” takes off every mark Adika added.</p>
    </Dialog>
  );
}
