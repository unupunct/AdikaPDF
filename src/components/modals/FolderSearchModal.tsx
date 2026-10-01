/** Home → Search folders: every PDF in chosen folders searched at once, from an index kept on this computer. */
import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderPlus, RefreshCw, X } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Dialog, Input } from '@/components/ui/primitives';
import { isDesktop, pickFolder } from '@/lib/platform';
import { searchIndex, type SearchIndex } from '@/lib/searchIndex';

export function FolderSearchModal() {
  const open = usePDFStore((s) => s.modal === 'foldersearch');
  const close = () => usePDFStore.getState().openModal(null);
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    if (open) void import('@/actions/folderSearch').then((m) => m.loadSearchIndex()).then(setIndex);
  }, [open]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const results = useMemo(() => (index && debounced.trim() ? searchIndex(index, debounced) : []), [index, debounced]);
  const files = index ? Object.values(index.files) : [];
  const noText = files.filter((f) => f.error || f.pages.every((p) => !p.trim())).length;

  const setFolders = async (folders: string[]) => {
    const m = await import('@/actions/folderSearch');
    setIndex(await m.setSearchFolders(folders));
    const updated = await m.updateSearchIndex();
    if (updated) setIndex({ ...updated });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Search folders"
      description="Searches the text of every PDF in the folders you add (subfolders too). The index stays on this computer and only changed files are read again."
      width={760}
      testId="foldersearch-modal"
      footer={<Button onClick={close}>Close</Button>}
    >
      {!isDesktop ? <Callout kind="warn">Searching folders needs the Adika desktop app.</Callout> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {index?.folders.map((f) => (
          <span key={f} className="flex items-center gap-1 rounded-full border border-app px-2 py-0.5 text-[11px]" title={f}>
            <span className="max-w-[260px] truncate" data-no-translate>
              {f}
            </span>
            <button type="button" aria-label="Remove folder" className="rounded p-0.5 hover-app" onClick={() => void setFolders(index.folders.filter((x) => x !== f))}>
              <X size={11} />
            </button>
          </span>
        ))}
        <Button
          size="sm"
          disabled={!isDesktop}
          onClick={async () => {
            const f = await pickFolder();
            if (f && index && !index.folders.includes(f)) await setFolders([...index.folders, f]);
          }}
          data-testid="foldersearch-add"
        >
          <FolderPlus size={13} /> Add folder…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!index?.folders.length}
          onClick={() =>
            void import('@/actions/folderSearch')
              .then((m) => m.updateSearchIndex())
              .then((r) => r && setIndex({ ...r }))
          }
          data-testid="foldersearch-update"
        >
          <RefreshCw size={13} /> Update
        </Button>
        <span className="ml-auto text-[11px] text-muted" data-testid="foldersearch-status">
          {index?.folders.length ? (
            <>
              <span>{`${files.length} PDF${files.length === 1 ? '' : 's'} indexed`}</span>
              {noText ? <span>{`, ${noText} without text`}</span> : null}
              {index.updated ? <span data-no-translate>{` · ${new Date(index.updated).toLocaleString()}`}</span> : null}
            </>
          ) : (
            'Add a folder to search in.'
          )}
        </span>
      </div>
      <Input autoFocus value={query} placeholder='Words to find, or "an exact phrase"' onChange={(e) => setQuery(e.target.value)} data-testid="foldersearch-query" />
      <div className="mt-3 max-h-[420px] overflow-auto" data-testid="foldersearch-results">
        {debounced.trim() && !results.length ? <p className="py-6 text-center text-xs text-muted">Nothing found.</p> : null}
        {results.map((r) => (
          <div key={r.path} className="mb-2 rounded-md border border-app p-2" data-testid="foldersearch-result">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <FileText size={13} className="shrink-0 text-brand-600" />
              <span className="font-medium" data-no-translate>
                {r.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted" data-no-translate>
                {r.path}
              </span>
            </div>
            {r.hits.slice(0, 4).map((h) => (
              <button
                key={h.page}
                type="button"
                className="block w-full rounded px-2 py-0.5 text-left text-[11.5px] hover-app"
                onClick={() => {
                  close();
                  void import('@/actions/folderSearch').then((m) => m.openSearchResult(r.path, h.page));
                }}
                data-testid="foldersearch-hit"
              >
                <span className="mr-2 text-muted">{`p. ${h.page}`}</span>
                <span data-no-translate>
                  {h.snippet[0]}
                  <mark className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-700/60">{h.snippet[1]}</mark>
                  {h.snippet[2]}
                </span>
              </button>
            ))}
            {r.hits.length > 4 ? <div className="px-2 text-[11px] text-muted">{`and ${r.hits.length - 4} more pages`}</div> : null}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
