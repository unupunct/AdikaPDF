/** In-place textarea for editing a text box, positioned over its Konva node. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TextObject } from '@/types';
import { usePDFStore } from '@/store/usePDFStore';
import { cssFontFamily } from '@/lib/fonts';
import { TEXT_PADDING, layoutText } from '@/lib/textLayout';

export function TextEditor({ obj, zoom }: { obj: TextObject; zoom: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(obj.text);
  const done = useRef(false);

  useEffect(() => {
    // Focus right away, and again after the creating click has finished in
    // case the click moved focus elsewhere.
    const focus = () => {
      const el = ref.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
    focus();
    const id = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(id);
  }, []);

  const layout = layoutText({ ...obj, text: value || ' ' });
  const height = Math.max(obj.height, layout.contentHeight);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.style.height = `${Math.max(height * zoom, el.scrollHeight)}px`;
  }, [height, zoom, value]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const store = usePDFStore.getState();
    const text = commit ? value : obj.text;
    if (text.trim() === '') {
      store.abandonNewObject(obj.id);
      return;
    }
    if (commit && text !== obj.text) {
      const h = layoutText({ ...obj, text }).contentHeight;
      store.updateObject(obj.id, { text, height: h });
    }
    store.setEditingText(null);
  };

  return (
    <textarea
      ref={ref}
      data-testid="text-editor"
      value={value}
      spellCheck
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(obj.text !== '' ? false : true);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-20 resize-none overflow-hidden border-0 outline-2 outline-brand-500"
      style={{
        left: obj.x * zoom,
        top: obj.y * zoom,
        width: obj.width * zoom,
        transform: `rotate(${obj.rotation}deg)`,
        transformOrigin: 'top left',
        padding: `${TEXT_PADDING * zoom}px`,
        fontFamily: cssFontFamily(obj.fontFamily),
        fontSize: obj.fontSize * zoom,
        fontWeight: obj.bold ? 700 : 400,
        fontStyle: obj.italic ? 'italic' : 'normal',
        lineHeight: obj.lineHeight,
        textAlign: obj.align,
        color: obj.color,
        background: obj.background ?? 'rgba(255,255,255,0.85)',
        fontKerning: 'none',
        opacity: obj.opacity,
      }}
    />
  );
}
