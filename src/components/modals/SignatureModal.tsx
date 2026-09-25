/**
 * Electronic signature pad: draw (smoothed pressure-aware ink), type (script
 * fonts shipped with Windows) or upload an image (with background removal).
 * The result is a trimmed transparent PNG that is saved for reuse and
 * placed on the page with one click.
 */
import { useEffect, useRef, useState } from 'react';
import { Eraser, Trash2, Upload } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Checkbox, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import { pickFiles } from '@/lib/platform';
import { imageFileToDataUrl, loadImage } from '@/lib/objectFactory';
import { uid } from '@/lib/uid';
import type { SavedSignature } from '@/types';
import { cn } from '@/lib/cn';

type Mode = 'draw' | 'type' | 'upload';
const INKS = ['#0f172a', '#1d4ed8', '#047857'];
const SCRIPT_FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Brush Script MT', 'Gabriola', 'Segoe Print'];
const PAD_W = 560;
const PAD_H = 200;

export function SignatureModal() {
  const open = usePDFStore((s) => s.modal === 'signature');
  const close = () => usePDFStore.getState().openModal(null);
  const saved = usePDFStore((s) => s.savedSignatures);
  const [mode, setMode] = useState<Mode>('draw');
  const [kind, setKind] = useState<'signature' | 'initials'>('signature');
  const [name, setName] = useState(() => localStorageGet('adika.signerName'));
  const [ink, setInk] = useState(INKS[0]);
  const [font, setFont] = useState(SCRIPT_FONTS[0]);
  const [typed, setTyped] = useState('');
  const [upload, setUpload] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [hasInk, setHasInk] = useState(false);
  const padRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open) setTyped((t) => t || (kind === 'initials' ? initialsOf(name) : name));
  }, [open, kind, name]);

  const place = async (sig: SavedSignature) => {
    usePDFStore.getState().setPendingSignature(sig);
    close();
    usePDFStore.getState().toast('Click on the page where the signature should go.', 'info');
  };

  const create = async () => {
    let result: { src: string; width: number; height: number } | null = null;
    if (mode === 'draw' && padRef.current && hasInk) result = trimCanvas(padRef.current);
    if (mode === 'type' && typed.trim()) result = renderTyped(typed.trim(), font, ink);
    if (mode === 'upload' && upload) result = await processUpload(upload, removeBg);
    if (!result) {
      usePDFStore.getState().toast(mode === 'draw' ? 'Draw your signature first.' : mode === 'type' ? 'Type your name first.' : 'Choose an image first.', 'error');
      return;
    }
    localStorageSet('adika.signerName', name);
    const sig: SavedSignature = { id: uid('sig'), kind, signerName: name.trim(), ...result };
    usePDFStore.getState().saveSignature(sig);
    await place(sig);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Fill & Sign"
      description="Create an electronic signature. It is stored only on this computer."
      width={640}
      testId="signature-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} data-testid="signature-create">
            Save & place
          </Button>
        </>
      }
    >
      {saved.length > 0 ? (
        <div className="mb-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Saved — click to place</div>
          <div className="flex flex-wrap gap-2">
            {saved.map((s) => (
              <div key={s.id} className="group relative">
                <button type="button" onClick={() => void place(s)} className="flex h-14 w-36 items-center justify-center rounded-lg border border-app bg-white p-1.5 hover:border-brand-500">
                  <img src={s.src} alt={`${s.kind} of ${s.signerName}`} className="max-h-full max-w-full object-contain" />
                </button>
                <button
                  type="button"
                  aria-label="Delete saved signature"
                  onClick={() => usePDFStore.getState().removeSavedSignature(s.id)}
                  className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-rose-600 p-1 text-white group-hover:block"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maria Ionescu" data-testid="signer-name" />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={setKind} options={[{ value: 'signature', label: 'Full signature' }, { value: 'initials', label: 'Initials' }]} ariaLabel="Signature type" />
        </Field>
      </div>
      <Tabs value={mode} onChange={setMode} tabs={[{ value: 'draw', label: 'Draw' }, { value: 'type', label: 'Type' }, { value: 'upload', label: 'Upload image' }]} />
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-muted">Ink</span>
        {INKS.map((c) => (
          <button key={c} type="button" aria-label={`Ink ${c}`} onClick={() => setInk(c)} className={cn('h-5 w-5 rounded-full ring-offset-2 ring-offset-[var(--panel)]', ink === c && 'ring-2 ring-brand-500')} style={{ background: c }} />
        ))}
      </div>
      {mode === 'draw' ? <SignaturePad canvasRef={padRef} ink={ink} onInk={setHasInk} /> : null}
      {mode === 'type' ? (
        <div>
          <div className="mb-3 grid grid-cols-[1fr_200px] gap-3">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your signature" data-testid="typed-signature" />
            <Select value={font} onChange={setFont} options={SCRIPT_FONTS.map((f) => ({ value: f, label: f }))} ariaLabel="Signature font" />
          </div>
          <div className="flex h-[140px] items-center justify-center overflow-hidden rounded-lg border border-app bg-white px-4" style={{ fontFamily: `"${font}", cursive`, fontSize: 48, color: ink }}>
            {typed || <span className="text-base text-slate-400">Preview</span>}
          </div>
        </div>
      ) : null}
      {mode === 'upload' ? (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <Button
              onClick={async () => {
                const files = await pickFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]);
                if (files[0]) setUpload((await imageFileToDataUrl(files[0].bytes, files[0].name)).src);
              }}
            >
              <Upload size={14} /> Choose image…
            </Button>
            <Checkbox checked={removeBg} onChange={setRemoveBg} label="Remove white background" />
          </div>
          <div className="checkerboard flex h-[160px] items-center justify-center rounded-lg border border-app">
            {upload ? <img src={upload} alt="Uploaded signature" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-slate-500">A photo or scan of your signature</span>}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function SignaturePad({ canvasRef, ink, onInk }: { canvasRef: React.RefObject<HTMLCanvasElement>; ink: string; onInk: (v: boolean) => void }) {
  const last = useRef<{ x: number; y: number; w: number; t: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = PAD_W * dpr;
    c.height = PAD_H * dpr;
    const ctx = c.getContext('2d');
    ctx?.scale(dpr, dpr);
  }, [canvasRef]);

  const pos = (e: React.PointerEvent) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H };
  };

  const clear = () => {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, PAD_W, PAD_H);
    setEmpty(true);
    onInk(false);
  };

  return (
    <div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="signature-pad"
          className="h-[200px] w-full touch-none rounded-lg border border-app bg-white"
          style={{ aspectRatio: `${PAD_W}/${PAD_H}` }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            const p = pos(e);
            last.current = { ...p, w: 2.4, t: performance.now() };
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx) {
              ctx.fillStyle = ink;
              ctx.beginPath();
              ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
              ctx.fill();
            }
          }}
          onPointerMove={(e) => {
            const prev = last.current;
            const ctx = canvasRef.current?.getContext('2d');
            if (!prev || !ctx) return;
            const p = pos(e);
            const now = performance.now();
            const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
            const speed = dist / Math.max(1, now - prev.t);
            // Faster strokes are thinner; pen pressure (when available) thickens.
            const pressure = e.pressure > 0 && e.pointerType === 'pen' ? e.pressure * 1.6 : 1;
            const w = Math.max(1.1, Math.min(3.6, (3.2 - speed * 1.2) * pressure));
            const width = prev.w * 0.6 + w * 0.4;
            ctx.strokeStyle = ink;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            last.current = { ...p, w: width, t: now };
            if (empty) {
              setEmpty(false);
              onInk(true);
            }
          }}
          onPointerUp={() => (last.current = null)}
          onPointerCancel={() => (last.current = null)}
        />
        <div className="pointer-events-none absolute bottom-10 left-8 right-8 border-b border-dashed border-slate-300" />
        {empty ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">Sign here with mouse, pen or finger</div> : null}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={clear}>
          <Eraser size={13} /> Clear
        </Button>
      </div>
    </div>
  );
}

/** Crops a canvas to its inked pixels (+ small margin) and returns a PNG. */
function trimCanvas(c: HTMLCanvasElement): { src: string; width: number; height: number } | null {
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(width, height) * 0.01) + 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')?.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL('image/png'), width: out.width, height: out.height };
}

function renderTyped(text: string, font: string, ink: string): { src: string; width: number; height: number } | null {
  const c = document.createElement('canvas');
  const size = 96;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${size}px "${font}", cursive`;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  c.width = w;
  c.height = size * 2;
  const ctx2 = c.getContext('2d')!;
  ctx2.font = `${size}px "${font}", cursive`;
  ctx2.fillStyle = ink;
  ctx2.textBaseline = 'middle';
  ctx2.fillText(text, size / 2, size);
  return trimCanvas(c);
}

async function processUpload(src: string, removeBg: boolean): Promise<{ src: string; width: number; height: number } | null> {
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (removeBg) {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      // Soft threshold: paper → transparent, ink keeps its colour.
      const alpha = lum > 215 ? 0 : lum > 170 ? ((215 - lum) / 45) * 255 : 255;
      d.data[i + 3] = Math.min(d.data[i + 3], alpha);
    }
    ctx.putImageData(d, 0, 0);
  }
  return trimCanvas(c);
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase())
    .join('.')
    .concat(name.trim() ? '.' : '');
}

function localStorageGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
