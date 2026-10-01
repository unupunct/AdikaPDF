import { Info, Languages, Moon, PanelLeft, PanelRight, Search, Settings2, Sun } from 'lucide-react';
import { QuickAccessBar } from './CustomizeModal';
import { usePalette } from './CommandPalette';
import { LANGS, useLang } from '@/lib/i18n';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@/components/ui/primitives';
import { AdikaLogo } from './AdikaLogo';

export function TopBar() {
  const fileName = usePDFStore((s) => s.fileName);
  const dirty = usePDFStore((s) => s.dirty);
  const readOnly = usePDFStore((s) => s.readOnlyReason);
  const theme = usePDFStore((s) => s.theme);
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const s = usePDFStore.getState();

  useDocumentTitle(fileName, dirty);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-app bg-panel px-3">
      <AdikaLogo className="h-7" />
      <QuickAccessBar />
      <div className="mx-2 h-5 w-px bg-[var(--border)]" />
      <div className="min-w-0 flex-1 truncate text-[13px]" data-testid="doc-title">
        {fileName ? (
          <>
            <span className="font-medium">{fileName}</span>
            {dirty ? <span className="ml-1.5 text-brand-600" title="Unsaved changes">●</span> : null}
            {readOnly ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Read-only</span> : null}
          </>
        ) : (
          <span className="text-muted">No document open</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="palette-open"
          onClick={() => usePalette.setState({ open: true })}
          className="mr-2 flex h-8 w-56 items-center gap-2 rounded-md border border-app bg-panel-2 px-2.5 text-[12px] text-muted hover-app"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search tools…</span>
          <kbd className="text-[10px]">Ctrl+K</kbd>
        </button>
        <Tooltip content="Toggle page thumbnails">
          <Button variant="ghost" size="icon" aria-label="Toggle thumbnails" disabled={!hasDoc} onClick={s.toggleSidebar}>
            <PanelLeft size={17} />
          </Button>
        </Tooltip>
        <Tooltip content="Toggle properties panel">
          <Button variant="ghost" size="icon" aria-label="Toggle properties" disabled={!hasDoc} onClick={s.toggleInspector}>
            <PanelRight size={17} />
          </Button>
        </Tooltip>
        <Tooltip content={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
          <Button variant="ghost" size="icon" data-testid="theme-toggle" aria-label="Toggle theme" onClick={() => s.setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
        </Tooltip>
        <LanguageButton />
        <Tooltip content="Customize the Quick Access toolbar and keyboard shortcuts">
          <Button variant="ghost" size="icon" aria-label="Customize" data-testid="customize-open" onClick={() => s.openModal('customize')}>
            <Settings2 size={17} />
          </Button>
        </Tooltip>
        <Tooltip content="About Adika PDF Editor">
          <Button variant="ghost" size="icon" aria-label="About" onClick={() => s.openModal('about')}>
            <Info size={17} />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function LanguageButton() {
  const lang = useLang((s) => s.lang);
  return (
    <DropdownMenu>
      <Tooltip content="Interface language">
        <DropdownTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-[11.5px] font-semibold" aria-label="Language" data-testid="lang-toggle">
            <Languages size={15} />
            <span data-no-translate>{lang.toUpperCase()}</span>
          </Button>
        </DropdownTrigger>
      </Tooltip>
      <DropdownContent align="end">
        {LANGS.map((l) => (
          <DropdownItem key={l.id} onSelect={() => void useLang.getState().setLang(l.id)}>
            <span data-no-translate data-testid={`lang-${l.id}`} className={lang === l.id ? 'font-semibold' : undefined}>
              {l.label}
            </span>
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

function useDocumentTitle(fileName: string | null, dirty: boolean) {
  const title = fileName ? `${dirty ? '• ' : ''}${fileName} — Adika PDF Editor` : 'Adika PDF Editor';
  if (typeof document !== 'undefined' && document.title !== title) document.title = title;
}
