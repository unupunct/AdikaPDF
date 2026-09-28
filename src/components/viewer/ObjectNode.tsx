/**
 * Konva rendering of one editor object. Every object is a Group positioned
 * at (x, y) with its rotation, drawing its content in local coordinates —
 * the same local frame the PDF exporter uses.
 */
import { memo, useEffect, useState } from 'react';
import { Arrow, Ellipse, Group, Image as KImage, Line, Path, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import type { EditorObject, SignatureObject, TextObject } from '@/types';
import { layoutText } from '@/lib/textLayout';
import { canvasFont, cssFontFamily } from '@/lib/fonts';
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
    case 'pen':
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
    case 'field': {
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
  return (
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
      }}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        ctx.rect(0, 0, obj.width, height);
        ctx.closePath();
        ctx.fillStrokeShape(shape);
      }}
    />
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
