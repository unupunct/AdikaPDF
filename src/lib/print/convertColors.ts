/**
 * Converts a document's colours to grey (for black-and-white printing) or to
 * CMYK (for presses): the colour operators of every content stream (pages,
 * forms, tiling patterns, annotation appearances), colour space resources
 * (also indexed palettes), transparency groups, images and axial / radial
 * shadings. What cannot be converted safely (spot colours, mesh shadings,
 * sampled functions, JPEG 2000) is kept and reported.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import { parseContent } from '@/lib/pdf/textRemoval';
import { cmykToGray, rgbToCmyk, rgbToGray, type CMYK, type RGB } from './color';

export type ColorTarget = 'gray' | 'cmyk';
type Kind = 'rgb' | 'cmyk' | 'gray' | 'pattern' | 'other';

export interface ConvertReport {
  streams: number;
  images: number;
  shadings: number;
  kept: string[];
}

export interface ConvertHooks {
  /** Decodes a JPEG (DCT) image to RGB(A) or grey pixels: needed for photos. */
  decodeJpeg?: (bytes: Uint8Array, components: number) => Promise<{ data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 } | null>;
  /** Encodes grey pixels as JPEG (smaller than Flate for photos). */
  encodeGrayJpeg?: (gray: Uint8Array, width: number, height: number) => Promise<Uint8Array | null>;
}

const n3 = (v: number) => +v.toFixed(4);

function convertColor(kind: Kind, vals: number[], target: ColorTarget): number[] | null {
  if (kind === 'rgb' && vals.length >= 3) {
    const rgb: RGB = [vals[0], vals[1], vals[2]];
    return target === 'gray' ? [rgbToGray(rgb)] : rgbToCmyk(rgb);
  }
  if (kind === 'cmyk' && vals.length >= 4) return target === 'gray' ? [cmykToGray(vals.slice(0, 4) as CMYK)] : vals.slice(0, 4);
  if (kind === 'gray' && vals.length >= 1) return target === 'gray' ? [vals[0]] : [0, 0, 0, 1 - vals[0]];
  return null;
}

class Converter {
  report: ConvertReport = { streams: 0, images: 0, shadings: 0, kept: [] };
  private done = new Set<unknown>();
  constructor(
    private doc: PDFDocument,
    private target: ColorTarget,
    private hooks: ConvertHooks,
  ) {}

  private get ctx() {
    return this.doc.context;
  }
  private look(v: unknown): unknown {
    return v instanceof PDFRef ? this.ctx.lookup(v) : v;
  }
  private keep(what: string) {
    if (!this.report.kept.includes(what)) this.report.kept.push(what);
  }
  private get targetName() {
    return PDFName.of(this.target === 'gray' ? 'DeviceGray' : 'DeviceCMYK');
  }

  /** What a colour space is (named resource or inline). */
  kindOf(cs: unknown, res: PDFDict | undefined): Kind {
    let v = this.look(cs);
    if (v instanceof PDFName) {
      const n = v.decodeText();
      if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return 'rgb';
      if (n === 'DeviceCMYK' || n === 'CMYK') return 'cmyk';
      if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return 'gray';
      if (n === 'Pattern') return 'pattern';
      const csDict = res?.lookup(PDFName.of('ColorSpace'));
      if (csDict instanceof PDFDict) {
        const r = csDict.get(v);
        if (r) v = this.look(r);
        else return 'other';
      } else return 'other';
    }
    if (v instanceof PDFArray) {
      const fam = this.look(v.get(0));
      const f = fam instanceof PDFName ? fam.decodeText() : '';
      if (f === 'CalRGB') return 'rgb';
      if (f === 'CalGray') return 'gray';
      if (f === 'ICCBased') {
        const s = this.look(v.get(1));
        const nn = s instanceof PDFStream ? s.dict.lookup(PDFName.of('N')) : null;
        const k = nn instanceof PDFNumber ? nn.asNumber() : 3;
        return k === 3 ? 'rgb' : k === 4 ? 'cmyk' : k === 1 ? 'gray' : 'other';
      }
      if (f === 'Pattern') return 'pattern';
      if (f === 'Lab') return 'other';
    }
    if (v instanceof PDFName) return this.kindOf(v, undefined);
    return 'other';
  }

  // ------------------------------------------------ resources

  convertResources(res: PDFDict | undefined): void {
    if (!res || this.done.has(res)) return;
    this.done.add(res);
    const cs = res.lookup(PDFName.of('ColorSpace'));
    if (cs instanceof PDFDict) {
      for (const [name, val] of cs.entries()) {
        const kind = this.kindOf(val, undefined);
        if (kind === 'rgb' || (kind === 'cmyk' && this.target === 'gray')) {
          // Keep the name so content referring to it still works; its operands are converted too.
          if (!this.namedKinds.has(res)) this.namedKinds.set(res, new Map());
          this.namedKinds.get(res)!.set(name.decodeText(), kind);
          cs.set(name, this.targetName);
          continue;
        }
        const arr = this.look(val);
        if (arr instanceof PDFArray && (this.look(arr.get(0)) as PDFName | undefined)?.decodeText?.() === 'Indexed') {
          const fixed = this.convertIndexed(arr);
          if (fixed) cs.set(name, fixed);
        } else if (arr instanceof PDFArray) {
          const fam = (this.look(arr.get(0)) as PDFName | undefined)?.decodeText?.() ?? '';
          if (fam === 'Separation' || fam === 'DeviceN') this.keep('spot colours (Separation / DeviceN) are kept');
          else if (fam === 'Lab') this.keep('Lab colours are kept');
        }
      }
    }
    for (const key of ['XObject', 'Pattern', 'Shading']) {
      const d = res.lookup(PDFName.of(key));
      if (!(d instanceof PDFDict)) continue;
      for (const [, ref] of d.entries()) {
        const o = this.look(ref);
        if (key === 'XObject' && o instanceof PDFRawStream) {
          const sub = o.dict.lookup(PDFName.of('Subtype'));
          if (sub === PDFName.of('Form')) this.pendingForms.push(o);
          else if (sub === PDFName.of('Image')) this.pendingImages.push(o);
        } else if (key === 'Pattern') {
          if (o instanceof PDFRawStream) this.pendingForms.push(o); // tiling pattern
          else if (o instanceof PDFDict) {
            const sh = this.look(o.get(PDFName.of('Shading')));
            if (sh instanceof PDFDict || sh instanceof PDFStream) this.convertShading(sh instanceof PDFStream ? sh.dict : sh);
          }
        } else if (key === 'Shading' && (o instanceof PDFDict || o instanceof PDFStream)) this.convertShading(o instanceof PDFStream ? o.dict : o);
      }
    }
  }

  /** Named colour spaces replaced in a resource dictionary, with what they were. */
  private namedKinds = new Map<PDFDict, Map<string, Kind>>();
  pendingForms: PDFRawStream[] = [];
  pendingImages: PDFRawStream[] = [];

  private convertIndexed(arr: PDFArray): PDFArray | null {
    const base = arr.get(1);
    const kind = this.kindOf(base, undefined);
    if (kind === 'gray' && this.target === 'gray') return null;
    if (kind !== 'rgb' && kind !== 'cmyk' && kind !== 'gray') {
      this.keep('indexed images with an unusual palette are kept');
      return null;
    }
    const hival = (this.look(arr.get(2)) as PDFNumber).asNumber();
    const lk = this.look(arr.get(3));
    let table: Uint8Array;
    if (lk instanceof PDFString || lk instanceof PDFHexString) table = lk.asBytes();
    else if (lk instanceof PDFRawStream) table = decodePDFRawStream(lk).decode();
    else return null;
    const inN = kind === 'rgb' ? 3 : kind === 'cmyk' ? 4 : 1;
    const outN = this.target === 'gray' ? 1 : 4;
    const out = new Uint8Array((hival + 1) * outN);
    for (let i = 0; i <= hival; i++) {
      const vals = Array.from(table.subarray(i * inN, i * inN + inN), (v) => v / 255);
      const c = convertColor(kind, vals, this.target)!;
      c.forEach((v, k) => (out[i * outN + k] = Math.round(v * 255)));
    }
    return this.ctx.obj([PDFName.of('Indexed'), this.targetName, PDFNumber.of(hival), PDFHexString.of(Array.from(out, (b) => b.toString(16).padStart(2, '0')).join(''))]);
  }

  // ------------------------------------------------ shadings

  private convertFunction(fn: unknown, kind: Kind): PDFObject | null {
    const f = this.look(fn);
    const dict = f instanceof PDFStream ? f.dict : f instanceof PDFDict ? f : null;
    if (!dict) return null;
    const type = (dict.lookup(PDFName.of('FunctionType')) as PDFNumber | undefined)?.asNumber();
    if (type === 2) {
      const conv = (key: string, dflt: number[]) => {
        const a = dict.lookup(PDFName.of(key));
        const vals = a instanceof PDFArray ? a.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : dflt;
        const c = convertColor(kind, vals, this.target);
        if (c) dict.set(PDFName.of(key), this.ctx.obj(c.map(n3)));
        return !!c;
      };
      const ok = conv('C0', [0]) && conv('C1', [1]);
      return ok ? (f as PDFObject) : null;
    }
    if (type === 3) {
      const fns = dict.lookup(PDFName.of('Functions'));
      if (!(fns instanceof PDFArray)) return null;
      for (let i = 0; i < fns.size(); i++) if (!this.convertFunction(fns.get(i), kind)) return null;
      return f as PDFObject;
    }
    return null;
  }

  convertShading(sh: PDFDict): void {
    if (this.done.has(sh)) return;
    this.done.add(sh);
    const kind = this.kindOf(sh.get(PDFName.of('ColorSpace')), undefined);
    if (kind === 'other' || kind === 'pattern' || (kind === 'gray' && this.target === 'gray') || (kind === 'cmyk' && this.target === 'cmyk')) return;
    const type = (sh.lookup(PDFName.of('ShadingType')) as PDFNumber | undefined)?.asNumber();
    const fn = sh.get(PDFName.of('Function'));
    if ((type === 2 || type === 3) && fn) {
      const arr = this.look(fn);
      const fns = arr instanceof PDFArray ? arr.asArray() : [fn];
      if (fns.length === 1 && this.convertFunction(fns[0], kind)) {
        sh.set(PDFName.of('ColorSpace'), this.targetName);
        const bg = sh.lookup(PDFName.of('Background'));
        if (bg instanceof PDFArray) {
          const c = convertColor(kind, bg.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)), this.target);
          if (c) sh.set(PDFName.of('Background'), this.ctx.obj(c.map(n3)));
        }
        this.report.shadings++;
        return;
      }
    }
    this.keep('some gradients (mesh or sampled) are kept in their colours');
  }

  // ------------------------------------------------ content streams

  convertContent(src: Uint8Array, res: PDFDict | undefined): Uint8Array {
    const instrs = parseContent(src);
    const pieces: Array<{ start: number; end: number; text: string }> = [];
    let fill: Kind = 'gray';
    let stroke: Kind = 'gray';
    const stack: Array<[Kind, Kind]> = [];
    const nums = (args: { k: string; v?: unknown }[]) => args.filter((a) => a.k === 'n').map((a) => a.v as number);
    const emit = (vals: number[], op: string) => `${vals.map(n3).join(' ')} ${op}`;
    const set = (i: (typeof instrs)[number], text: string) => pieces.push({ start: i.start, end: i.end, text });
    const opFor = (stroking: boolean) => (this.target === 'gray' ? (stroking ? 'G' : 'g') : stroking ? 'K' : 'k');
    const nameKind = (name: string): Kind => (res && this.namedKinds.get(res)?.get(name)) ?? this.kindOf(PDFName.of(name), res);
    for (const ins of instrs) {
      const op = ins.op;
      if (op === 'q') stack.push([fill, stroke]);
      else if (op === 'Q') [fill, stroke] = stack.pop() ?? [fill, stroke];
      else if (op === 'rg' || op === 'RG') {
        const c = convertColor('rgb', nums(ins.args), this.target);
        if (c) set(ins, emit(c, opFor(op === 'RG')));
        if (op === 'rg') fill = this.target === 'gray' ? 'gray' : 'cmyk';
        else stroke = this.target === 'gray' ? 'gray' : 'cmyk';
      } else if ((op === 'k' || op === 'K') && this.target === 'gray') {
        const c = convertColor('cmyk', nums(ins.args), this.target);
        if (c) set(ins, emit(c, op === 'K' ? 'G' : 'g'));
      } else if ((op === 'g' || op === 'G') && this.target === 'cmyk') {
        const c = convertColor('gray', nums(ins.args), this.target);
        if (c) set(ins, emit(c, op === 'G' ? 'K' : 'k'));
      } else if (op === 'cs' || op === 'CS') {
        const a = ins.args[0];
        const name = a?.k === 'name' ? (a.v as string) : '';
        const kind = nameKind(name);
        // Device spaces are replaced here; named ones were replaced in the resources.
        if (['DeviceRGB', 'RGB', 'CalRGB', 'DeviceCMYK', 'CMYK', 'DeviceGray', 'G'].includes(name) && (kind === 'rgb' || (kind === 'cmyk' && this.target === 'gray') || (kind === 'gray' && this.target === 'cmyk'))) {
          set(ins, `/${this.target === 'gray' ? 'DeviceGray' : 'DeviceCMYK'} ${op}`);
        }
        // The operands that follow are converted from the original kind.
        if (op === 'cs') fill = kind;
        else stroke = kind;
      } else if (op === 'sc' || op === 'scn' || op === 'SC' || op === 'SCN') {
        const kind = op === 'sc' || op === 'scn' ? fill : stroke;
        const hasPattern = ins.args.some((x) => x.k === 'name');
        if (hasPattern) continue;
        const c = convertColor(kind, nums(ins.args), this.target);
        if (c && kind !== (this.target === 'gray' ? 'gray' : 'cmyk')) set(ins, emit(c, op));
      } else if (op === 'BI') {
        this.keep('inline images are kept in their colours');
      }
    }
    if (!pieces.length) return src;
    pieces.sort((x, y) => x.start - y.start);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let pos = 0;
    for (const p of pieces) {
      parts.push(src.subarray(pos, p.start), enc.encode(p.text));
      pos = p.end;
    }
    parts.push(src.subarray(pos));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  private groupCs(dict: PDFDict) {
    const g = dict.lookup(PDFName.of('Group'));
    if (g instanceof PDFDict && g.has(PDFName.of('CS'))) {
      const kind = this.kindOf(g.get(PDFName.of('CS')), undefined);
      if (kind === 'rgb' || (kind === 'cmyk' && this.target === 'gray')) g.set(PDFName.of('CS'), this.targetName);
    }
  }

  async convertForms(): Promise<void> {
    while (this.pendingForms.length) {
      const f = this.pendingForms.pop()!;
      if (this.done.has(f)) continue;
      this.done.add(f);
      const res = f.dict.lookup(PDFName.of('Resources'));
      this.convertResources(res instanceof PDFDict ? res : undefined);
      this.groupCs(f.dict);
      let data: Uint8Array;
      try {
        data = decodePDFRawStream(f).decode();
      } catch {
        this.keep('a drawing with an unusual compression is kept');
        continue;
      }
      const out = this.convertContent(data, res instanceof PDFDict ? res : undefined);
      if (out !== data) {
        const fresh = this.ctx.flateStream(out);
        for (const [k, v] of f.dict.entries()) if (!['Filter', 'DecodeParms', 'Length'].includes(k.decodeText())) fresh.dict.set(k, v);
        const ref = this.ctx.getObjectRef(f);
        if (ref) this.ctx.assign(ref, fresh);
      }
      this.report.streams++;
    }
  }

  // ------------------------------------------------ images

  async convertImages(): Promise<void> {
    for (const img of this.pendingImages) {
      if (this.done.has(img)) continue;
      this.done.add(img);
      const d = img.dict;
      if (d.lookup(PDFName.of('ImageMask'))?.toString() === 'true') continue;
      const csv = d.get(PDFName.of('ColorSpace'));
      const csArr = this.look(csv);
      if (csArr instanceof PDFArray && (this.look(csArr.get(0)) as PDFName | undefined)?.decodeText?.() === 'Indexed') {
        const fixed = this.convertIndexed(csArr);
        if (fixed) d.set(PDFName.of('ColorSpace'), fixed);
        this.report.images++;
        continue;
      }
      const kind = this.kindOf(csv, undefined);
      if (kind === 'other' || kind === 'pattern' || (kind === 'gray' && this.target === 'gray') || (kind === 'cmyk' && this.target === 'cmyk')) {
        if (kind === 'other') this.keep('some images in special colour spaces are kept');
        continue;
      }
      const w = (d.lookup(PDFName.of('Width')) as PDFNumber).asNumber();
      const h = (d.lookup(PDFName.of('Height')) as PDFNumber).asNumber();
      const bpc = (d.lookup(PDFName.of('BitsPerComponent')) as PDFNumber | undefined)?.asNumber() ?? 8;
      const inN = kind === 'rgb' ? 3 : kind === 'cmyk' ? 4 : 1;
      const filter = d.lookup(PDFName.of('Filter'));
      const filters = filter instanceof PDFName ? [filter.decodeText()] : filter instanceof PDFArray ? filter.asArray().map((x) => (x as PDFName).decodeText()) : [];
      let px: Uint8Array | Uint8ClampedArray | null = null;
      let channels = inN;
      if (filters.length === 1 && (filters[0] === 'DCTDecode' || filters[0] === 'DCT')) {
        const r = this.hooks.decodeJpeg ? await this.hooks.decodeJpeg(img.contents, inN) : null;
        if (!r || r.width !== w || r.height !== h) {
          this.keep('JPEG photos are kept in colour (they could not be decoded here)');
          continue;
        }
        px = r.data;
        channels = r.channels;
        // Adobe CMYK JPEGs are usually stored inverted.
      } else if (filters.every((f) => f === 'FlateDecode' || f === 'Fl' || f === 'LZWDecode' || f === 'ASCIIHexDecode' || f === 'ASCII85Decode' || f === 'RunLengthDecode') && bpc === 8) {
        try {
          px = decodePDFRawStream(img).decode();
        } catch {
          px = null;
        }
        const predictor = d.lookup(PDFName.of('DecodeParms'));
        if (predictor instanceof PDFDict && predictor.has(PDFName.of('Predictor')) && (predictor.lookup(PDFName.of('Predictor')) as PDFNumber).asNumber() > 1) px = null;
        if (!px || px.length < w * h * inN) {
          this.keep('some compressed images are kept in colour');
          continue;
        }
      } else {
        this.keep(filters.includes('JPXDecode') ? 'JPEG 2000 images are kept in colour' : 'some images are kept in colour');
        continue;
      }
      const outN = this.target === 'gray' ? 1 : 4;
      const out = new Uint8Array(w * h * outN);
      const vals: number[] = [0, 0, 0, 0];
      for (let i = 0; i < w * h; i++) {
        for (let k = 0; k < channels; k++) vals[k] = px[i * channels + k] / 255;
        const srcKind: Kind = channels === 4 && kind !== 'cmyk' ? 'rgb' : channels === 1 ? 'gray' : kind;
        const c = convertColor(srcKind, vals.slice(0, channels), this.target)!;
        for (let k = 0; k < outN; k++) out[i * outN + k] = Math.round(c[k] * 255);
      }
      let stream: PDFStream;
      const jpeg = this.target === 'gray' && filters[0]?.startsWith('DCT') && this.hooks.encodeGrayJpeg ? await this.hooks.encodeGrayJpeg(out, w, h) : null;
      if (jpeg) stream = this.ctx.stream(jpeg, { Filter: 'DCTDecode' });
      else stream = this.ctx.flateStream(out);
      for (const [k, v] of d.entries()) if (!['Filter', 'DecodeParms', 'Length', 'ColorSpace', 'Decode', 'BitsPerComponent'].includes(k.decodeText())) stream.dict.set(k, v);
      stream.dict.set(PDFName.of('ColorSpace'), this.targetName);
      stream.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      const ref = this.ctx.getObjectRef(img);
      if (ref) this.ctx.assign(ref, stream);
      this.report.images++;
    }
  }

  // ------------------------------------------------ pages and annotations

  async run(): Promise<ConvertReport> {
    const { pageContent, resourcesOf } = await import('@/lib/pdf/textRemoval');
    for (const page of this.doc.getPages()) {
      const res = resourcesOf(page);
      this.convertResources(res);
      this.groupCs(page.node);
      const src = pageContent(this.doc, page);
      const out = this.convertContent(src, res);
      if (out !== src) page.node.set(PDFName.of('Contents'), this.ctx.register(this.ctx.flateStream(out)));
      this.report.streams++;
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const a = annots.lookup(i);
          if (!(a instanceof PDFDict)) continue;
          for (const key of ['C', 'IC']) {
            const c = a.lookup(PDFName.of(key));
            if (c instanceof PDFArray && c.size() === 3) {
              const v = convertColor('rgb', c.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)), this.target);
              if (v) a.set(PDFName.of(key), this.ctx.obj(v.map(n3)));
            }
          }
          const ap = a.lookup(PDFName.of('AP'));
          if (ap instanceof PDFDict)
            for (const [, v] of ap.entries()) {
              const s = this.look(v);
              if (s instanceof PDFRawStream) this.pendingForms.push(s);
              else if (s instanceof PDFDict) for (const [, sv] of s.entries()) if (this.look(sv) instanceof PDFRawStream) this.pendingForms.push(this.look(sv) as PDFRawStream);
            }
        }
      }
      await this.convertForms();
    }
    await this.convertImages();
    return this.report;
  }
}

export async function convertDocumentColors(doc: PDFDocument, target: ColorTarget, hooks: ConvertHooks = {}): Promise<ConvertReport> {
  return new Converter(doc, target, hooks).run();
}

export async function convertColors(bytes: Uint8Array, target: ColorTarget, hooks: ConvertHooks = {}): Promise<{ bytes: Uint8Array; report: ConvertReport }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const report = await convertDocumentColors(doc, target, hooks);
  return { bytes: await doc.save({ useObjectStreams: true }), report };
}
