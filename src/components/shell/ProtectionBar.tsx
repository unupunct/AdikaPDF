/** The notice under the ribbon for a password-protected document: what its owner allows, and unlocking it. */
import { useEffect, useState } from 'react';
import { Lock, LockOpen, ShieldAlert, X } from 'lucide-react';
import { blockedReason, usePDFStore, type Protection } from '@/store/usePDFStore';
import { enterOwnerPassword, setKeepProtection } from '@/actions/protection';
import { Button } from '@/components/ui/primitives';

function allowedText(p: Protection): string {
  const r = p.permissions;
  if (r.modify && r.annotate) return 'You can edit it, add comments and fill in fields.';
  if (r.modify) return 'You can edit its content and fill in fields.';
  if (r.annotate) return 'You can add comments and fill in fields.';
  if (r.fillForms) return 'You can fill in fields.';
  return 'You can read it, but not change it.';
}

export function ProtectionBar() {
  const p = usePDFStore((s) => s.protection);
  const [hidden, setHidden] = useState<Protection | null>(null);
  const noCopy = usePDFStore((s) => !!blockedReason(s, 'copy'));

  // Copying is not allowed: text selected on the pages is not copied (typing in fields still is).
  useEffect(() => {
    if (!noCopy) return;
    const onCopy = (e: ClipboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      const s = usePDFStore.getState();
      s.toast(blockedReason(s, 'copy') ?? '', 'info');
    };
    document.addEventListener('copy', onCopy, true);
    return () => document.removeEventListener('copy', onCopy, true);
  }, [noCopy]);

  if (!p || hidden === p) return null;
  const restricted = !p.full;
  return (
    <div
      data-testid="protection-bar"
      className={
        restricted
          ? 'flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100'
          : 'flex shrink-0 items-center gap-2 border-b border-app bg-panel-2 px-3 py-1 text-[12px]'
      }
    >
      {restricted ? <ShieldAlert size={15} className="shrink-0" /> : p.keep ? <Lock size={14} className="shrink-0 text-brand-600" /> : <LockOpen size={14} className="shrink-0 text-muted" />}
      <div className="min-w-0 flex-1 truncate">
        {restricted ? (
          <>
            <span className="font-medium">The owner of this PDF restricts editing.</span> <span>{allowedText(p)}</span>
            {!p.permissions.print ? <> <span>Printing is not allowed.</span></> : null}
            {!p.permissions.copy ? <> <span>Copying text is not allowed.</span></> : null}
          </>
        ) : p.keep ? (
          <span>This PDF is password-protected: saving keeps the same passwords and permissions.</span>
        ) : (
          <span>The password protection is removed when you save.</span>
        )}
      </div>
      {restricted ? (
        <Button size="sm" onClick={() => void enterOwnerPassword()} data-testid="protection-unlock">
          Enter owner password…
        </Button>
      ) : p.keep ? (
        <Button size="sm" variant="ghost" onClick={() => setKeepProtection(false)} data-testid="protection-remove">
          Remove protection
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setKeepProtection(true)} data-testid="protection-keep">
          Keep protection
        </Button>
      )}
      {restricted ? null : (
        <button type="button" aria-label="Close" className="rounded p-0.5 hover-app" onClick={() => setHidden(p)}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}
