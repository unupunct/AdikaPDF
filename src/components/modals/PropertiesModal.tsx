/** Document properties: description (editable), file, PDF, security and fonts. */
import { useEffect, useState, type ReactNode } from 'react';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Dialog, Field, Input, Tabs } from '@/components/ui/primitives';
import { getSourceDoc, pdfjs } from '@/lib/pdf/pdfService';
import { displaySize } from '@/lib/geometry';

interface Info {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  created: string;
  modified: string;
  version: string;
  linearized: boolean;
  forms: string;
  permissions: string[] | null;
  encrypted: boolean;
  fonts: Array<{ name: string; type: string; embedded: boolean; subset: boolean }>;
}

const PERMISSION_NAMES: Record<number, string> = {
  4: 'Printing',
  8: 'Changing the document',
  16: 'Copying text and images',
  32: 'Commenting',
  256: 'Filling forms',
  512: 'Content extraction for accessibility',
  1024: 'Page assembly',
  2048: 'High-quality printing',
};

function formatDate(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '—';
  const d = pdfjs.PDFDateString.toDateObject(raw);
  return d ? d.toLocaleString() : raw;
}

async function readInfo(sourceId: string, bytes: Uint8Array): Promise<Info> {
  const doc = await getSourceDoc(sourceId);
  const meta = await doc.getMetadata();
  const i = (meta.info ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const perms = await doc.getPermissions();
  const fonts: Info['fonts'] = [];
  let encrypted = false;
  try {
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    const seen = new Set<string>();
    for (const [, obj] of lib.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
      const sub = obj.get(PDFName.of('Subtype'))?.toString().slice(1) ?? '';
      if (sub === 'Type0') continue; // described by its descendant
      const base = obj.get(PDFName.of('BaseFont'))?.toString().slice(1) ?? '(unnamed)';
      if (seen.has(base)) continue;
      seen.add(base);
      const fd = obj.lookup(PDFName.of('FontDescriptor'));
      const embedded = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
      fonts.push({ name: base.replace(/^[A-Z]{6}\+/, ''), type: sub, embedded: embedded || sub === 'Type3', subset: /^[A-Z]{6}\+/.test(base) });
    }
  } catch {
    encrypted = true; // pdf-lib refuses encrypted files
  }
  return {
    title: str('Title'),
    author: str('Author'),
    subject: str('Subject'),
    keywords: str('Keywords'),
    creator: str('Creator'),
    producer: str('Producer'),
    created: formatDate(i.CreationDate),
    modified: formatDate(i.ModDate),
    version: str('PDFFormatVersion'),
    linearized: i.IsLinearized === true,
    forms: i.IsXFAPresent ? 'XFA form' : i.IsAcroFormPresent ? 'Interactive form (AcroForm)' : 'None',
    permissions: perms ? Object.entries(PERMISSION_NAMES).filter(([bit]) => perms.has(Number(bit))).map(([, n]) => n) : null,
    encrypted: encrypted || usePDFStore.getState().readOnlyReason !== null,
    fonts: fonts.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function PropertiesModal() {
  const open = usePDFStore((s) => s.modal === 'properties');
  const close = () => usePDFStore.getState().openModal(null);
  const [tab, setTab] = useState<'description' | 'fonts'>('description');
  const [info, setInfo] = useState<Info | null>(null);
  const [draft, setDraft] = useState({ title: '', author: '', subject: '', keywords: '' });
  const s = usePDFStore.getState();

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    const first = s.pages.find((p) => p.sourceId);
    const src = first?.sourceId ? s.sources[first.sourceId] : undefined;
    if (!src) return;
    void readInfo(src.id, src.bytes).then((i) => {
      setInfo(i);
      const m = usePDFStore.getState().docMeta;
      setDraft({ title: m?.title ?? i.title, author: m?.author ?? i.author, subject: m?.subject ?? i.subject, keywords: m?.keywords ?? i.keywords });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const page = s.pages.find((p) => p.id === s.currentPageId) ?? s.pages[0];
  const size = page ? displaySize(page) : null;
  const bytes = Object.values(s.sources).reduce((n, x) => n + x.bytes.length, 0);
  const readOnly = s.readOnlyReason !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Document properties"
      width={620}
      testId="properties-modal"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button
            variant="primary"
            disabled={readOnly || !info}
            data-testid="properties-apply"
            onClick={() => {
              usePDFStore.getState().setDocMeta(draft);
              usePDFStore.getState().toast('Properties will be written when you save.', 'success');
              close();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'description', label: 'Description' }, { value: 'fonts', label: `Fonts${info ? ` (${info.fonts.length})` : ''}` }]} />
      {tab === 'description' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title">
              <Input value={draft.title} disabled={readOnly} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="prop-title" />
            </Field>
            <Field label="Author">
              <Input value={draft.author} disabled={readOnly} onChange={(e) => setDraft({ ...draft, author: e.target.value })} data-testid="prop-author" />
            </Field>
            <Field label="Subject">
              <Input value={draft.subject} disabled={readOnly} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            </Field>
            <Field label="Keywords">
              <Input value={draft.keywords} disabled={readOnly} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
            </Field>
          </div>
          <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5 text-xs" data-testid="properties-list">
            <Row label="File">{s.filePath ?? s.fileName ?? '—'}</Row>
            <Row label="File size">{(bytes / 1024 / 1024).toFixed(2)} MB</Row>
            <Row label="Pages">{s.pages.length}</Row>
            <Row label="Page size">{size ? `${((size.width / 72) * 25.4).toFixed(0)} × ${((size.height / 72) * 25.4).toFixed(0)} mm (${(size.width / 72).toFixed(2)} × ${(size.height / 72).toFixed(2)} in)` : '—'}</Row>
            <Row label="PDF version">{info?.version || '—'}</Row>
            <Row label="Created">{info?.created ?? '…'}</Row>
            <Row label="Modified">{info?.modified ?? '…'}</Row>
            <Row label="Application">{info?.creator || '—'}</Row>
            <Row label="PDF producer">{info?.producer || '—'}</Row>
            <Row label="Fast web view">{info ? (info.linearized ? 'Yes' : 'No') : '…'}</Row>
            <Row label="Forms">{info?.forms ?? '…'}</Row>
            <Row label="Security">
              {info ? (info.encrypted ? 'Password protected (encrypted)' : 'No security') : '…'}
              {info?.permissions ? <span className="block text-muted">Allowed: {info.permissions.join(', ') || 'nothing'}</span> : null}
            </Row>
            <Row label="Signatures">{s.signatureStatus.length || 'None'}</Row>
          </dl>
        </>
      ) : (
        <div className="max-h-[360px] overflow-auto" data-testid="properties-fonts">
          {!info ? <p className="text-xs text-muted">Reading fonts…</p> : info.fonts.length === 0 ? <p className="text-xs text-muted">{info.encrypted ? 'Fonts cannot be listed for encrypted files.' : 'No fonts (image-only document).'}</p> : null}
          <table className="w-full text-xs">
            <tbody>
              {info?.fonts.map((f) => (
                <tr key={f.name} className="border-b border-app last:border-0">
                  <td className="py-1.5 pr-2 font-medium">{f.name}</td>
                  <td className="py-1.5 pr-2 text-muted">{f.type}</td>
                  <td className="py-1.5 text-muted">{f.embedded ? (f.subset ? 'Embedded subset' : 'Embedded') : 'Not embedded'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-all">{children}</dd>
    </>
  );
}
