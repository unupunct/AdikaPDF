/** Organize → Replace pages: swap pages for pages of another PDF (comments and bookmarks stay). */
import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Dialog, Field, Input } from '@/components/ui/primitives';
import { pickFiles } from '@/lib/platform';
import { parseRanges } from '@/actions/convert';

export function ReplacePagesModal() {
  const open = usePDFStore((s) => s.modal === 'replacePages');
  const total = usePDFStore((s) => s.pages.length);
  const close = () => usePDFStore.getState().openModal(null);
  const [file, setFile] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);
  const [range, setRange] = useState('');
  const [from, setFrom] = useState('1');

  useEffect(() => {
    if (!open) return;
    const s = usePDFStore.getState();
    const cur = s.pages.findIndex((p) => p.id === s.currentPageId);
    setRange(String(Math.max(0, cur) + 1));
    setFrom('1');
    setFile(null);
  }, [open]);

  const choose = async () => {
    const [f] = await pickFiles([{ name: 'PDF documents', extensions: ['pdf'] }]);
    if (!f) return;
    const { PDFDocument } = await import('pdf-lib');
    const n = await PDFDocument.load(f.bytes, { ignoreEncryption: true }).then((d) => d.getPageCount()).catch(() => 0);
    if (!n) {
      usePDFStore.getState().toast(`“${f.name}” could not be read as a PDF.`, 'error');
      return;
    }
    setFile({ bytes: f.bytes, name: f.name, pages: n });
  };

  let targets: number[] = [];
  let error = '';
  try {
    targets = parseRanges(range, total).flat().map((n) => n - 1);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const start = Math.max(1, Number(from) || 1);
  if (!error && file && start - 1 + targets.length > file.pages) error = `The other file has ${file.pages} page(s): not enough from page ${start}.`;

  const run = async () => {
    if (!file || error || !targets.length) return;
    const { replacePages } = await import('@/actions/pageOps');
    if (await replacePages(targets, file, start - 1)) close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Replace pages"
      description="Pages of this document are swapped for pages of another PDF. Comments on them and bookmarks pointing to them are kept. Undo restores the originals."
      width={500}
      testId="replace-pages-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void run()} disabled={!file || !!error || !targets.length} data-testid="replace-pages-go">
            Replace
          </Button>
        </>
      }
    >
      <Field label="Replace these pages">
        <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 2, 5-7" data-testid="replace-pages-range" />
      </Field>
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" onClick={() => void choose()} data-testid="replace-pages-file">
          <FileText size={13} /> Choose PDF…
        </Button>
        {file ? (
          <span className="min-w-0 truncate text-[12px]" data-no-translate>
            {file.name}
          </span>
        ) : null}
        {file ? <span className="text-[12px] text-muted">{`(${file.pages} page${file.pages === 1 ? '' : 's'})`}</span> : null}
      </div>
      <Field label="With its pages starting at page">
        <Input value={from} onChange={(e) => setFrom(e.target.value)} data-testid="replace-pages-from" />
      </Field>
      {error && range.trim() ? <p className="text-[11px] text-rose-600">{error}</p> : null}
    </Dialog>
  );
}
