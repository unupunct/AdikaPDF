/** An ink line whose width follows the pen pressure at each point. */
import { Shape } from 'react-konva';
import { pressureWidth } from '@/lib/objectFactory';

export function PressureLine({ points, pressures, stroke, strokeWidth, opacity, listening = true }: { points: number[]; pressures: number[]; stroke: string; strokeWidth: number; opacity: number; listening?: boolean }) {
  return (
    <Shape
      opacity={opacity}
      listening={listening}
      stroke={stroke}
      strokeWidth={strokeWidth}
      hitStrokeWidth={Math.max(10, strokeWidth + 8)}
      sceneFunc={(ctx, shape) => {
        const c = ctx._context;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.strokeStyle = stroke;
        for (let i = 2; i < points.length; i += 2) {
          const p = ((pressures[i / 2 - 1] ?? 0.5) + (pressures[i / 2] ?? 0.5)) / 2;
          c.beginPath();
          c.moveTo(points[i - 2], points[i - 1]);
          c.lineTo(points[i], points[i + 1]);
          c.lineWidth = pressureWidth(strokeWidth, p);
          c.stroke();
        }
        // The hit area: the whole line at its widest.
        ctx.beginPath();
        ctx.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
        ctx.fillStrokeShape(shape);
      }}
      perfectDrawEnabled={false}
      strokeEnabled={false}
    />
  );
}
