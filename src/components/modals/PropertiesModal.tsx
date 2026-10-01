/** Document properties: description (editable), file, PDF, security and fonts. */
import { useEffect, useState, type ReactNode } from 'react';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Dialog, Field, Input, Select, Tabs, Textarea } from '@/components/ui/primitives';
import { Plus, Trash2 } from 'lucide-react';
import type { DocMeta } from '@/store/usePDFStore';
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
  rightsStatus: 'unknown' | 'copyrighted' | 'public';
  copyright: string;
  copyrightUrl: string;
  custom: Record<string, string>;
  xmp: string | null;
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
  let extra: Pick<Info, 'rightsStatus' | 'copyright' | 'copyrightUrl' | 'custom' | 'xmp'> = { rightsStatus: 'unknown', copyright: '', copyrightUrl: '', custom: {}, xmp: null };
  try {
    const lib = await PDFDocument.load(bytes, { updateMetadata: false });
    const x = await import('@/lib/pdf/xmp');
    const f = x.readXmpFields(lib);
    const packet = x.readXmpPacket(lib);
    extra = { rightsStatus: f?.rightsStatus ?? 'unknown', copyright: f?.copyright ?? '', copyrightUrl: f?.copyrightUrl ?? '', custom: x.readCustomInfo(lib), xmp: packet ? x.xmpForDisplay(packet) : null };
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
    ...extra,
  };
}

export function PropertiesModal() {
  const open = usePDFStore((s) => s.modal === 'properties');
  const close = () => usePDFStore.getState().openModal(null);
  const [tab, setTab] = useState<'description' | 'more' | 'fonts'>('description');
  const [info, setInfo] = useState<Info | null>(null);
  const [draft, setDraft] = useState<Required<Omit<DocMeta, 'custom'>> & { custom: Array<[string, string]> }>({ title: '', author: '', subject: '', keywords: '', rightsStatus: 'unknown', copyright: '', copyrightUrl: '', custom: [] });
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
      setDraft({
        title: m?.title ?? i.title,
        author: m?.author ?? i.author,
        subject: m?.subject ?? i.subject,
        keywords: m?.keywords ?? i.keywords,
        rightsStatus: m?.rightsStatus ?? i.rightsStatus,
        copyright: m?.copyright ?? i.copyright,
        copyrightUrl: m?.copyrightUrl ?? i.copyrightUrl,
        custom: Object.entries(m?.custom ?? i.custom),
      });
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
              usePDFStore.getState().setDocMeta({ ...draft, custom: Object.fromEntries(draft.custom.filter(([k]) => k.trim())) });
              usePDFStore.getState().toast('Properties will be written when you save.', 'success');
              close();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'description', label: 'Description' },
          { value: 'more', label: 'Copyright & custom' },
          { value: 'fonts', label: `Fonts${info ? ` (${info.fonts.length})` : ''}` },
        ]}
      />
      {tab === 'more' ? (
        <div className="flex flex-col gap-3" data-testid="properties-more">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Copyright status">
              <Select
                value={draft.rightsStatus}
                ariaLabel="Copyright status"
                onChange={(rightsStatus) => setDraft({ ...draft, rightsStatus })}
                options={[
                  { value: 'unknown', label: 'Unknown' },
                  { value: 'copyrighted', label: 'Copyrighted' },
                  { value: 'public', label: 'Public domain' },
                ]}
              />
            </Field>
            <Field label="Copyright info URL">
              <Input value={draft.copyrightUrl} disabled={readOnly} onChange={(e) => setDraft({ ...draft, copyrightUrl: e.target.value })} placeholder="https://" data-testid="prop-copyright-url" />
            </Field>
          </div>
          <Field label="Copyright notice">
            <Input value={draft.copyright} disabled={readOnly} onChange={(e) => setDraft({ ...draft, copyright: e.target.value })} placeholder="© 2026 …" data-testid="prop-copyright" />
          </Field>
          <div>
            <div className="mb-1 text-xs font-medium">Custom properties</div>
            {draft.custom.map(([k, v], i) => (
              <div key={i} className="mb-1 flex gap-1.5">
                <Input value={k} disabled={readOnly} aria-label="Property name" placeholder="Name" data-testid="prop-custom-name" onChange={(e) => setDraft({ ...draft, custom: draft.custom.map((r, j) => (j === i ? [e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''), r[1]] : r)) })} />
                <Input value={v} disabled={readOnly} aria-label="Property value" placeholder="Value" data-testid="prop-custom-value" onChange={(e) => setDraft({ ...draft, custom: draft.custom.map((r, j) => (j === i ? [r[0], e.target.value] : r)) })} />
                <button type="button" aria-label="Remove" disabled={readOnly} className="rounded p-1.5 hover-app" onClick={() => setDraft({ ...draft, custom: draft.custom.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <Button size="sm" disabled={readOnly} onClick={() => setDraft({ ...draft, custom: [...draft.custom, ['', '']] })} data-testid="prop-custom-add">
              <Plus size={13} /> Add property
            </Button>
          </div>
          <Field label="XMP metadata (as stored)">
            <Textarea rows={6} readOnly value={info?.xmp ?? ''} placeholder="This document has no XMP metadata yet; it gets it when you apply and save." className="font-mono text-[10.5px]" data-no-translate />
          </Field>
        </div>
      ) : null}
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
      ) : tab === 'fonts' ? (
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
      ) : null}
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
