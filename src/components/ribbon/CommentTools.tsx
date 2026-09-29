/** Ribbon menus of the Comment tab: stamps, and comment import / export / summary / compare. */
import { ChevronDown, FileInput, FileOutput, GitCompare, ImageUp, ListChecks, MessagesSquare, Stamp } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '@/components/ui/primitives';
import { STAMP_PRESETS, stampDate, type StampTemplate } from '@/lib/objectFactory';
import { pickImagesAsDataUrls } from '@/actions/convert';
import { compareWithFile, exportComments, importComments, summarizeCommentsAction } from '@/actions/pageTools';
import { getAuthor } from '@/lib/author';
import { translate } from '@/lib/i18n';
import { I } from './ReaderTabs';
import { cn } from '@/lib/cn';

function MenuButton({ icon, label, active, disabled, testId, tip }: { icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean; testId?: string; tip: string }) {
  return (
    <DropdownTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          title={tip}
          disabled={disabled}
          className={cn(
            'flex h-[60px] min-w-[54px] flex-col items-center justify-center gap-1 rounded-md px-1.5 text-[11px] leading-tight disabled:opacity-40',
            active ? 'bg-brand-100 text-brand-800 ring-1 ring-brand-300 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700' : 'hover-app',
          )}
        >
          <span className="text-brand-600 dark:text-brand-400">{icon}</span>
          <span className="flex items-center gap-0.5">
            {label}
            <ChevronDown size={10} />
          </span>
        </button>
    </DropdownTrigger>
  );
}

function choose(t: StampTemplate) {
  const s = usePDFStore.getState();
  s.setPendingStamp(t);
  s.toast('Click on the page where the stamp should go.', 'info');
}

export function StampMenu() {
  const active = usePDFStore((s) => s.tool === 'stamp');
  const enabled = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  const author = getAuthor();
  return (
    <DropdownMenu>
      <MenuButton icon={<Stamp size={I} />} label="Stamp" active={active} disabled={!enabled} testId="btn-stamp" tip="Rubber stamps: Approved, Draft, Confidential… or your own picture" />
      <DropdownContent>
        {STAMP_PRESETS.map((p) => (
          <DropdownItem key={p.name} onSelect={() => choose({ ...p, label: translate(p.label), dynamic: false })}>
            <span className="rounded border-2 px-1.5 text-[11px] font-bold" style={{ color: p.color, borderColor: p.color }}>
              {p.label}
            </span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        {STAMP_PRESETS.slice(0, 3).map((p) => (
          <DropdownItem key={`dyn-${p.name}`} onSelect={() => choose({ ...p, label: translate(p.label), dynamic: true })}>
            <span className="flex flex-col rounded border-2 px-1.5 text-center leading-tight" style={{ color: p.color, borderColor: p.color }}>
              <span className="text-[11px] font-bold">{p.label}</span>
              <span className="text-[9px]" data-no-translate>
                {author ? `${author}, ` : ''}
                {stampDate()}
              </span>
            </span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem
          icon={<ImageUp size={14} />}
          onSelect={() =>
            void (async () => {
              const [img] = await pickImagesAsDataUrls();
              if (img) choose({ name: 'Image', label: '', color: '#000000', dynamic: false, src: img.src, width: img.width, height: img.height });
            })()
          }
        >
          Picture stamp…
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

export function CommentFileMenu() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const editable = usePDFStore((s) => s.pages.length > 0 && !s.readOnlyReason);
  return (
    <DropdownMenu>
      <MenuButton icon={<MessagesSquare size={I} />} label="Share" disabled={!hasDoc} testId="btn-comments-io" tip="Import, export and summarise comments; compare two versions" />
      <DropdownContent>
        <DropdownItem icon={<FileInput size={14} />} disabled={!editable} onSelect={() => void importComments()}>
          Import comments (XFDF, FDF)…
        </DropdownItem>
        <DropdownItem icon={<FileOutput size={14} />} onSelect={() => void exportComments('xfdf')}>
          Export comments as XFDF…
        </DropdownItem>
        <DropdownItem icon={<FileOutput size={14} />} onSelect={() => void exportComments('fdf')}>
          Export comments as FDF…
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem icon={<ListChecks size={14} />} onSelect={() => void summarizeCommentsAction()}>
          Summarise comments (PDF)
        </DropdownItem>
        <DropdownItem icon={<GitCompare size={14} />} onSelect={() => void compareWithFile()}>
          Compare with another version…
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}
