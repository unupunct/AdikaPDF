/** Security → Find & redact: mark every e-mail, phone, IBAN, CNP, card number, date or chosen word. */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Textarea } from '@/components/ui/primitives';
import { PATTERNS, parseTerms, type PatternId } from '@/lib/patterns';
import type { TextMatch } from '@/lib/pdf/textSearch';

export function FindRedactModal() {
  const open = usePDFStore((s) => s.modal === 'find-redact');
  const close = () => usePDFStore.getState().openModal(null);
  const [patterns, setPatterns] = useState<PatternId[]>(['email', 'phone', 'iban', 'cnp', 'card']);
  const [terms, setTerms] = useState('');
  const [matches, setMatches] = useState<TextMatch[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setMatches(null);
  }, [open]);

  const find = async () => {
    setBusy(true);
    try {
      const { findSensitive } = await import('@/actions/findReplace');
      setMatches(await findSensitive({ patterns, terms: parseTerms(terms) }));
    } catch (e) {
      usePDFStore.getState().toast(`Search failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const mark = async () => {
    if (!matches?.length) return;
    const { markForRedaction } = await import('@/actions/findReplace');
    const n = markForRedaction(matches);
    close();
    usePDFStore.getState().toast(`Marked ${n} area${n === 1 ? '' : 's'} for redaction. Check them, then Security → Apply & save.`, 'success');
  };

  const pages = usePDFStore.getState().pages;
  const pageNo = (id: string) => pages.findIndex((p) => p.id === id) + 1;
  const nothingChosen = !patterns.length && !parseTerms(terms).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Find & redact"
      description="Finds sensitive data in the text of the document and marks it for redaction. Nothing is removed until you apply the redactions."
      width={560}
      testId="find-redact-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button onClick={() => void find()} disabled={busy || nothingChosen} data-testid="find-redact-search">
            {busy ? <Loader2 size={13} className="animate-spin" /> : null} Find
          </Button>
          <Button variant="primary" onClick={() => void mark()} disabled={!matches?.length} data-testid="find-redact-mark">
            Mark {matches?.length ? matches.length : ''} for redaction
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
                setMatches(null);
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
            setMatches(null);
            setTerms(e.target.value);
          }}
        />
      </Field>
      <p className="-mt-1 mb-2 text-[11px] text-muted">Words ignore case and diacritics (“stefan” also finds “Ștefan”). Numbers are checked (IBAN, CNP and card check digits), so amounts and invoice numbers are not marked.</p>
      {matches ? (
        matches.length ? (
          <div className="max-h-48 overflow-auto rounded-md border border-app" data-testid="find-redact-results">
            <table className="w-full text-[12px]" data-no-translate>
              <tbody>
                {matches.slice(0, 200).map((m, i) => (
                  <tr key={i} className="border-b border-app last:border-0">
                    <td className="w-16 px-2 py-1 text-muted">Page {pageNo(m.pageId)}</td>
                    <td className="px-2 py-1 font-mono">{m.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {matches.length > 200 ? <p className="px-2 py-1 text-[11px] text-muted">…and {matches.length - 200} more</p> : null}
          </div>
        ) : (
          <Callout kind="info">Nothing found. Scanned pages need OCR first (Optimise → OCR) so their text can be searched.</Callout>
        )
      ) : null}
    </Dialog>
  );
}
