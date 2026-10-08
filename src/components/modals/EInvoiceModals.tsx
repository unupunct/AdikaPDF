/** Convert → E-invoice (e-Factura, Factur-X / ZUGFeRD) and Organize → Portfolio. */
import { useEffect, useState } from 'react';
import { FileDown, FileMinus2, FilePlus2, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Dialog, Input } from '@/components/ui/primitives';
import type { EInvoice } from '@/lib/einvoice/parse';
import type { PortfolioFile } from '@/lib/pdf/portfolio';

type Found = { name: string; xml: string; invoice: EInvoice; warnings: string[] };

export function EInvoiceModal() {
  const open = usePDFStore((s) => s.modal === 'einvoice');
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const close = () => usePDFStore.getState().openModal(null);
  const [found, setFound] = useState<Found | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setFound(undefined);
    void import('@/actions/einvoice').then((m) => m.currentEInvoice()).then(setFound, () => setFound(null));
  }, [open]);

  const act = async (fn: (m: typeof import('@/actions/einvoice')) => Promise<unknown>) => {
    const m = await import('@/actions/einvoice');
    close();
    await fn(m);
  };
  const inv = found?.invoice;
  const money = (n: number) => `${n.toFixed(2)} ${inv?.currency ?? ''}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="E-invoice"
      width={640}
      testId="einvoice-modal"
      footer={
        <>
          <Button onClick={() => void act((m) => m.openEInvoiceDialog())} data-testid="einvoice-open">
            Open e-invoice XML…
          </Button>
          <Button disabled={!hasDoc} onClick={() => void act((m) => m.makeEInvoicePdf())} data-testid="einvoice-embed">
            Embed invoice XML…
          </Button>
          <Button onClick={() => {
              close();
              void import('@/actions/einvoiceCreate').then((m) => m.openNewEInvoice());
            }} data-testid="einvoice-new">
            New e-invoice…
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-xs text-muted">
          Opens e-Factura (ANAF), UBL, Peppol and Factur-X / ZUGFeRD / XRechnung invoices as readable PDFs, and turns a PDF invoice and its XML into a Factur-X or PDF/A-3 e-invoice.
        </p>
        {found === undefined ? <p className="text-muted">Looking for an e-invoice in this document…</p> : null}
        {found === null && hasDoc ? <Callout kind="info">This document carries no electronic invoice.</Callout> : null}
        {found && inv ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-app p-2">
                <div className="text-[11px] font-semibold uppercase text-muted">
                  Seller
                </div>
                <div className="font-medium" data-no-translate>{inv.seller.name}</div>
                <div className="text-xs text-muted" data-no-translate>{[inv.seller.vatId, inv.seller.address.city, inv.seller.address.country].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="rounded-md border border-app p-2">
                <div className="text-[11px] font-semibold uppercase text-muted">
                  Buyer
                </div>
                <div className="font-medium" data-no-translate>{inv.buyer.name}</div>
                <div className="text-xs text-muted" data-no-translate>{[inv.buyer.vatId, inv.buyer.address.city, inv.buyer.address.country].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs" data-testid="einvoice-summary">
              <span>
                <span className="text-muted">No.</span> <b data-no-translate>{inv.number}</b>
              </span>
              <span>
                <span className="text-muted">Issue date</span> <span data-no-translate>{inv.issueDate}</span>
              </span>
              {inv.dueDate ? (
                <span>
                  <span className="text-muted">Due date</span> <span data-no-translate>{inv.dueDate}</span>
                </span>
              ) : null}
              <span>
                <span className="text-muted">Format</span> <span data-no-translate>{`${inv.syntax} · ${found.name}`}</span>
              </span>
            </div>
            <div className="max-h-48 overflow-auto rounded-md border border-app">
              <table className="w-full text-xs">
                <thead className="bg-app-subtle text-left text-muted">
                  <tr>
                    <th className="px-2 py-1">Description</th>
                    <th className="px-2 py-1 text-right">Qty</th>
                    <th className="px-2 py-1 text-right">Unit price</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody data-no-translate>
                  {inv.lines.map((l, i) => (
                    <tr key={i} className="border-t border-app">
                      <td className="px-2 py-1">{l.name}</td>
                      <td className="px-2 py-1 text-right">{l.quantity}</td>
                      <td className="px-2 py-1 text-right">{l.unitPrice.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{l.net.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-5 text-xs">
              <span>
                <span className="text-muted">Total without VAT</span> <span data-no-translate>{money(inv.totals.taxExclusive)}</span>
              </span>
              <span>
                <span className="text-muted">VAT</span> <span data-no-translate>{money(inv.totals.tax)}</span>
              </span>
              <span>
                <span className="text-muted">Amount due</span> <b data-no-translate data-testid="einvoice-due">{money(inv.totals.payable)}</b>
              </span>
            </div>
            {found.warnings.length ? (
              <Callout kind="warn">
                <ul className="list-disc pl-4" data-no-translate>
                  {found.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            ) : (
              <Callout kind="success">The totals add up.</Callout>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void import('@/actions/einvoice').then((m) => m.saveInvoiceXml(found.xml, found.name))} data-testid="einvoice-save-xml">
                <FileDown size={14} /> Save XML…
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void act(async (m) => {
                    const r = await m.renderInvoicePdf(found.xml, found.name);
                    const { openPdfBytes } = await import('@/actions/document');
                    await openPdfBytes(r.bytes, `${found.invoice.number || 'invoice'}.pdf`, null);
                  })
                }
              >
                Readable copy
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  close();
                  void import('@/actions/einvoiceCreate').then((m) => m.createCreditNote(found.invoice));
                }}
                data-testid="einvoice-credit-note"
              >
                <FileMinus2 size={14} /> Create credit note
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

export function PortfolioModal() {
  const open = usePDFStore((s) => s.modal === 'portfolio');
  const close = () => usePDFStore.getState().openModal(null);
  const [files, setFiles] = useState<PortfolioFile[]>([]);
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (open) {
      setFiles([]);
      setTitle('');
    }
  }, [open]);
  const add = async () => {
    const { pickPortfolioFiles } = await import('@/actions/portfolio');
    const picked = await pickPortfolioFiles();
    setFiles((f) => [...f, ...picked.filter((p) => !f.some((x) => x.name === p.name))]);
  };
  const create = async () => {
    const { createPortfolioFrom } = await import('@/actions/portfolio');
    close();
    await createPortfolioFrom(files, title.trim());
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="PDF Portfolio"
      width={600}
      testId="portfolio-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!files.length} onClick={() => void create()} data-testid="portfolio-create">
            Create portfolio
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-xs text-muted">One PDF that carries files of any kind (documents, spreadsheets, pictures), each with a description. Acrobat, Foxit and Adika list them; a cover page lists them for other readers.</p>
        <label className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Client file 2026" data-testid="portfolio-title" />
        </label>
        <div className="max-h-64 overflow-auto rounded-md border border-app">
          {files.length === 0 ? <p className="p-3 text-xs text-muted">No files yet.</p> : null}
          {files.map((f, i) => (
            <div key={f.name} className="flex items-center gap-2 border-b border-app px-2 py-1.5 last:border-0">
              <span className="w-40 shrink-0 truncate text-xs font-medium" title={f.name} data-no-translate>
                {f.name}
              </span>
              <span className="w-14 shrink-0 text-[11px] text-muted" data-no-translate>{`${Math.max(1, Math.round(f.bytes.length / 1024))} KB`}</span>
              <Input
                value={f.description ?? ''}
                placeholder="Description"
                aria-label="Description"
                onChange={(e) => setFiles((all) => all.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
              />
              <button type="button" aria-label="Remove" className="rounded p-1 hover-app" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div>
          <Button size="sm" onClick={() => void add()} data-testid="portfolio-add">
            <FilePlus2 size={14} /> Add files…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
