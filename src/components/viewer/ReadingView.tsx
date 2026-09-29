/**
 * View → Reading view: the document's text reflowed like an e-book —
 * headings, paragraphs, lists and tables in one column, with adjustable
 * text size, line width, font and colours. Page markers jump back to the page.
 */
import { useEffect, useState } from 'react';
import { AArrowDown, AArrowUp, Loader2, X } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { cn } from '@/lib/cn';
import type { ReflowBlock } from '@/lib/pdf/docWriters';

interface ReadingPrefs {
  size: number;
  width: 'narrow' | 'medium' | 'wide';
  theme: 'light' | 'sepia' | 'dark';
  family: 'serif' | 'sans';
}

const PREFS_KEY = 'adika.readingView';
const DEFAULT_PREFS: ReadingPrefs = { size: 19, width: 'medium', theme: 'sepia', family: 'serif' };

function loadPrefs(): ReadingPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ReadingPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

const THEMES: Record<ReadingPrefs['theme'], { bg: string; fg: string; muted: string; rule: string }> = {
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#6b7280', rule: '#e5e7eb' },
  sepia: { bg: '#f6efe1', fg: '#3b2f22', muted: '#8a7560', rule: '#e4d8c1' },
  dark: { bg: '#15171a', fg: '#e6e6e6', muted: '#8b929c', rule: '#2c3036' },
};
const WIDTHS = { narrow: '34em', medium: '42em', wide: '56em' };

async function loadBlocks(): Promise<ReflowBlock[]> {
  const [{ exportCurrentPdf }, { openPdf }, { extractStructuredText }, { layoutReflow }] = await Promise.all([
    import('@/actions/document'),
    import('@/lib/pdf/pdfService'),
    import('@/lib/pdf/convert'),
    import('@/lib/pdf/docWriters'),
  ]);
  const pdf = await openPdf(await exportCurrentPdf());
  try {
    return layoutReflow(await extractStructuredText(pdf));
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export function ReadingView() {
  const open = usePDFStore((s) => s.modal === 'readingview');
  const close = () => usePDFStore.getState().openModal(null);
  const [blocks, setBlocks] = useState<ReflowBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs);

  useEffect(() => {
    if (!open) return;
    setBlocks(null);
    setError(null);
    loadBlocks()
      .then(setBlocks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const update = (p: Partial<ReadingPrefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  const goToPage = (pageNumber: number) => {
    const s = usePDFStore.getState();
    const page = s.pages[pageNumber - 1];
    close();
    if (page) {
      s.setCurrentPage(page.id);
      s.scrollToPage(page.id);
    }
  };

  if (!open) return null;
  const t = THEMES[prefs.theme];
  let lastPage = 0;
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: t.bg, color: t.fg }} data-testid="reading-view" role="dialog" aria-label="Reading view">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs" style={{ borderColor: t.rule }}>
        <span className="font-semibold">Reading view</span>
        <div className="flex-1" />
        <button type="button" className="rounded p-1.5 hover:opacity-70" aria-label="Smaller text" onClick={() => update({ size: Math.max(12, prefs.size - 1) })} data-testid="reading-smaller">
          <AArrowDown size={16} />
        </button>
        <span className="w-8 text-center" data-testid="reading-size">
          {prefs.size}
        </span>
        <button type="button" className="rounded p-1.5 hover:opacity-70" aria-label="Larger text" onClick={() => update({ size: Math.min(34, prefs.size + 1) })} data-testid="reading-larger">
          <AArrowUp size={16} />
        </button>
        <select aria-label="Line width" className="rounded border bg-transparent px-1 py-0.5" style={{ borderColor: t.rule }} value={prefs.width} onChange={(e) => update({ width: e.target.value as ReadingPrefs['width'] })}>
          <option value="narrow">Narrow</option>
          <option value="medium">Medium</option>
          <option value="wide">Wide</option>
        </select>
        <select aria-label="Font" className="rounded border bg-transparent px-1 py-0.5" style={{ borderColor: t.rule }} value={prefs.family} onChange={(e) => update({ family: e.target.value as ReadingPrefs['family'] })}>
          <option value="serif">Serif</option>
          <option value="sans">Sans-serif</option>
        </select>
        {(['light', 'sepia', 'dark'] as const).map((th) => (
          <button
            key={th}
            type="button"
            aria-label={{ light: 'Light', sepia: 'Sepia', dark: 'Dark' }[th]}
            aria-pressed={prefs.theme === th}
            onClick={() => update({ theme: th })}
            className={cn('h-6 w-6 rounded-full border-2', prefs.theme === th ? 'border-brand-600' : 'border-transparent')}
            style={{ background: THEMES[th].bg, boxShadow: `inset 0 0 0 1px ${THEMES[th].rule}` }}
            data-testid={`reading-theme-${th}`}
          />
        ))}
        <button type="button" className="ml-2 rounded p-1.5 hover:opacity-70" aria-label="Close reading view" onClick={close} data-testid="reading-close">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="reading-scroll">
        <div className="mx-auto px-6 pt-6" style={{ maxWidth: WIDTHS[prefs.width] }}>
            {error ? <p style={{ color: '#dc2626' }}>{error}</p> : null}
            {!blocks && !error ? (
              <p className="flex items-center gap-2" style={{ color: t.muted, fontSize: 14 }}>
                <Loader2 size={14} className="animate-spin" /> <span>Preparing the text…</span>
              </p>
            ) : null}
            {blocks && !blocks.length ? (
              <p style={{ color: t.muted, fontSize: 14 }}>
                This document has no text to reflow (it may be scanned: run OCR first).
              </p>
            ) : null}
          </div>
        <article
          className="mx-auto px-6 py-10"
          style={{ maxWidth: WIDTHS[prefs.width], fontSize: `${prefs.size}px`, lineHeight: 1.6, fontFamily: prefs.family === 'serif' ? '"Noto Serif", Georgia, serif' : '"Noto Sans", "Segoe UI", sans-serif' }}
          data-testid="reading-article"
          data-no-translate
        >
          {blocks?.map((b, i) => {
            const marker =
              b.pageNumber !== lastPage ? (
                <button
                  type="button"
                  className="my-4 block w-full border-t pt-1 text-right text-[12px] hover:underline"
                  style={{ borderColor: t.rule, color: t.muted, fontFamily: 'sans-serif' }}
                  onClick={() => goToPage(b.pageNumber)}
                  data-testid="reading-page-marker"
                >
                  {`p. ${b.pageNumber}`}
                </button>
              ) : null;
            lastPage = b.pageNumber;
            const body =
              b.kind === 'heading' ? (
                b.level === 1 ? (
                  <h1 style={{ fontSize: '1.7em', lineHeight: 1.25, margin: '0.9em 0 0.4em', fontWeight: 700 }}>{b.text}</h1>
                ) : b.level === 2 ? (
                  <h2 style={{ fontSize: '1.35em', lineHeight: 1.3, margin: '0.9em 0 0.35em', fontWeight: 700 }}>{b.text}</h2>
                ) : (
                  <h3 style={{ fontSize: '1.12em', margin: '0.8em 0 0.3em', fontWeight: 700 }}>{b.text}</h3>
                )
              ) : b.kind === 'para' ? (
                <p style={{ margin: '0 0 0.8em', paddingLeft: b.bullet ? '1.2em' : 0, textIndent: b.bullet ? '-0.9em' : 0 }}>
                  {b.bullet ? '• ' : null}
                  {b.runs.map((r, k) => (
                    <span key={k} style={{ fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined }}>
                      {r.text}
                    </span>
                  ))}
                </p>
              ) : (
                <div className="my-3 overflow-x-auto">
                  <table style={{ borderCollapse: 'collapse', fontSize: '0.85em' }}>
                    <tbody>
                      {b.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((c, k) => (
                            <td key={k} style={{ border: `1px solid ${t.rule}`, padding: '0.25em 0.5em', verticalAlign: 'top', fontWeight: r === 0 ? 600 : undefined }}>
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            return (
              <div key={i}>
                {marker}
                {body}
              </div>
            );
          })}
        </article>
      </div>
    </div>
  );
}
