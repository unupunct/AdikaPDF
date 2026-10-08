/** A signed update is available: what is new, "Install and restart" (with download progress) or "Later". */
import { ArrowUpCircle } from 'lucide-react';
import { Button, Callout, Dialog, Progress } from '@/components/ui/primitives';
import { APP_VERSION, installUpdate, useUpdates } from '@/lib/updates';
import { openExternal } from '@/lib/platform';

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export function UpdateModal() {
  const { promptOpen, setPrompt, latest, installable, phase, progress, installError } = useUpdates();
  if (!latest || !installable) return null;
  const busy = phase !== 'idle';
  return (
    <Dialog
      open={promptOpen}
      onOpenChange={(o) => setPrompt(o)}
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle size={16} className="text-brand-600" /> Update available
        </span>
      }
      description={`Adika PDF Editor ${latest.version} is available (you have ${APP_VERSION}).`}
      testId="update-modal"
      footer={
        <>
          <Button onClick={() => setPrompt(false)} disabled={busy} data-testid="update-later">
            Later
          </Button>
          <Button variant="primary" onClick={() => void installUpdate()} disabled={busy} data-testid="update-install">
            Install and restart
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[12px]">
        {latest.notes.trim() ? (
          <div className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-app px-3 py-2 text-[11.5px]" data-no-translate data-testid="update-notes">
            {latest.notes.trim()}
          </div>
        ) : null}
        <p className="text-muted">The installer is downloaded from GitHub and checked against Adika's signing key before it runs. Adika closes while it installs and opens again afterwards.</p>
        {busy ? (
          <div className="space-y-1" data-testid="update-progress">
            <Progress value={phase === 'downloading' && progress.total ? progress.done / progress.total : null} label="Download progress" />
            <span className="block text-muted">
              {phase === 'installing'
                ? 'Starting the installer…'
                : progress.total
                  ? `Downloading… ${mb(progress.done)} of ${mb(progress.total)} MB`
                  : `Downloading… ${mb(progress.done)} MB`}
            </span>
          </div>
        ) : null}
        {installError ? (
          <Callout kind="error">
            <span data-testid="update-error">{installError}</span>{' '}
            <button type="button" className="underline" onClick={() => void openExternal(latest.url)}>
              Open the release page
            </button>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
