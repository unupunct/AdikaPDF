/**
 * Ribbon building blocks. Every button is at least 24 × 24 px (WCAG 2.2
 * target size): big buttons 72 px tall, small ones 24 px, three to a stack.
 * A group the ribbon has no room for collapses into one button that shows
 * the group's commands below it.
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { DropdownTrigger, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

export interface BtnProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tip?: string;
  testId?: string;
  /** Accessible name of an icon-only button (no visible label). */
  name?: string;
}

export const I = 22;
export const i = 14;

/** Classes of big and small ribbon buttons (also used by menus and fields in the ribbon). */
export const BIG = 'flex h-[72px] min-w-[52px] flex-col items-center justify-center gap-1 rounded-md px-1 text-[11px] leading-tight disabled:opacity-40';
export const BIG_ACTIVE = 'bg-brand-100 text-brand-800 ring-1 ring-brand-300 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700';
export const SMALL = 'flex h-6 min-w-6 items-center gap-1.5 rounded px-1 text-[11.5px] disabled:opacity-40';
export const SMALL_ACTIVE = 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-100';
/** Height of fields placed in a stack. */
export const ROW = 'h-6';

/** Labels of the groups shown collapsed (set by the visible ribbon; copies elsewhere show every group). */
export const CollapsedGroups = createContext<ReadonlySet<string> | null>(null);

export function Group({ label, children }: { label: string; children: ReactNode }) {
  const collapsed = useContext(CollapsedGroups);
  if (collapsed?.has(label)) return <CollapsedGroup label={label}>{children}</CollapsedGroup>;
  return (
    <div data-ribbon-group={label} className="flex shrink-0 flex-col border-r border-app px-1 last:border-r-0">
      <div className="flex flex-1 items-start gap-0.5">{children}</div>
      <div className="text-center text-[10px] leading-3 text-muted">{label}</div>
    </div>
  );
}

/**
 * One button for a whole group; its commands open below it. They stay in
 * the page while closed (hidden), so the tool search and Quick Access can
 * still click them.
 */
function CollapsedGroup({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t) && !(t instanceof Element && t.closest('[data-radix-popper-content-wrapper]'))) setOpen(false);
    };
    window.addEventListener('mousedown', away, true);
    return () => window.removeEventListener('mousedown', away, true);
  }, [open]);

  // Below the button, kept inside the window (measured once shown).
  useLayoutEffect(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!open || !r) return;
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - 8 - (panel.current?.offsetWidth ?? 0))), top: r.bottom + 4 });
  }, [open]);
  const toggle = () => setOpen((o) => !o);

  return (
    <div data-ribbon-group={label} className="flex shrink-0 flex-col border-r border-app px-1 last:border-r-0">
      <div className="flex flex-1 items-start">
        <button ref={btn} type="button" data-ribbon-collapse aria-label={label} aria-expanded={open} aria-controls={id} onClick={toggle} className={cn(BIG, open ? BIG_ACTIVE : 'hover-app')}>
          <ChevronDown size={18} className="text-brand-600 dark:text-brand-400" />
          <span className="max-w-[72px] text-center">{label}</span>
        </button>
      </div>
      <div className="text-center text-[10px] leading-3 text-muted">{label}</div>
      <div
        ref={panel}
        id={id}
        role="group"
        aria-label={label}
        style={{ position: 'fixed', left: pos.left, top: pos.top }}
        className={cn('z-40 items-start gap-0.5 rounded-lg border border-app bg-panel p-1.5 shadow-xl', open ? 'flex' : 'hidden')}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }}
        onClick={(e) => {
          // A command ran: close (menus inside keep their own popups).
          const b = (e.target as Element).closest('button');
          if (b && !b.hasAttribute('aria-haspopup')) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Big({ icon, label, onClick, active, disabled, tip, testId }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button type="button" data-testid={testId} aria-label={label} data-tip={tip} aria-pressed={active} disabled={disabled} onClick={onClick} className={cn(BIG, active ? BIG_ACTIVE : 'hover-app')}>
        <span className={cn(active ? 'text-brand-700 dark:text-brand-200' : 'text-brand-600 dark:text-brand-400')}>{icon}</span>
        <span className="max-w-[72px] text-center">{label}</span>
      </button>
    </Tooltip>
  );
}

export function Small({ icon, label, onClick, active, disabled, tip, testId, name }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button type="button" data-testid={testId} aria-label={label || name || tip} data-tip={tip} aria-pressed={active} disabled={disabled} onClick={onClick} className={cn(SMALL, active ? SMALL_ACTIVE : 'hover-app')}>
        <span className="text-brand-600 dark:text-brand-400">{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return (
    <div data-ribbon-stack className="flex flex-col justify-start">
      {children}
    </div>
  );
}

/** A big button that opens a menu (inside a DropdownMenu). */
export function MenuButton({ icon, label, active, disabled, testId, tip }: { icon: ReactNode; label: string; active?: boolean; disabled?: boolean; testId?: string; tip: string }) {
  return (
    <DropdownTrigger asChild disabled={disabled}>
      <button type="button" data-testid={testId} aria-label={label} title={tip} disabled={disabled} className={cn(BIG, active ? BIG_ACTIVE : 'hover-app')}>
        <span className="text-brand-600 dark:text-brand-400">{icon}</span>
        <span className="max-w-[76px] text-center">
          {label}
          <ChevronDown size={10} className="ml-0.5 inline align-[-1px]" />
        </span>
      </button>
    </DropdownTrigger>
  );
}
