/**
 * Konva rendering of one editor object. Every object is a Group positioned
 * at (x, y) with its rotation, drawing its content in local coordinates —
 * the same local frame the PDF exporter uses.
 */
import { PressureLine } from './PressureLine';
import { memo, useEffect, useState } from 'react';
import { Arrow, Ellipse, Group, Image as KImage, Line, Path, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import type { EditorObject, MeasureObject, PolyObject, SignatureObject, StampObject, TextObject } from '@/types';
import { measureValue } from '@/lib/measure';
import { MEASURE_LABEL_SIZE, measureLabelAnchor, measureLabelOffset } from '@/lib/pdf/commentAnnots';
import { cloudPathData } from '@/lib/cloud';
import { calloutKnee } from '@/lib/pdf/annotations';
import { layoutText } from '@/lib/textLayout';
import { canvasFont, cssFontFamily } from '@/lib/fonts';
import { barcodeRects, type Symbology } from '@/lib/barcode/draw';

const previewCache = new Map<string, ReturnType<typeof barcodeRects>>();
/** Barcode modules for the canvas, cached (the scene is redrawn often). */
function barcodePreview(symbology: Symbology, text: string, aspect: number) {
  const key = `${symbology}|${aspect.toFixed(3)}|${text}`;
  let r = previewCache.get(key);
  if (!r) {
    try {
      r = barcodeRects(symbology, text, aspect);
    } catch {
      r = []; // too long for a QR code: shown empty
    }
    if (previewCache.size > 60) previewCache.clear();
    previewCache.set(key, r);
  }
  return r;
}
import { canvasMeasure } from '@/lib/textLayout';
import { SIGNATURE_CAPTION_FONT, SIGNATURE_CAPTION_HEIGHT, fitCaption, signatureCaption } from '@/lib/pdf/exportPdf';

const imageCache = new Map<string, HTMLImageElement>();

export function useHtmlImage(src: string): HTMLImageElement | undefined {
  const [img, setImg] = useState<HTMLImageElement | undefined>(() => {
    const cached = imageCache.get(src);
    return cached?.complete ? cached : undefined;
  });
  useEffect(() => {
    let alive = true;
    const cached = imageCache.get(src);
    if (cached?.complete) {
      setImg(cached);
      return;
    }
    const el = cached ?? new Image();
    if (!cached) {
      imageCache.set(src, el);
      el.src = src;
    }
    const done = () => alive && setImg(el);
    el.addEventListener('load', done);
    if (el.complete) done();
    return () => {
      alive = false;
      el.removeEventListener('load', done);
    };
  }, [src]);
  return img;
}

interface Props {
  obj: EditorObject;
  draggable: boolean;
  listening: boolean;
  hidden: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onDoubleClick: (id: string) => void;
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void;
}

export const ObjectNode = memo(function ObjectNode({ obj, draggable, listening, hidden, onSelect, onDoubleClick, onDragMove, onDragEnd, onTransformEnd }: Props) {
  return (
    <Group
      id={obj.id}
      name="object"
      x={obj.x}
      y={obj.y}
      rotation={obj.rotation}
      opacity={hidden ? 0 : 1}
      draggable={draggable}
      listening={listening}
      onMouseDown={(e) => {
        if (e.evt.button !== 0) return;
        e.cancelBubble = true;
        onSelect(obj.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        onSelect(obj.id, false);
      }}
      onDblClick={() => onDoubleClick(obj.id)}
      onDblTap={() => onDoubleClick(obj.id)}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onTransformEnd={onTransformEnd}
    >
      <Content obj={obj} />
    </Group>
  );
});

function Content({ obj }: { obj: EditorObject }) {
  switch (obj.type) {
    case 'note':
      return (
        <>
          <Rect width={20} height={20} fill="transparent" />
          <Path
            data="M2 2 H18 V14 H9 L5 18 V14 H2 Z"
            fill={obj.color}
            stroke="#3f3f46"
            strokeWidth={0.8}
            shadowColor="black"
            shadowOpacity={0.25}
            shadowBlur={2}
            shadowOffsetY={1}
          />
          <Line points={[5, 6, 15, 6]} stroke="#27272a" strokeWidth={1} listening={false} />
          <Line points={[5, 10, 13, 10]} stroke="#27272a" strokeWidth={1} listening={false} />
        </>
      );
    case 'markup':
      return (
        <>
          {obj.quads.map((q, i) => {
            if (obj.kind === 'highlight') return <Rect key={i} {...q} fill={obj.color} opacity={0.4 * obj.opacity} globalCompositeOperation="multiply" />;
            const t = Math.max(0.6, q.height * 0.07);
            if (obj.kind === 'squiggly') {
              const waves = Math.max(2, Math.round(q.width / Math.max(2, q.height * 0.25)));
              const pts: number[] = [q.x, q.y + q.height * 0.97];
              for (let k = 1; k <= waves; k++) pts.push(q.x + (q.width * k) / waves, q.y + q.height * (k % 2 ? 0.86 : 0.97));
              return (
                <Group key={i}>
                  <Rect {...q} fill="transparent" />
                  <Line points={pts} stroke={obj.color} strokeWidth={t} opacity={obj.opacity} />
                </Group>
              );
            }
            const fy = obj.kind === 'underline' ? 0.93 : 0.55;
            return (
              <Group key={i}>
                <Rect {...q} fill="transparent" />
                <Line points={[q.x, q.y + q.height * fy, q.x + q.width, q.y + q.height * fy]} stroke={obj.color} strokeWidth={t} opacity={obj.opacity} />
              </Group>
            );
          })}
        </>
      );
    case 'text':
      return <TextContent obj={obj} />;
    case 'image':
      return <ImageContent obj={obj} />;
    case 'signature':
      return <SignatureContent obj={obj} />;
    case 'rect':
      return <Rect width={obj.width} height={obj.height} stroke={obj.stroke ?? undefined} strokeWidth={obj.stroke ? obj.strokeWidth : 0} fill={obj.fill ?? undefined} opacity={obj.opacity} strokeScaleEnabled={false} />;
    case 'ellipse':
      return (
        <>
          <Rect width={obj.width} height={obj.height} fill="transparent" />
          <Ellipse
            x={obj.width / 2}
            y={obj.height / 2}
            radiusX={obj.width / 2}
            radiusY={obj.height / 2}
            stroke={obj.stroke ?? undefined}
            strokeWidth={obj.stroke ? obj.strokeWidth : 0}
            fill={obj.fill ?? undefined}
            opacity={obj.opacity}
          />
        </>
      );
    case 'highlight':
      return <Rect width={obj.width} height={obj.height} fill={obj.fill ?? '#facc15'} opacity={obj.opacity} globalCompositeOperation="multiply" />;
    case 'line':
      return <Line points={obj.points} stroke={obj.stroke} strokeWidth={obj.strokeWidth} opacity={obj.opacity} lineCap="round" hitStrokeWidth={Math.max(10, obj.strokeWidth + 8)} />;
    case 'arrow': {
      const len = Math.max(8, obj.strokeWidth * 4);
      return (
        <Arrow
          points={obj.points}
          stroke={obj.stroke}
          fill={obj.stroke}
          strokeWidth={obj.strokeWidth}
          opacity={obj.opacity}
          lineCap="round"
          pointerLength={len}
          pointerWidth={len * 2 * Math.sin(Math.PI / 7)}
          hitStrokeWidth={Math.max(10, obj.strokeWidth + 8)}
        />
      );
    }
    case 'vector':
      return (
        <>
          <Rect width={obj.width} height={obj.height} fill="transparent" />
          <Path
            data={obj.path}
            scaleX={obj.width / (obj.naturalWidth || 1)}
            scaleY={obj.height / (obj.naturalHeight || 1)}
            fill={obj.fill ?? undefined}
            fillRule={obj.evenOdd ? 'evenodd' : 'nonzero'}
            stroke={obj.stroke ?? undefined}
            strokeWidth={obj.stroke ? obj.strokeWidth : 0}
            strokeScaleEnabled={false}
            opacity={obj.opacity}
            lineJoin="round"
          />
        </>
      );
    case 'pen':
      if (obj.pressures?.length) return <PressureLine points={obj.points} pressures={obj.pressures} stroke={obj.stroke} strokeWidth={obj.strokeWidth} opacity={obj.opacity} />;
      return <Line points={obj.points} stroke={obj.stroke} strokeWidth={obj.strokeWidth} opacity={obj.opacity} lineCap="round" lineJoin="round" hitStrokeWidth={Math.max(10, obj.strokeWidth + 8)} />;
    case 'redact':
      return (
        <>
          <Rect width={obj.width} height={obj.height} fill={obj.fill} opacity={0.82} stroke="#e11d48" strokeWidth={1} dash={[4, 3]} strokeScaleEnabled={false} />
          {obj.width > 50 && obj.height > 10 ? (
            <Text text="REDACT" width={obj.width} height={obj.height} align="center" verticalAlign="middle" fill="#fecdd3" fontSize={Math.min(10, obj.height * 0.6)} fontStyle="bold" listening={false} />
          ) : null}
        </>
      );
    case 'stamp':
      return <StampContent obj={obj} />;
    case 'poly':
      return <PolyContent obj={obj} />;
    case 'measure':
      return <MeasureContent obj={obj} />;
    case 'attachment':
      return (
        <>
          <Rect width={obj.width} height={obj.height} fill="transparent" />
          <Path
            data="M10.5 15 V6 C10.5 1.5 4.5 1.5 4.5 6 V15.5 C4.5 18.8 8.5 18.8 8.5 15.5 V7 C8.5 5.2 6.5 5.2 6.5 7 V14"
            stroke={obj.color}
            strokeWidth={1.6}
            lineCap="round"
            scaleX={obj.width / 16}
            scaleY={obj.height / 20}
          />
        </>
      );
    case 'link':
      return <Rect width={obj.width} height={obj.height} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={1} dash={[4, 2]} strokeScaleEnabled={false} />;
    case 'field': {
      if (obj.fieldKind === 'barcode') {
        const spec = obj.barcode ?? { symbology: 'qr' as const, template: '' };
        return (
          <>
            <Rect width={obj.width} height={obj.height} fill="#ffffff" stroke="#0284c7" strokeWidth={1} dash={[3, 2]} strokeScaleEnabled={false} />
            <Shape
              listening={false}
              sceneFunc={(c) => {
                // A preview: the template itself (the field values are filled in when saving).
                const rects = barcodePreview(spec.symbology, spec.template || obj.name, obj.width / Math.max(1, obj.height));
                c.fillStyle = '#111827';
                for (const r of rects) c.fillRect(r.x * obj.width, r.y * obj.height, r.w * obj.width + 0.3, r.h * obj.height + 0.3);
              }}
            />
          </>
        );
      }
      if (obj.fieldKind === 'button') {
        return (
          <>
            <Rect width={obj.width} height={obj.height} fill="#e0f2fe" stroke="#0284c7" strokeWidth={1} cornerRadius={4} strokeScaleEnabled={false} />
            <Text text={obj.value || obj.name} width={obj.width} height={obj.height} align="center" verticalAlign="middle" fontSize={Math.min(12, obj.height * 0.5)} fill="#075985" wrap="none" ellipsis listening={false} />
          </>
        );
      }
      const label =
        obj.fieldKind === 'checkbox' ? '☐' : obj.fieldKind === 'radio' ? '◯' : obj.fieldKind === 'signature' ? `✍ ${obj.name}` : obj.fieldKind === 'dropdown' ? `${obj.name} ▾` : obj.value || obj.name;
      const small = obj.fieldKind === 'checkbox' || obj.fieldKind === 'radio';
      return (
        <>
          <Rect
            width={obj.width}
            height={obj.height}
            fill="rgba(2,132,199,0.10)"
            stroke="#0284c7"
            strokeWidth={1}
            dash={[3, 2]}
            cornerRadius={obj.fieldKind === 'radio' ? obj.width / 2 : 2}
            strokeScaleEnabled={false}
          />
          <Text
            text={label}
            x={small ? 0 : 3}
            width={small ? obj.width : obj.width - 6}
            height={obj.height}
            align={small ? 'center' : 'left'}
            verticalAlign="middle"
            fontSize={small ? Math.max(6, obj.height * 0.8) : Math.min(11, obj.height * 0.6)}
            fill="#0369a1"
            wrap="none"
            ellipsis
            listening={false}
          />
        </>
      );
    }
  }
}

function TextContent({ obj }: { obj: TextObject }) {
  const layout = layoutText(obj);
  const height = Math.max(obj.height, layout.contentHeight);
  const variant = { family: obj.fontFamily, bold: obj.bold, italic: obj.italic };
  const knee = obj.callout ? calloutKnee(obj.width, height, obj.callout) : null;
  return (
    <>
    {obj.callout && knee ? (
      <Arrow points={[knee.x, knee.y, obj.callout.x, obj.callout.y]} stroke={obj.border ?? obj.color} fill={obj.border ?? obj.color} strokeWidth={1} pointerLength={7} pointerWidth={6} opacity={obj.opacity} hitStrokeWidth={8} />
    ) : null}
    <Shape
      width={obj.width}
      height={height}
      opacity={obj.opacity}
      sceneFunc={(ctx) => {
        if (obj.background) {
          ctx.setAttr('fillStyle', obj.background);
          ctx.fillRect(0, 0, obj.width, height);
        }
        ctx.setAttr('font', canvasFont(variant, obj.fontSize));
        ctx.setAttr('fillStyle', obj.color);
        ctx.setAttr('textBaseline', 'alphabetic');
        ctx.setAttr('fontKerning', 'none');
        for (const line of layout.lines) if (line.text) ctx.fillText(line.text, line.x, line.baseline);
        if (!obj.text) {
          ctx.setAttr('fillStyle', 'rgba(100,116,139,0.8)');
          ctx.fillText('Type here…', layout.lines[0]?.x ?? 2, layout.lines[0]?.baseline ?? obj.fontSize);
        }
        if (obj.border) {
          ctx.setAttr('strokeStyle', obj.border);
          ctx.setAttr('lineWidth', 1);
          ctx.strokeRect(0.5, 0.5, obj.width - 1, height - 1);
        }
      }}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        ctx.rect(0, 0, obj.width, height);
        ctx.closePath();
        ctx.fillStrokeShape(shape);
      }}
    />
    </>
  );
}

function StampContent({ obj }: { obj: StampObject }) {
  const img = useHtmlImage(obj.src ?? '');
  if (obj.src) return <KImage image={img} width={obj.width} height={obj.height} opacity={obj.opacity} />;
  const h = obj.height;
  const main = Math.min(obj.subtitle ? h * 0.42 : h * 0.55, ((obj.width - 14) / Math.max(1, obj.label.length)) * 1.6);
  return (
    <Group opacity={obj.opacity}>
      <Rect x={1.5} y={1.5} width={obj.width - 3} height={h - 3} cornerRadius={Math.min(8, h / 4)} stroke={obj.color} strokeWidth={2} fill="rgba(255,255,255,0.01)" />
      <Rect x={4} y={4} width={obj.width - 8} height={h - 8} cornerRadius={Math.max(1, Math.min(8, h / 4) - 2.5)} stroke={obj.color} strokeWidth={0.75} listening={false} />
      <Text
        text={obj.label}
        width={obj.width}
        y={obj.subtitle ? h * 0.54 - main : (h - main) / 2}
        height={main * 1.1}
        align="center"
        fontSize={main}
        fontStyle="bold"
        fontFamily={cssFontFamily('sans')}
        fill={obj.color}
        wrap="none"
        listening={false}
      />
      {obj.subtitle ? (
        <Text text={obj.subtitle} width={obj.width} y={h * 0.62} align="center" fontSize={h * 0.2} fontFamily={cssFontFamily('sans')} fill={obj.color} wrap="none" listening={false} />
      ) : null}
    </Group>
  );
}

/** Measurement line or shape with its value label (also used for the live preview while drawing). */
export function MeasureShape({ kind, points, stroke, strokeWidth, label }: { kind: MeasureObject['kind']; points: number[]; stroke: string; strokeWidth: number; label: string }) {
  const size = MEASURE_LABEL_SIZE;
  const w = canvasMeasure({ family: 'sans', bold: false, italic: false }, size)(label);
  const at = measureLabelAnchor(kind, points);
  const off = measureLabelOffset(kind, w);
  const ticks: number[][] = [];
  if (kind === 'distance' && points.length >= 4) {
    const [x1, y1, x2, y2] = points;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / len) * 5;
    const ny = ((x2 - x1) / len) * 5;
    ticks.push([x1 - nx, y1 - ny, x1 + nx, y1 + ny], [x2 - nx, y2 - ny, x2 + nx, y2 + ny]);
  }
  return (
    <>
      <Line points={points} closed={kind === 'area'} stroke={stroke} strokeWidth={strokeWidth} lineJoin="round" hitStrokeWidth={Math.max(10, strokeWidth + 8)} />
      {ticks.map((t, k) => (
        <Line key={k} points={t} stroke={stroke} strokeWidth={strokeWidth} listening={false} />
      ))}
      <Rect x={at.x + off.x - 2} y={at.y + off.y - 0.5} width={w + 4} height={size + 3} fill="#ffffff" opacity={0.92} listening={false} />
      <Text x={at.x + off.x} y={at.y + off.y + 0.5} text={label} fontSize={size} fontFamily={cssFontFamily('sans')} fill={stroke} wrap="none" listening={false} />
    </>
  );
}

function MeasureContent({ obj }: { obj: MeasureObject }) {
  const { label } = measureValue(obj.kind, obj.points, obj.scale);
  return (
    <Group opacity={obj.opacity}>
      <Rect width={obj.width} height={obj.height} fill="transparent" />
      <MeasureShape kind={obj.kind} points={obj.points} stroke={obj.stroke} strokeWidth={obj.strokeWidth} label={label} />
    </Group>
  );
}

function PolyContent({ obj }: { obj: PolyObject }) {
  if (obj.kind === 'cloud') {
    return (
      <>
        <Rect width={obj.width} height={obj.height} fill="transparent" />
        <Path data={cloudPathData(obj.width, obj.height, Math.max(10, obj.strokeWidth * 6))} stroke={obj.stroke} strokeWidth={obj.strokeWidth} fill={obj.fill ?? undefined} opacity={obj.opacity} />
      </>
    );
  }
  return (
    <>
      <Rect width={obj.width} height={obj.height} fill="transparent" />
      <Line points={obj.points} closed={obj.kind === 'polygon'} stroke={obj.stroke} strokeWidth={obj.strokeWidth} fill={obj.kind === 'polygon' ? (obj.fill ?? undefined) : undefined} opacity={obj.opacity} lineJoin="round" lineCap="round" hitStrokeWidth={Math.max(10, obj.strokeWidth + 8)} />
    </>
  );
}

function ImageContent({ obj }: { obj: Extract<EditorObject, { type: 'image' }> }) {
  const img = useHtmlImage(obj.src);
  return (
    <KImage
      image={img}
      width={obj.width}
      height={obj.height}
      opacity={obj.opacity}
      crop={obj.crop ?? undefined}
    />
  );
}

function SignatureContent({ obj }: { obj: SignatureObject }) {
  const img = useHtmlImage(obj.src);
  const captionH = obj.showCaption ? SIGNATURE_CAPTION_HEIGHT : 0;
  const caption = obj.showCaption
    ? fitCaption(signatureCaption(obj), obj.width, canvasMeasure({ family: 'sans', bold: false, italic: false }, SIGNATURE_CAPTION_FONT))
    : '';
  return (
    <>
      <Rect width={obj.width} height={obj.height} fill="transparent" />
      <KImage image={img} width={obj.width} height={Math.max(1, obj.height - captionH)} opacity={obj.opacity} />
      {obj.showCaption ? (
        <>
          <Line points={[0, obj.height - captionH + 1, obj.width, obj.height - captionH + 1]} stroke="#64748b" strokeWidth={0.5} opacity={obj.opacity} />
          <Text
            text={caption}
            x={1}
            y={obj.height - captionH + 2.2}
            fontSize={SIGNATURE_CAPTION_FONT}
            fontFamily={cssFontFamily('sans')}
            fill="#334155"
            opacity={obj.opacity}
            wrap="none"
            listening={false}
          />
        </>
      ) : null}
    </>
  );
}
