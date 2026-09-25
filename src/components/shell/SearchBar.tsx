import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { searchDocument } from '@/lib/search';
import { Button, Input } from '@/components/ui/primitives';

export function SearchBar() {
  const search = usePDFStore((s) => s.search);
  const setSearch = usePDFStore((s) => s.setSearch);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = useRef({ cancelled: false });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (search.open) inputRef.current?.select();
  }, [search.open]);

  const run = async (query: string) => {
    token.current.cancelled = true;
    const mine = { cancelled: false };
    token.current = mine;
    if (!query.trim()) {
      setSearch({ hits: [], active: 0, running: false });
      return;
    }
    setSearch({ running: true });
    const hits = await searchDocument(usePDFStore.getState().pages, query, mine);
    if (mine.cancelled) return;
    setSearch({ hits, active: 0, running: false });
    if (hits[0]) reveal(0, hits);
  };

  const reveal = (index: number, hits = usePDFStore.getState().search.hits) => {
    const h = hits[index];
    if (!h) return;
    setSearch({ active: index });
    usePDFStore.getState().scrollToPage(h.pageId, h.rects[0]?.y);
  };

  const step = (d: number) => {
    const n = search.hits.length;
    if (n) reveal((search.active + d + n) % n);
  };

  if (!search.open) return null;
  return (
    <div className="absolute right-5 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-app bg-panel p-1.5 shadow-xl" data-testid="search-bar">
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
  );
}
