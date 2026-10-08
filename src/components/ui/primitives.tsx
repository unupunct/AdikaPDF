/**
 * Shadcn-style primitives (Radix + Tailwind + cva), kept in one module
 * because the app uses a small, stable set.
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

// ------------------------------------------------------------------ Button

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 cursor-default',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
        accent: 'bg-accent-600 text-white hover:bg-accent-500 shadow-sm',
        outline: 'border border-app bg-panel hover-app',
        ghost: 'hover-app',
        danger: 'bg-rose-600 text-white hover:bg-rose-700',
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type, ...props }, ref) => (
  <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';

// ------------------------------------------------------------------ Tooltip

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ content, children, side = 'bottom' }: { content: React.ReactNode; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[100] max-w-xs rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg dark:bg-slate-700"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ------------------------------------------------------------------ Dialog

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 520,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-testid={testId}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-app bg-panel shadow-2xl"
          onOpenAutoFocus={(e) => {
            const target = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-autofocus]');
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close" className="-mr-2 -mt-1 h-7 w-7">
                <X size={16} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-app px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ------------------------------------------------------------------ Popover

export function Popover({ trigger, children, align = 'start' }: { trigger: React.ReactElement; children: React.ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align={align} sideOffset={6} className="z-[60] rounded-lg border border-app bg-panel p-3 shadow-xl">
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ------------------------------------------------------------------ Dropdown

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export function DropdownContent({ children, align = 'start' }: { children: React.ReactNode; align?: 'start' | 'end' }) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content align={align} sideOffset={4} className="z-[60] min-w-[200px] rounded-lg border border-app bg-panel p-1 shadow-xl">
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({ children, onSelect, disabled, icon }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean; icon?: React.ReactNode }) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-brand-600 data-[highlighted]:text-white"
    >
      {icon}
      {children}
    </DropdownPrimitive.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-[var(--border)]" />;
}

// ------------------------------------------------------------------ Form controls

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-8 w-full rounded-md border border-app bg-panel-2 px-2.5 text-[13px] outline-none placeholder:text-[var(--muted)] focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full rounded-md border border-app bg-panel-2 px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
  disabled,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn('h-8 w-full rounded-md border border-app bg-panel-2 px-2 text-[13px] outline-none focus:border-brand-500', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Label({ children, className, htmlFor, id }: { children: React.ReactNode; className?: string; htmlFor?: string; id?: string }) {
  return (
    <label htmlFor={htmlFor} id={id} className={cn('mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted', className)}>
      {children}
    </label>
  );
}

const LABELLABLE = new Set<unknown>([Input, Textarea, Select, 'input', 'select', 'textarea']);

/** A labelled form row: the label is tied to a single control child, or names the group otherwise. */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  const id = React.useId();
  const control = React.isValidElement<{ id?: string }>(children) && LABELLABLE.has(children.type) ? children : null;
  const controlId = control ? (control.props.id ?? `${id}-control`) : undefined;
  return (
    <div className="mb-3">
      <Label htmlFor={controlId} id={`${id}-label`}>
        {label}
      </Label>
      {control ? (
        React.cloneElement(control, { id: controlId })
      ) : (
        <div role="group" aria-labelledby={`${id}-label`}>
          {children}
        </div>
      )}
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; disabled?: boolean; ariaLabel?: string }) {
  return (
    <label className={cn('flex cursor-default items-center gap-2 py-1 text-[13px]', disabled && 'opacity-50')}>
      <input type="checkbox" aria-label={ariaLabel} className="h-4 w-4 accent-[var(--color-brand-600)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function ColorSwatch({ value, onChange, label, allowNone }: { value: string | null; onChange: (v: string | null) => void; label: string; allowNone?: boolean }) {
  const presets = ['#0f172a', '#ffffff', '#e11d48', '#f97316', '#facc15', '#10b981', '#0284c7', '#7c3aed'];
  return (
    <Popover
      trigger={
        <button type="button" aria-label={label} className="flex h-8 items-center gap-2 rounded-md border border-app bg-panel-2 px-2 text-xs hover-app">
          <span className={cn('h-4 w-4 rounded border border-black/15', !value && 'checkerboard')} style={value ? { background: value } : undefined} />
          <span className="font-mono">{value ?? 'none'}</span>
        </button>
      }
    >
      <div className="w-[180px]">
        <div className="mb-2 grid grid-cols-8 gap-1">
          {presets.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => onChange(c)} className="h-5 w-5 rounded border border-black/15" style={{ background: c }} />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input type="color" aria-label={`${label} picker`} value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} className="h-7 w-10 cursor-pointer rounded border border-app bg-transparent" />
          {allowNone ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              None
            </Button>
          ) : null}
        </div>
      </div>
    </Popover>
  );
}

export function Progress({ value, label }: { value: number | null; label?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(Math.max(0, Math.min(1, value)) * 100)}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]"
    >
      {value === null ? (
        <div className="animate-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-brand-500" />
      ) : (
        <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
      )}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: React.ReactNode }> }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 rounded-lg bg-[var(--hover)] p-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn('flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium', value === t.value ? 'bg-panel shadow-sm' : 'text-muted hover:text-[var(--text)]')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Callout({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'success'; children: React.ReactNode }) {
  const styles = {
    info: 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-100',
    warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
    error: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
  } as const;
  return <div className={cn('mb-3 rounded-lg border px-3 py-2 text-xs leading-relaxed', styles[kind])}>{children}</div>;
}
