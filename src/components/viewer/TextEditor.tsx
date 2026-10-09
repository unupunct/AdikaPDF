/** In-place editor for a text box, positioned over its Konva node: plain text, or styled runs for comment text boxes. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bold, Italic, Minus, Plus, Strikethrough, Underline } from 'lucide-react';
import type { TextObject, TextRun } from '@/types';
import { usePDFStore } from '@/store/usePDFStore';
import { cssFontFamily } from '@/lib/fonts';
import { TEXT_PADDING, layoutText } from '@/lib/textLayout';
import { boxStyle, compactRuns, cssColor, familyOf, layoutRich, plainText, resolveRun, richRuns, type RunStyle } from '@/lib/richText';

export function TextEditor({ obj, zoom }: { obj: TextObject; zoom: number }) {
  if (obj.annotation) return <RichTextEditor obj={obj} zoom={zoom} />;
  return <PlainTextEditor obj={obj} zoom={zoom} />;
}

function PlainTextEditor({ obj, zoom }: { obj: TextObject; zoom: number }) {
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

const SWATCHES = ['#000000', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];

/** HTML for the editor: one span per run with its style, line breaks as <br>. */
function runsToHtml(base: RunStyle, runs: TextRun[], zoom: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = runs
    .map((r) => {
      const s = resolveRun(base, r);
      const deco = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
      const css = `font-family:${cssFontFamily(s.family).replace(/"/g, "'")};font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};text-decoration:${deco};color:${s.color};font-size:${s.size * zoom}px`;
      return `<span style="${css}">${r.text.split('\n').map(esc).join('<br>')}</span>`;
    })
    .join('');
  // A last empty line needs a placeholder to show.
  if (plainText(runs).endsWith('\n')) html += '<br>';
  return html;
}

/** Reads the edited DOM back into styled pieces (explicit styles and b / i / u / s tags, inherited). */
export function htmlToStyled(root: HTMLElement, base: RunStyle, zoom: number): Array<{ text: string; style: RunStyle }> {
  const out: Array<{ text: string; style: RunStyle }> = [];
  const atLineStart = () => !out.length || out[out.length - 1].text.endsWith('\n');
  const walk = (n: Node, s: RunStyle) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/ /g, ' ');
      if (t) out.push({ text: t, style: s });
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const tag = n.tagName;
    if (tag === 'BR') {
      out.push({ text: '\n', style: s });
      return;
    }
    let st = { ...s };
    if (tag === 'B' || tag === 'STRONG') st.bold = true;
    if (tag === 'I' || tag === 'EM') st.italic = true;
    if (tag === 'U') st.underline = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') st.strike = true;
    if (tag === 'FONT') {
      const c = cssColor(n.getAttribute('color') ?? '');
      if (c) st.color = c;
    }
    const css = n.style;
    if (css.fontWeight) st.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
    if (css.fontStyle) st.italic = css.fontStyle === 'italic' || css.fontStyle === 'oblique';
    const deco = css.textDecorationLine || css.textDecoration;
    if (deco) st = { ...st, underline: /underline/.test(deco), strike: /line-through/.test(deco) };
    if (css.color) st.color = cssColor(css.color) ?? st.color;
    if (css.fontFamily) st.family = familyOf(css.fontFamily);
    const px = parseFloat(css.fontSize);
    if (Number.isFinite(px) && px > 0) st.size = Math.round((px / zoom) * 10) / 10;
    const block = tag === 'DIV' || tag === 'P';
    if (block && !atLineStart()) out.push({ text: '\n', style: st });
    n.childNodes.forEach((c) => walk(c, st));
  };
  root.childNodes.forEach((c) => walk(c, base));
  // The placeholder <br> after a last empty line.
  if (root.lastChild instanceof HTMLBRElement && out.length && out[out.length - 1].text === '\n') out.pop();
  return out;
}

/**
 * Comment text boxes: a small rich editor. Bold, italic, underline,
 * strikethrough (buttons or Ctrl+B / I / U), colour and size apply to the
 * selected letters; new letters take the style where they are typed.
 */
function RichTextEditor({ obj, zoom }: { obj: TextObject; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const base = boxStyle(obj);
  const [height, setHeight] = useState(() => {
    const runs = richRuns(obj);
    return Math.max(obj.height, runs ? layoutRich(obj, runs).contentHeight : layoutText(obj).contentHeight);
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = runsToHtml(base, richRuns(obj) ?? [{ text: obj.text }], zoom);
    const focus = () => {
      if (document.activeElement === el) return;
      el.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(r);
    };
    focus();
    const id = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(id);
    // The content is set once; the browser edits it from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const read = (): { text: string; runs: TextRun[] | undefined } => {
    const styled = ref.current ? htmlToStyled(ref.current, base, zoom) : [];
    const text = styled.map((p) => p.text).join('');
    return { text, runs: compactRuns(styled, base) };
  };

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const store = usePDFStore.getState();
    const { text, runs } = commit ? read() : { text: obj.text, runs: obj.runs };
    if (text.trim() === '') {
      store.abandonNewObject(obj.id);
      return;
    }
    if (commit && (text !== obj.text || JSON.stringify(runs ?? null) !== JSON.stringify(richRuns(obj) ?? null))) {
      const next = { ...obj, text, runs };
      const h = runs ? layoutRich(next, runs).contentHeight : layoutText(next).contentHeight;
      store.updateObject(obj.id, { text, runs, height: h });
    }
    store.setEditingText(null);
  };

  /** Wraps the selected letters in a span with `css` (the same property inside is cleared). */
  const styleSelection = (css: Partial<Record<'color' | 'fontSize', string>>) => {
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
    const frag = range.extractContents();
    frag.querySelectorAll<HTMLElement>('*').forEach((c) => {
      for (const k of Object.keys(css) as Array<keyof typeof css>) c.style[k] = '';
    });
    const span = document.createElement('span');
    Object.assign(span.style, css);
    span.appendChild(frag);
    range.insertNode(span);
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(r);
    grow();
  };

  const sizeAtSelection = (): number => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    const px = el ? parseFloat(getComputedStyle(el).fontSize) : NaN;
    return Number.isFinite(px) ? px / zoom : obj.fontSize;
  };

  const grow = () => {
    const styled = ref.current ? htmlToStyled(ref.current, base, zoom) : [];
    const runs = styled.map(({ text, style }) => ({ text, ...style }));
    setHeight(Math.max(obj.height, layoutRich(obj, runs.length ? runs : [{ text: ' ' }]).contentHeight));
  };

  const command = (name: 'bold' | 'italic' | 'underline' | 'strikeThrough') => {
    document.execCommand(name);
    grow();
  };

  const tool = (label: string, testId: string, onClick: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      className="flex h-6 w-6 items-center justify-center rounded text-slate-700 hover:bg-slate-200"
      onMouseDown={(e) => {
        e.preventDefault(); // keep the selection in the text
        onClick();
      }}
    >
      {icon}
    </button>
  );

  return (
    <>
      <div
        className="absolute z-30 flex items-center gap-0.5 rounded-md border border-slate-300 bg-white px-1 py-0.5 shadow"
        style={{ left: obj.x * zoom, top: obj.y * zoom - 32 }}
        data-testid="rich-text-toolbar"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {tool('Bold (Ctrl+B)', 'rich-bold', () => command('bold'), <Bold size={13} />)}
        {tool('Italic (Ctrl+I)', 'rich-italic', () => command('italic'), <Italic size={13} />)}
        {tool('Underline (Ctrl+U)', 'rich-underline', () => command('underline'), <Underline size={13} />)}
        {tool('Strikethrough', 'rich-strike', () => command('strikeThrough'), <Strikethrough size={13} />)}
        <span className="mx-1 h-4 w-px bg-slate-300" />
        {tool('Smaller text', 'rich-smaller', () => styleSelection({ fontSize: `${Math.max(4, Math.round(sizeAtSelection() - 1)) * zoom}px` }), <Minus size={13} />)}
        {tool('Larger text', 'rich-larger', () => styleSelection({ fontSize: `${Math.min(144, Math.round(sizeAtSelection() + 1)) * zoom}px` }), <Plus size={13} />)}
        <span className="mx-1 h-4 w-px bg-slate-300" />
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title="Text colour"
            aria-label={`Text colour ${c}`}
            className="h-4 w-4 rounded-full ring-1 ring-slate-300"
            style={{ background: c }}
            onMouseDown={(e) => {
              e.preventDefault();
              styleSelection({ color: c });
            }}
          />
        ))}
      </div>
      <div
        ref={ref}
        data-testid="text-editor"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={grow}
        onBlur={() => finish(true)}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') finish(obj.text !== '' ? false : true);
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
          else if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertLineBreak');
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute z-20 overflow-hidden whitespace-pre-wrap break-words border-0 outline-2 outline-brand-500"
        style={{
          left: obj.x * zoom,
          top: obj.y * zoom,
          width: obj.width * zoom,
          minHeight: height * zoom,
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
    </>
  );
}
