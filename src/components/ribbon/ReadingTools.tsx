/** View tab: Read aloud controls and the Snapshot / Magnifier reading tools. */
import { AudioLines, Camera, ChevronDown, CircleStop, ImageDown, ListEnd, Pause, Play, ScanSearch, Volume2, ZoomIn } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from '@/components/ui/primitives';
import { readCurrentPage, readToEnd, saveLastSnapshot, stopReading, togglePauseReading, useMagnifier, useSnapshot } from '@/actions/readingAids';
import { useReadAloud } from '@/lib/readAloud';
import { Big, Group, I, i, Small, Stack, ToolBtn } from './ReaderTabs';

const RATES = [0.75, 1, 1.25, 1.5, 2];

function VoiceMenu() {
  const voices = useReadAloud((s) => s.voices);
  const voiceUri = useReadAloud((s) => s.voiceUri);
  const rate = useReadAloud((s) => s.rate);
  const current = voices.find((v) => v.uri === voiceUri);
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <button type="button" data-testid="btn-voice" title="Voice and speed" className="flex h-[19px] items-center gap-1.5 rounded px-1.5 text-[11.5px] hover-app">
          <AudioLines size={i} className="text-brand-600 dark:text-brand-400" />
          <span className="max-w-[92px] truncate">{current ? current.name.replace(/^Microsoft /, '').split(' - ')[0] : 'Voice'}</span>
          <ChevronDown size={10} />
        </button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem onSelect={() => useReadAloud.getState().setVoice(null)}>{voiceUri ? 'Automatic (by language)' : '✓ Automatic (by language)'}</DropdownItem>
        {voices.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted">No voices installed. Add them in Windows Settings → Time & language → Speech.</div> : null}
        {voices.map((v) => (
          <DropdownItem key={v.uri} onSelect={() => useReadAloud.getState().setVoice(v.uri)}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px]">
                {v.uri === voiceUri ? '✓ ' : ''}
                {v.name}
              </span>
              <span className="text-[10.5px] opacity-70">{v.lang}</span>
            </span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        {RATES.map((r) => (
          <DropdownItem key={r} onSelect={() => useReadAloud.getState().setRate(r)}>
            {r === rate ? '✓ ' : ''}Speed {r}×
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

export function ReadAloudGroup() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const status = useReadAloud((s) => s.status);
  return (
    <Group label="Read aloud">
      <Big
        icon={status === 'speaking' ? <Pause size={I} /> : status === 'paused' ? <Play size={I} /> : <Volume2 size={I} />}
        label={status === 'speaking' ? 'Pause' : status === 'paused' ? 'Resume' : 'Read page'}
        active={status !== 'idle'}
        disabled={!hasDoc}
        onClick={() => (status === 'idle' ? readCurrentPage() : togglePauseReading())}
        tip="Read the current page aloud (Ctrl+Shift+V); pause / resume (Ctrl+Shift+C)"
        testId="btn-read-page"
      />
      <Stack>
        <Small icon={<ListEnd size={i} />} label="Read to end" disabled={!hasDoc} onClick={readToEnd} tip="Read from this page to the end (Ctrl+Shift+B)" testId="btn-read-end" />
        <Small icon={<CircleStop size={i} />} label="Stop" disabled={status === 'idle'} onClick={stopReading} tip="Stop reading (Ctrl+Shift+E)" testId="btn-read-stop" />
        <VoiceMenu />
      </Stack>
    </Group>
  );
}

export function ReadingToolsGroup() {
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  const hasSnapshot = useSnapshot((s) => s.last !== null);
  const magnifier = useMagnifier((s) => s.on);
  const factor = useMagnifier((s) => s.factor);
  return (
    <Group label="Tools">
      <ToolBtn tool="snapshot" icon={<Camera size={I} />} label="Snapshot" tip="Drag a box to copy that area as a picture" />
      <Big
        icon={<ScanSearch size={I} />}
        label="Magnifier"
        active={magnifier}
        disabled={!hasDoc}
        onClick={() => {
          const s = usePDFStore.getState();
          if (!magnifier && s.viewRotation !== 0) {
            s.toast('Reset the view rotation to use the magnifier.', 'info');
            return;
          }
          useMagnifier.getState().toggle();
        }}
        tip="A lens that follows the mouse (Esc to close)"
        testId="btn-magnifier"
      />
      <Stack>
        <Small icon={<ImageDown size={i} />} label="Save snapshot" disabled={!hasSnapshot} onClick={() => void saveLastSnapshot()} tip="Save the last snapshot as a PNG file" testId="btn-save-snapshot" />
        <Small
          icon={<ZoomIn size={i} />}
          label={`Lens ${factor}×`}
          disabled={!hasDoc}
          onClick={() => useMagnifier.getState().setFactor(factor === 4 ? 2 : ((factor + 1) as 3 | 4))}
          tip="Magnifier strength: 2×, 3× or 4× (click to change)"
          testId="btn-lens-factor"
        />
      </Stack>
    </Group>
  );
}
