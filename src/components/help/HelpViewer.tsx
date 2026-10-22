/**
 * Help: the bundled user guide (docs/guide) in a dialog with a table of
 * contents, search across pages, back / forward and links between pages.
 * Works offline; the guide follows the interface language (Romanian or
 * English). The page text is already translated: the DOM translator skips it.
 */
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, Search, Sparkles } from 'lucide-react';
import { Button, Dialog, Input } from '@/components/ui/primitives';
import { useLang } from '@/lib/i18n';
import { openExternal } from '@/lib/platform';
import { buildGuide, groupOf, PAGE_GROUPS, resolveLink, searchGuide, type Guide } from '@/lib/help/guide';
import { renderGuideHtml } from '@/lib/help/render';
import { GUIDE_FILES, GUIDE_IMAGES } from '@/lib/help/bundle';
import { useHelp } from '@/store/help';
import { useUiMode } from '@/store/uiMode';
import { cn } from '@/lib/cn';

export function HelpViewer() {
  const open = useHelp((s) => s.open);
  const lang = useLang((s) => s.lang);
  const guide = useMemo(() => buildGuide(GUIDE_FILES, lang), [lang]);
  if (!open) return null;
  return <HelpDialog guide={guide} />;
}

function HelpDialog({ guide }: { guide: Guide }) {
  const { page: pageId, anchor, nonce, query, back, forward, close, go, goBack, goForward, setQuery } = useHelp();
  const page = guide.byId.get(pageId) ?? guide.byId.get('index') ?? guide.pages[0];
  const html = useMemo(() => (page ? renderGuideHtml(page.markdown, GUIDE_IMAGES) : ''), [page]);
  const hits = useMemo(() => searchGuide(guide, query), [guide, query]);
  const article = useRef<HTMLElement>(null);
  const firstNonce = useRef(nonce);
  // Closing returns the focus to where it was (a field of the dialog the help was opened from).
  const returnTo = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(
    () => () => {
      const el = returnTo.current;
      setTimeout(() => {
        if (el && el.isConnected && el !== document.body) el.focus();
      }, 20);
    },
    [],
  );

  // Scroll to the heading (or the top) after every navigation; keyboard users land on the new text.
  useEffect(() => {
    const el = article.current;
    if (!el) return;
    const target = anchor ? [...el.querySelectorAll<HTMLElement>('[id]')].find((h) => h.id === anchor) : null;
    const scroller = el.parentElement;
    if (target) target.scrollIntoView?.({ block: 'start' });
    else if (scroller) scroller.scrollTop = 0;
    if (nonce !== firstNonce.current) (target ?? el.querySelector<HTMLElement>('h1'))?.focus({ preventScroll: true });
  }, [page?.id, anchor, nonce, html]);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !page) return;
    e.preventDefault();
    const t = resolveLink(a.getAttribute('href') ?? '', page.id, guide.byId);
    if (t.kind === 'page') go(t.page, t.anchor);
    else if (t.kind === 'external') void openExternal(t.url);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title="Help" width={1040} testId="help-viewer">
      <div className="grid h-[min(72vh,760px)] grid-cols-[230px_1fr] gap-4">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2 top-2 text-muted" aria-hidden />
            <Input
              type="search"
              className="pl-7"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the help…"
              aria-label="Search the help"
              data-autofocus
              data-testid="help-search"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {query.trim() ? (
              hits.length ? (
                <ul className="flex flex-col gap-1" data-testid="help-results" aria-label="Search results">
                  {hits.map((h, i) => (
                    <li key={`${h.page}-${h.anchor}-${i}`}>
                      <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover-app" onClick={() => go(h.page, h.anchor)} data-testid="help-result">
                        <span className="block text-[12px] font-medium" data-no-translate>
                          {h.heading ? `${h.title} › ${h.heading}` : h.title}
                        </span>
                        <span className="block text-[11px] text-muted" data-no-translate>
                          {h.snippet}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 text-xs text-muted" role="status">
                  No results.
                </p>
              )
            ) : (
              <nav aria-label="Help pages" data-testid="help-toc">
                {PAGE_GROUPS.map((g) => {
                  const pages = guide.pages.filter((p) => groupOf(p.id) === g.id);
                  if (!pages.length) return null;
                  return (
                    <div key={g.id} className="mb-2">
                      <div className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</div>
                      <ul>
                        {pages.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              aria-current={p.id === page?.id ? 'page' : undefined}
                              className={cn('w-full rounded-md px-2 py-1 text-left text-[12.5px]', p.id === page?.id ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200' : 'hover-app')}
                              onClick={() => go(p.id)}
                              data-testid={`help-page-${p.id}`}
                            >
                              <span data-no-translate>{p.title}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </nav>
            )}
          </div>
          {guide.fallback ? <p className="px-2 text-[11px] text-muted">The guide is available in English and Romanian.</p> : null}
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            onClick={() => {
              close();
              useUiMode.getState().openWelcome();
            }}
            data-testid="help-welcome"
          >
            <Sparkles size={14} /> Welcome screen
          </Button>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-2 flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Back" disabled={!back.length} onClick={goBack} data-testid="help-back">
              <ArrowLeft size={16} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Forward" disabled={!forward.length} onClick={goForward} data-testid="help-forward">
              <ArrowRight size={16} />
            </Button>
            <span className="ml-2 truncate text-xs text-muted" data-no-translate>
              {page?.title}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-app bg-panel px-6 py-4" tabIndex={0} role="region" aria-label="Help page">
            <article
              ref={article}
              lang={page?.lang}
              data-no-translate
              data-testid="help-article"
              data-page={page?.id}
              className="help-content"
              onClick={onClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
