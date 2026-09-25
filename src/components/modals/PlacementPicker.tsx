/**
 * Where a cryptographic signature appears: the selected ink signature or
 * signature field, a corner of a chosen page, or invisible.
 */
import { useMemo } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { Field, Select } from '@/components/ui/primitives';
import { displaySize } from '@/lib/geometry';
import type { SignPlacement } from '@/actions/sign';

export type PlacementMode = 'selected' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'invisible';

export interface PlacementState {
  mode: PlacementMode;
  pageNumber: number;
}

const BADGE_W = 210;
const BADGE_H = 62;
const MARGIN = 28;

export function useSelectedSignatureTarget() {
  const objects = usePDFStore((s) => s.objects);
  const selectedIds = usePDFStore((s) => s.selectedIds);
  return useMemo(() => {
    const o = objects.find((x) => selectedIds.includes(x.id) && (x.type === 'signature' || (x.type === 'field' && x.fieldKind === 'signature')));
    return o && (o.type === 'signature' || o.type === 'field') ? o : null;
  }, [objects, selectedIds]);
}

export function PlacementPicker({ value, onChange }: { value: PlacementState; onChange: (v: PlacementState) => void }) {
  const pages = usePDFStore((s) => s.pages.length);
  const target = useSelectedSignatureTarget();
  const options: Array<{ value: PlacementMode; label: string }> = [
    ...(target ? [{ value: 'selected' as const, label: target.type === 'signature' ? 'On the selected ink signature' : 'In the selected signature field' }] : []),
    { value: 'bottom-right', label: 'Bottom-right corner' },
    { value: 'bottom-left', label: 'Bottom-left corner' },
    { value: 'top-right', label: 'Top-right corner' },
    { value: 'top-left', label: 'Top-left corner' },
    { value: 'invisible', label: 'Invisible (no visible badge)' },
  ];
  return (
    <div className="grid grid-cols-[1fr_110px] gap-3">
      <Field label="Visible signature">
        <Select value={value.mode} onChange={(mode) => onChange({ ...value, mode })} options={options} ariaLabel="Signature placement" />
      </Field>
      <Field label="Page">
        <Select
          value={String(value.pageNumber)}
          disabled={value.mode === 'selected' || value.mode === 'invisible'}
          onChange={(v) => onChange({ ...value, pageNumber: Number(v) })}
          options={Array.from({ length: pages }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          ariaLabel="Signature page"
        />
      </Field>
    </div>
  );
}

/** Resolves the placement; returns the ink source and object to consume when signing on an ink signature. */
export function resolvePlacement(value: PlacementState): { placement: SignPlacement; inkSrc: string | null; consumeId: string | null } {
  const s = usePDFStore.getState();
  if (value.mode === 'selected') {
    const o = s.objects.find((x) => s.selectedIds.includes(x.id) && (x.type === 'signature' || (x.type === 'field' && x.fieldKind === 'signature')));
    if (o && (o.type === 'signature' || o.type === 'field')) {
      const pageIndex = s.pages.findIndex((p) => p.id === o.pageId);
      return {
        placement: { pageIndex, rect: { x: o.x, y: o.y, width: o.width, height: o.height } },
        inkSrc: o.type === 'signature' ? o.src : null,
        consumeId: o.id,
      };
    }
  }
  const pageIndex = Math.min(s.pages.length - 1, Math.max(0, value.pageNumber - 1));
  if (value.mode === 'invisible' || value.mode === 'selected') return { placement: { pageIndex, rect: null }, inkSrc: null, consumeId: null };
  const size = displaySize(s.pages[pageIndex]);
  const x = value.mode.endsWith('right') ? size.width - BADGE_W - MARGIN : MARGIN;
  const y = value.mode.startsWith('bottom') ? size.height - BADGE_H - MARGIN : MARGIN;
  return { placement: { pageIndex, rect: { x, y, width: BADGE_W, height: BADGE_H } }, inkSrc: null, consumeId: null };
}
