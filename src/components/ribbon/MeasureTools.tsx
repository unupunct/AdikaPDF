/** Comment tab: Measure group (distance, perimeter, area) and the drawing-scale editor. */
import { useEffect, useState } from 'react';
import { ChevronDown, Pentagon, Ruler, Spline } from 'lucide-react';
import { Popover, Select } from '@/components/ui/primitives';
import { PAGE_UNITS, REAL_UNITS, scaleText, useMeasureScale, type MeasureScale, type PageUnit, type RealUnit } from '@/lib/measure';
import { Group, I, i, Stack, ToolBtn } from './ReaderTabs';

/** "1 mm = 1 mm" editor: page value + unit, real value + unit. */
export function ScaleEditor({ value, onChange }: { value: MeasureScale; onChange: (s: MeasureScale) => void }) {
  const [pv, setPv] = useState(String(value.pageValue));
  const [rv, setRv] = useState(String(value.realValue));
  useEffect(() => {
    setPv(String(value.pageValue));
    setRv(String(value.realValue));
  }, [value.pageValue, value.realValue]);
  const num = (s: string) => Number(s.replace(',', '.'));
  const commit = (p: Partial<MeasureScale>) => {
    const next = { ...value, ...p };
    if (next.pageValue > 0 && next.realValue > 0) onChange(next);
  };
  const box = 'h-7 w-16 rounded border border-app bg-panel-2 px-1.5 text-[12px] outline-none focus:border-brand-500';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <input aria-label="Page value" data-testid="scale-page-value" className={box} value={pv} onChange={(e) => setPv(e.target.value)} onBlur={() => commit({ pageValue: num(pv) })} onKeyDown={(e) => e.key === 'Enter' && commit({ pageValue: num(pv) })} />
      <div className="w-16">
        <Select value={value.pageUnit} ariaLabel="Page unit" onChange={(pageUnit: PageUnit) => commit({ pageUnit })} options={PAGE_UNITS.map((u) => ({ value: u, label: u }))} className="h-7" />
      </div>
      <span>=</span>
      <input aria-label="Real value" data-testid="scale-real-value" className={box} value={rv} onChange={(e) => setRv(e.target.value)} onBlur={() => commit({ realValue: num(rv) })} onKeyDown={(e) => e.key === 'Enter' && commit({ realValue: num(rv) })} />
      <div className="w-16">
        <Select value={value.realUnit} ariaLabel="Real unit" onChange={(realUnit: RealUnit) => commit({ realUnit })} options={REAL_UNITS.map((u) => ({ value: u, label: u }))} className="h-7" />
      </div>
    </div>
  );
}

function ScaleButton() {
  const scale = useMeasureScale((s) => s.scale);
  return (
    <Popover
      trigger={
        <button type="button" data-testid="btn-measure-scale" title="Drawing scale for new measurements" className="flex h-[19px] items-center gap-1 rounded px-1.5 text-[11.5px] hover-app">
          <span className="text-brand-600 dark:text-brand-400">1:</span>
          <span className="max-w-[110px] truncate">{scaleText(scale)}</span>
          <ChevronDown size={10} />
        </button>
      }
    >
      <div className="w-[300px]">
        <div className="mb-2 text-[12px] font-semibold">Scale</div>
        <ScaleEditor value={scale} onChange={(s) => useMeasureScale.getState().setScale(s)} />
        <p className="mt-2 text-[11px] text-muted">New measurements use this scale, e.g. 1 cm = 2 m for a drawing at 1:200. Change a measurement’s own scale in its properties.</p>
      </div>
    </Popover>
  );
}

export function MeasureGroup() {
  return (
    <Group label="Measure">
      <ToolBtn tool="measure-distance" icon={<Ruler size={I} />} label="Distance" tip="Drag between two points (Shift snaps to 45°)" />
      <Stack>
        <ToolBtn big={false} tool="measure-perimeter" icon={<Spline size={i} />} label="Perimeter" tip="Click the points; double-click or Enter to finish" />
        <ToolBtn big={false} tool="measure-area" icon={<Pentagon size={i} />} label="Area" tip="Click the corners; double-click, Enter or click the first point to finish" />
        <ScaleButton />
      </Stack>
    </Group>
  );
}
