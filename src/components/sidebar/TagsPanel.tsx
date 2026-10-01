/**
 * Tags panel (Acrobat's Tags / Order panes): the tag tree of a tagged PDF.
 * Select a tag to change its type, alternate text or language, move it in
 * the reading order, unwrap or delete it. Every change rewrites the
 * document (undoable).
 */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerLeftUp, FileText, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import type { TagNode } from '@/lib/pdf/structTree';

const TAG_TYPES = ['Document', 'Part', 'Sect', 'Div', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot', 'Figure', 'Caption', 'Formula', 'Form', 'Link', 'Annot', 'Span', 'Quote', 'BlockQuote', 'Note', 'Reference', 'TOC', 'TOCI', 'Index', 'Artifact'];

export function TagsPanel() {
  const sourceId = usePDFStore((s) => s.pages.find((p) => p.kind === 'source')?.sourceId ?? null);
  const bytes = usePDFStore((s) => (sourceId ? s.sources[sourceId]?.bytes : undefined));
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);
  const [tree, setTree] = useState<TagNode[] | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    if (!bytes) {
      setTree(null);
      return;
    }
    void (async () => {
      const [{ PDFDocument }, { readTagTree }] = await Promise.all([import('pdf-lib'), import('@/lib/pdf/structTree')]);
      try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        const t = readTagTree(doc);
        if (alive) {
          setTree(t);
          // The first two levels start open.
          if (t) setOpen((o) => (o.size ? o : new Set(t.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]))));
        }
      } catch {
        if (alive) setTree(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bytes]);

  const find = (nodes: TagNode[] | null | undefined, id: string | null): TagNode | null => {
    for (const n of nodes ?? []) {
      if (n.id === id) return n;
      const c = find(n.children, id);
      if (c) return c;
    }
    return null;
  };
  const sel = find(tree, selected);
  const act = async (fn: (m: typeof import('@/actions/tags'), sid: string) => Promise<void>) => {
    if (!sourceId) return;
    await fn(await import('@/actions/tags'), sourceId);
  };

  const row = (n: TagNode, depth: number) => {
    const isOpen = open.has(n.id);
    return (
      <div key={n.id}>
        <div
          data-testid="tag-row"
          data-tag={n.type}
          onClick={() => setSelected(n.id)}
          className={cn('flex cursor-default items-center gap-1 rounded px-1 py-0.5 text-[12px]', selected === n.id ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover-app')}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          {n.children.length ? (
            <button
              type="button"
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => {
                  const next = new Set(o);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                });
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted"
            >
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="shrink-0 font-mono text-[11px] text-brand-700 dark:text-brand-300" data-no-translate>
            {`<${n.type}>`}
          </span>
          <span className="min-w-0 truncate text-muted" data-no-translate>
            {n.alt || n.title}
          </span>
        </div>
        {isOpen ? n.children.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-center border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Tags</div>
      <div className="flex-1 overflow-auto p-1.5" data-testid="tags-panel">
        {tree === undefined ? <p className="p-2 text-xs text-muted">Reading the tags…</p> : null}
        {tree === null ? <p className="p-2 text-xs text-muted">This document has no tags. Security → Accessibility makes it accessible (tagged).</p> : null}
        {tree?.map((n) => row(n, 0))}
      </div>
      {sel && !readOnly ? (
        <div className="shrink-0 border-t border-app p-2 text-[12px]" data-testid="tag-details">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[11px] text-muted">Type</span>
            <Select value={sel.type} ariaLabel="Tag type" options={[...new Set([sel.type, ...TAG_TYPES])].map((t) => ({ value: t, label: t }))} onChange={(type) => void act((m, sid) => m.updateTag(sid, sel.id, { type }))} />
          </div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[11px] text-muted">Alt text</span>
            <AltInput key={sel.id} value={sel.alt} onCommit={(alt) => void act((m, sid) => m.updateTag(sid, sel.id, { alt }))} />
          </div>
          <div className="flex flex-wrap gap-1">
            <TagBtn title="Earlier in the reading order" onClick={() => void act((m, sid) => m.moveTagIn(sid, sel.id, -1))} testId="tag-up">
              <ArrowUp size={12} />
            </TagBtn>
            <TagBtn title="Later in the reading order" onClick={() => void act((m, sid) => m.moveTagIn(sid, sel.id, 1))} testId="tag-down">
              <ArrowDown size={12} />
            </TagBtn>
            <TagBtn title="Unwrap: the tags inside take its place" onClick={() => void act((m, sid) => m.unwrapTagIn(sid, sel.id)).then(() => setSelected(null))} testId="tag-unwrap">
              <CornerLeftUp size={12} />
            </TagBtn>
            <TagBtn title="Delete the tag and the tags inside it (the page content stays)" onClick={() => void act((m, sid) => m.deleteTagIn(sid, sel.id)).then(() => setSelected(null))} testId="tag-delete">
              <Trash2 size={12} />
            </TagBtn>
            {sel.page !== null ? (
              <TagBtn
                title="Show its page"
                onClick={() => {
                  const st = usePDFStore.getState();
                  const p = st.pages.find((x) => x.sourceId === sourceId && x.sourceIndex === sel.page);
                  if (p) st.navigateTo(p.id);
                }}
                testId="tag-page"
              >
                <FileText size={12} />
              </TagBtn>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function AltInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  return <Input value={v} aria-label="Alternate text" data-testid="tag-alt" data-no-translate onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

function TagBtn({ children, title, onClick, testId }: { children: React.ReactNode; title: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} data-testid={testId} className="flex h-6 w-7 items-center justify-center rounded border border-app hover-app">
      {children}
    </button>
  );
}
