/** Ribbon menus of the Comment tab: stamps, and comment import / export / summary / compare. */
import { FileInput, FileOutput, GitCompare, ImageUp, ListChecks, MessagesSquare, Stamp } from 'lucide-react';
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator } from '@/components/ui/primitives';
import { STAMP_PRESETS, stampDate, type StampTemplate } from '@/lib/objectFactory';
import { pickImagesAsDataUrls } from '@/actions/convert';
import { compareVisually, compareWithFile, exportComments, importComments, summarizeCommentsAction } from '@/actions/pageTools';
import { getAuthor } from '@/lib/author';
import { translate } from '@/lib/i18n';
import { I, MenuButton } from './parts';

function choose(t: StampTemplate) {
  const s = usePDFStore.getState();
  s.setPendingStamp(t);
  s.toast('Click on the page where the stamp should go.', 'info');
}

export function StampMenu() {
  const active = usePDFStore((s) => s.tool === 'stamp');
  const enabled = usePDFStore((s) => s.pages.length > 0 && !blockedReason(s, 'comments'));
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
  const editable = usePDFStore((s) => s.pages.length > 0 && !blockedReason(s, 'comments'));
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
        <DropdownItem icon={<GitCompare size={14} />} onSelect={() => void compareWithFile(true)}>
          Compare with a list of changes (redline)…
        </DropdownItem>
        <DropdownItem icon={<GitCompare size={14} />} onSelect={() => void compareVisually()}>
          Compare visually (overlay)…
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}
