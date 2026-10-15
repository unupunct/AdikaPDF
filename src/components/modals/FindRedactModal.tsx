/** Security → Find & redact: mark every e-mail, phone, IBAN, CNP, card number, date or chosen word, in the page text and everywhere else in the file. */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Select, Textarea } from '@/components/ui/primitives';
import { PATTERNS, parseTerms, type PatternId } from '@/lib/patterns';
import type { TextMatch } from '@/lib/pdf/textSearch';
import type { ElsewhereMatch } from '@/actions/findReplace';

/** "Comment on page 3", "Field name", "Metadata: Author". */
export function locationLabel(m: ElsewhereMatch): string {
  if (m.page) {
    switch (m.kind) {
      case 'comment':
        return `Comment on page ${m.page}`;
      case 'link':
        return `Link on page ${m.page}`;
      case 'attachment':
        return `Attachment on page ${m.page}`;
      case 'altText':
        return `Alternate text on page ${m.page}`;
    }
  }
  return m.where;
}

export function FindRedactModal() {
  const open = usePDFStore((s) => s.modal === 'find-redact');
  const close = () => usePDFStore.getState().openModal(null);
  const [patterns, setPatterns] = useState<PatternId[]>(['email', 'phone', 'iban', 'cnp', 'card']);
  const [terms, setTerms] = useState('');
  const [matches, setMatches] = useState<TextMatch[] | null>(null);
  const [elsewhere, setElsewhere] = useState<ElsewhereMatch[]>([]);
  const [outside, setOutside] = useState(true);
  const [comments, setComments] = useState<'remove' | 'redact'>('remove');
  const [bookmarks, setBookmarks] = useState<'redact' | 'remove'>('redact');
  const [fieldNames, setFieldNames] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setMatches(null);
      setElsewhere([]);
    }
  }, [open]);

  const reset = () => {
    setMatches(null);
    setElsewhere([]);
  };

  const query = () => ({ patterns, terms: parseTerms(terms) });

  const find = async () => {
    setBusy(true);
    try {
      const { findSensitive, findSensitiveElsewhere } = await import('@/actions/findReplace');
      const [onPages, other] = await Promise.all([findSensitive(query()), findSensitiveElsewhere(query())]);
      setMatches(onPages);
      setElsewhere(other);
    } catch (e) {
      usePDFStore.getState().toast(`Search failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useOutside = outside && elsewhere.some((m) => m.kind !== 'fieldName' || fieldNames);
  const total = (matches?.length ?? 0) + (useOutside ? elsewhere.length : 0);

  const mark = async () => {
    if (!total) return;
    const { markForRedaction, redactSensitiveElsewhere } = await import('@/actions/findReplace');
    // Outside the page text first: it rewrites the sources, the boxes then go on the new pages.
    const removed = useOutside ? await redactSensitiveElsewhere(query(), { comments, bookmarks, fieldNames }) : 0;
    const n = matches?.length ? markForRedaction(matches) : 0;
    close();
    const st = usePDFStore.getState();
    if (n) st.toast(`Marked ${n} area${n === 1 ? '' : 's'} for redaction. Check them, then Security → Apply & save.`, 'success');
    if (removed) st.toast(`Redacted ${removed} place${removed === 1 ? '' : 's'} outside the page text (comments, fields, bookmarks, metadata…). Save the document to keep the change; Undo restores them.`, 'success');
  };

  const pages = usePDFStore.getState().pages;
  const pageNo = (id: string) => pages.findIndex((p) => p.id === id) + 1;
  const nothingChosen = !patterns.length && !parseTerms(terms).length;
  const kinds = new Set(elsewhere.map((m) => m.kind));
  const rows: Array<{ where: string; detail?: string; text: string }> = [
    ...(matches ?? []).map((m) => ({ where: `Page ${pageNo(m.pageId)}`, text: m.text })),
    ...elsewhere.map((m) => ({ where: locationLabel(m), detail: m.detail, text: m.text })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Find & redact"
      description="Finds sensitive data in the text of the document, its comments, form fields, bookmarks, metadata, attachments and alternate text. Page text is marked for redaction; nothing there is removed until you apply the redactions."
      width={600}
      testId="find-redact-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button onClick={() => void find()} disabled={busy || nothingChosen} data-testid="find-redact-search">
            {busy ? <Loader2 size={13} className="animate-spin" /> : null} Find
          </Button>
          <Button variant="primary" onClick={() => void mark()} disabled={!total} data-testid="find-redact-mark">
            Redact {total || ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {PATTERNS.map((p) => (
          <div key={p.id} title={`e.g. ${p.example}`} data-testid={`pattern-${p.id}`}>
            <Checkbox
              checked={patterns.includes(p.id)}
              onChange={(on) => {
                reset();
                setPatterns((cur) => (on ? [...cur, p.id] : cur.filter((x) => x !== p.id)));
              }}
              label={p.label}
            />
          </div>
        ))}
      </div>
      <Field label="Words or phrases (one per line)">
        <Textarea
          rows={3}
          value={terms}
          data-testid="find-redact-terms"
          placeholder={'Ion Popescu\nStrada Lalelelor 5'}
          onChange={(e) => {
            reset();
            setTerms(e.target.value);
          }}
        />
      </Field>
      <p className="-mt-1 mb-2 text-[11px] text-muted">Words ignore case and diacritics (“stefan” also finds “Ștefan”). Numbers are checked (IBAN, CNP and card check digits), so amounts and invoice numbers are not marked.</p>
      {matches ? (
        rows.length ? (
          <div className="max-h-48 overflow-auto rounded-md border border-app" data-testid="find-redact-results">
            <table className="w-full text-[12px]">
              <tbody>
                {rows.slice(0, 200).map((r, i) => (
                  <tr key={i} className="border-b border-app last:border-0">
                    <td className="w-44 px-2 py-1 text-muted">{r.where}</td>
                    <td className="px-2 py-1 text-muted" data-no-translate>
                      {r.detail ?? ''}
                    </td>
                    <td className="px-2 py-1 font-mono" data-no-translate>
                      {r.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 200 ? <p className="px-2 py-1 text-[11px] text-muted">…and {rows.length - 200} more</p> : null}
          </div>
        ) : (
          <Callout kind="info">Nothing found. Scanned pages need OCR first (Optimise → OCR) so their text can be searched.</Callout>
        )
      ) : null}
      {elsewhere.length ? (
        <div className="mt-2 space-y-1.5" data-testid="find-redact-elsewhere">
          <Checkbox checked={outside} onChange={setOutside} label={`Also redact the ${elsewhere.length} found outside the page text (right away, can be undone)`} />
          {outside && kinds.has('comment') ? (
            <Field label="Comments containing a match">
              <Select value={comments} onChange={setComments} ariaLabel="Comments containing a match" options={[{ value: 'remove', label: 'Remove the comment and its replies (safest)' }, { value: 'redact', label: 'Keep the comment, black out the match' }]} />
            </Field>
          ) : null}
          {outside && kinds.has('bookmark') ? (
            <Field label="Bookmarks containing a match">
              <Select value={bookmarks} onChange={setBookmarks} ariaLabel="Bookmarks containing a match" options={[{ value: 'redact', label: 'Replace the match with ████' }, { value: 'remove', label: 'Remove the bookmark' }]} />
            </Field>
          ) : null}
          {outside && kinds.has('fieldName') ? <Checkbox checked={fieldNames} onChange={setFieldNames} label="Also rename field names and tooltips that contain a match" /> : null}
          {outside ? <p className="text-[11px] text-muted">Field values are cleared, metadata entries and alternate text removed, attachments and links containing a match removed.</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
