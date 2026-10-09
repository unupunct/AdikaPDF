/** OCR dialog → Languages: every Tesseract language, the bundled and downloaded ones marked; download (on click, checked against pinned hashes) and remove. */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { Button, Callout, Input } from '@/components/ui/primitives';
import { OCR_LANG_CATALOG } from '@/lib/ocrLangCatalog';
import { downloadOcrLang, installedOcrLangs, isBundledOcrLang, removeOcrLang } from '@/lib/ocrLangs';
import { onlineAllowed } from '@/lib/policy';
import { usePDFStore } from '@/store/usePDFStore';

/** Installed languages (bundled first, then downloaded), shared by the OCR, Batch and Scan dialogs. */
export const useOcrLangs = create<{ installed: string[]; loaded: boolean; refresh: () => Promise<void> }>()((set) => ({
  installed: [],
  loaded: false,
  refresh: async () => set({ installed: await installedOcrLangs(), loaded: true }),
}));

/** Loads the installed list once. */
export function useInstalledOcrLangs(): string[] {
  const { installed, loaded, refresh } = useOcrLangs();
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);
  return installed;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

export function OcrLanguageManager({ onInstalled }: { onInstalled?: (code: string) => void }) {
  const installed = useInstalledOcrLangs();
  const refresh = useOcrLangs((s) => s.refresh);
  const [filter, setFilter] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = onlineAllowed('ocrLanguages');

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return OCR_LANG_CATALOG.filter((l) => !f || l.name.toLowerCase().includes(f) || l.code.includes(f));
  }, [filter]);

  const act = async (code: string, fn: () => Promise<void>) => {
    setWorking(code);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const download = (code: string) =>
    act(code, async () => {
      await downloadOcrLang(code);
      onInstalled?.(code);
      usePDFStore.getState().toast('Language installed.', 'success');
    });

  return (
    <div className="space-y-2" data-testid="ocr-lang-manager">
      {!allowed ? <Callout kind="info">Downloading OCR languages is turned off by your organisation.</Callout> : null}
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a language" aria-label="Find a language" data-testid="ocr-lang-filter" />
      <div className="max-h-56 overflow-auto rounded-md border border-app">
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map((l) => {
              const bundled = isBundledOcrLang(l.code);
              const have = installed.includes(l.code);
              return (
                <tr key={l.code} className="border-b border-app last:border-0" data-testid={`ocr-lang-${l.code}`}>
                  <td className="w-6 px-2 py-1">
                    <input type="checkbox" checked={have} readOnly disabled aria-label="Installed" />
                  </td>
                  <td className="px-2 py-1" data-no-translate>
                    {l.name} <span className="text-muted">({l.code})</span>
                  </td>
                  <td className="w-16 px-2 py-1 text-right text-muted">{mb(l.size)}</td>
                  <td className="w-28 px-2 py-1 text-right">
                    {bundled ? (
                      <span className="text-muted">Included</span>
                    ) : have ? (
                      <Button size="sm" onClick={() => void act(l.code, () => removeOcrLang(l.code))} disabled={!!working} data-testid={`ocr-lang-remove-${l.code}`}>
                        {working === l.code ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void download(l.code)} disabled={!!working || !allowed} data-testid={`ocr-lang-download-${l.code}`}>
                        {working === l.code ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Download
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted">Downloads come from the tesseract.js language packages on cdn.jsdelivr.net; each file is checked against its known SHA-256 before it is installed. Nothing is sent about your documents.</p>
      {error ? <Callout kind="error">{error}</Callout> : null}
    </div>
  );
}
