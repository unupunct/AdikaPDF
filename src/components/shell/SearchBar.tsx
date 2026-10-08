import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, List, Loader2, Replace, WholeWord, X } from 'lucide-react';
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { searchDocument } from '@/lib/search';
import { useTabs } from '@/store/tabs';
import { Button, Input } from '@/components/ui/primitives';

function Toggle({ label, active, onClick, children, testId }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md ${active ? 'bg-brand-600 text-white' : 'hover-app'}`}
    >
      {children}
    </button>
  );
}

export function SearchBar() {
  const search = usePDFStore((s) => s.search);
  const setSearch = usePDFStore((s) => s.setSearch);
  const options = usePDFStore((s) => s.searchOptions);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = useRef({ cancelled: false });
  const timer = useRef<number | undefined>(undefined);
  const showReplace = usePDFStore((s) => s.search.replace ?? false);
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState(false);
  const readOnly = usePDFStore((s) => !!blockedReason(s, 'content'));

  const doReplaceAll = async () => {
    const q = usePDFStore.getState().search.query;
    if (!q.trim() || replacing) return;
    setReplacing(true);
    try {
      const { replaceAll } = await import('@/actions/findReplace');
      const r = await replaceAll(q, replacement, usePDFStore.getState().searchOptions);
      if (r.replaced) setSearch({ hits: [], active: 0 });
    } finally {
      setReplacing(false);
    }
  };

  useEffect(() => {
    if (search.open) inputRef.current?.select();
  }, [search.open]);

  // Another tab: a search still running belongs to the previous document.
  const activeTab = useTabs((t) => t.activeId);
  useEffect(() => {
    token.current.cancelled = true;
    window.clearTimeout(timer.current);
    if (usePDFStore.getState().search.running) setSearch({ running: false });
  }, [activeTab, setSearch]);

  const run = async (query: string) => {
    token.current.cancelled = true;
    const mine = { cancelled: false };
    token.current = mine;
    if (!query.trim()) {
      setSearch({ hits: [], active: 0, running: false });
      return;
    }
    const tab = useTabs.getState().activeId;
    setSearch({ running: true });
    let hits: Awaited<ReturnType<typeof searchDocument>>;
    try {
      hits = await searchDocument(usePDFStore.getState().pages, query, mine, usePDFStore.getState().searchOptions);
    } catch (e) {
      if (!mine.cancelled && useTabs.getState().activeId === tab) {
        setSearch({ hits: [], active: 0, running: false });
        usePDFStore.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
      return;
    }
    // Never write one document's hits into another tab's search.
    if (mine.cancelled || useTabs.getState().activeId !== tab) return;
    setSearch({ hits, active: 0, running: false });
    if (hits[0]) reveal(0, hits);
  };

  const reveal = (index: number, hits = usePDFStore.getState().search.hits) => {
    const h = hits[index];
    if (!h) return;
    setSearch({ active: index });
    usePDFStore.getState().navigateTo(h.pageId, h.rects[0]?.y);
  };

  const step = (d: number) => {
    const n = search.hits.length;
    if (n) reveal((search.active + d + n) % n);
  };

  if (!search.open) return null;
  return (
    <div className="absolute right-5 top-3 z-20 flex flex-col gap-1.5 rounded-lg border border-app bg-panel p-1.5 shadow-xl" data-testid="search-bar">
      <div className="flex items-center gap-1.5">
      <Toggle label="Replace (Ctrl+H)" active={showReplace} testId="search-replace-toggle" onClick={() => setSearch({ replace: !showReplace })}>
        <Replace size={15} />
      </Toggle>
      <Input
        ref={inputRef}
        data-testid="search-input"
        aria-label="Search text"
        placeholder="Find in document…"
        defaultValue={search.query}
        className="w-60"
        onChange={(e) => {
          setSearch({ query: e.target.value });
          const q = e.target.value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void run(q), 250);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
          if (e.key === 'Escape') setSearch({ open: false, hits: [] });
        }}
      />
      <span className="w-16 text-center text-xs tabular-nums text-muted" data-testid="search-count">
        {search.running ? <Loader2 size={13} className="mx-auto animate-spin" /> : search.hits.length ? `${search.active + 1} / ${search.hits.length}` : search.query ? '0 found' : ''}
      </span>
      <Toggle label="Match case" active={options.caseSensitive} testId="search-case" onClick={() => { usePDFStore.getState().setSearchOptions({ caseSensitive: !options.caseSensitive }); void run(search.query); }}>
        <CaseSensitive size={15} />
      </Toggle>
      <Toggle label="Whole words only" active={options.wholeWord} testId="search-word" onClick={() => { usePDFStore.getState().setSearchOptions({ wholeWord: !options.wholeWord }); void run(search.query); }}>
        <WholeWord size={15} />
      </Toggle>
      <Toggle label="Show all results in the sidebar" active={false} testId="search-list" onClick={() => usePDFStore.setState({ sidebarOpen: true, sidebarTab: 'search' })}>
        <List size={15} />
      </Toggle>
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous match" onClick={() => step(-1)}>
        <ChevronUp size={15} />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Next match" onClick={() => step(1)}>
        <ChevronDown size={15} />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close search" onClick={() => setSearch({ open: false, hits: [] })}>
        <X size={15} />
      </Button>
      </div>
      {showReplace ? (
        <div className="flex items-center gap-1.5 pl-[34px]">
          <Input
            data-testid="replace-input"
            aria-label="Replace with"
            placeholder="Replace with…"
            value={replacement}
            className="w-60"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void doReplaceAll();
              if (e.key === 'Escape') setSearch({ open: false, hits: [] });
            }}
          />
          <Button size="sm" variant="primary" data-testid="replace-all" disabled={readOnly || replacing || !search.query.trim()} onClick={() => void doReplaceAll()} title="Replace every match; the old letters are deleted from the page when you save">
            {replacing ? <Loader2 size={13} className="animate-spin" /> : null} Replace all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
