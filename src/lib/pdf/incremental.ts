/**
 * Incremental updates: new and changed objects are appended after the
 * original bytes (with a new cross-reference section pointing back to the
 * previous one), so everything before stays byte for byte identical and
 * existing digital signatures remain valid.
 */
import { PDFContext, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import type { Unlocked } from '@/lib/crypto/decrypt';
import { gatherObjects, scanFile } from './repair';

const enc = new TextEncoder();

function objBytes(obj: PDFObject): Uint8Array {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Offset of the last cross-reference section, whether it is a stream, and its /Size; null when there is none to point back to. */
function lastXref(bytes: Uint8Array): { offset: number; stream: boolean; size: number } | null {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) return null;
  const offset = Number(m[1]);
  const head = new TextDecoder('latin1').decode(bytes.subarray(offset, offset + 64));
  // startxref pointing at neither a table nor an object (a damaged file pdf.js reconstructed).
  if (offset >= bytes.length || !/^\s*(xref|\d+\s+\d+\s+obj)/.test(head)) return null;
  const stream = !/^\s*xref/.test(head);
  // The trailer (or xref stream dictionary) of that section: its /Size.
  const section = new TextDecoder('latin1').decode(bytes.subarray(offset, Math.min(bytes.length, offset + (stream ? 1024 : bytes.length - offset))));
  const sm = stream ? /\/Size\s+(\d+)/.exec(section) : /trailer[\s\S]*?\/Size\s+(\d+)/.exec(section);
  return { offset, stream, size: sm ? Number(sm[1]) : 0 };
}

/** Object numbers stored in an object stream, in their order (index = position). */
function objStmNumbers(stream: PDFRawStream): number[] {
  try {
    const data = decodePDFRawStream(stream).decode();
    const first = stream.dict.get(PDFName.of('First'));
    const count = stream.dict.get(PDFName.of('N'));
    if (!(first instanceof PDFNumber) || !(count instanceof PDFNumber)) return [];
    const head = new TextDecoder('latin1').decode(data.subarray(0, first.asNumber()));
    const ints = (head.match(/\d+/g) ?? []).map(Number);
    const out: number[] = [];
    for (let k = 0; k + 1 < ints.length && out.length < count.asNumber(); k += 2) out.push(ints[k]);
    return out;
  } catch {
    return [];
  }
}

export interface IncrementalResult {
  bytes: Uint8Array;
  /** Objects written in the update (new or changed). */
  written: PDFRef[];
  /** Byte offset where the update starts. */
  start: number;
}

/** An encrypted original: its decrypted copy (same object numbers) and the file key. */
export interface EncryptedOriginal {
  plain: Uint8Array;
  unlocked: Unlocked;
}

/**
 * Loads `original`, lets `edit` change it with pdf-lib, then appends only
 * what changed. An encrypted original is edited through its decrypted copy
 * (`encrypted`) and the appended objects are encrypted with its file key;
 * without that, encrypted files are refused.
 */
export async function incrementalUpdate(original: Uint8Array, edit: (doc: PDFDocument) => void | Promise<void>, encrypted?: EncryptedOriginal): Promise<IncrementalResult> {
  const doc = await PDFDocument.load(encrypted?.plain ?? original, { updateMetadata: false });
  if (doc.context.trailerInfo.Encrypt) throw new Error('Encrypted PDFs cannot be updated incrementally.');
  const prev = lastXref(original);
  // No usable cross-reference section: the update carries a complete table of the file's objects
  // (found by scanning, the last copy of a number winning as in pdf-lib) instead of pointing back.
  let existing: Map<number, { off: number; gen: number }> | null = null;
  // Objects stored in object streams: their stream's number and their index in it.
  const packed = new Map<number, { stm: number; idx: number }>();
  let top = (prev?.size ?? 0) - 1;
  if (!prev) {
    existing = new Map();
    const scan = scanFile(original);
    for (const h of scan.headers) {
      existing.set(h.num, { off: h.start, gen: h.gen });
      top = Math.max(top, h.num);
    }
    for (const { num, stream } of gatherObjects(original, scan.headers, PDFContext.create()).objStms) {
      for (const [k, n] of objStmNumbers(stream).entries()) {
        if (!existing.has(n) && !packed.has(n)) packed.set(n, { stm: num, idx: k });
        top = Math.max(top, n);
      }
    }
    for (const [ref] of doc.context.enumerateIndirectObjects()) {
      if (!existing.has(ref.objectNumber) && !packed.has(ref.objectNumber)) throw new Error('This PDF has no cross-reference table, so it cannot be updated incrementally.');
    }
  }
  // pdf-lib does not count object-stream containers or the xref stream itself:
  // new objects must be numbered above everything the file already uses.
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, top);
  const before = new Map<string, Uint8Array>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) before.set(ref.toString(), objBytes(obj));
  await edit(doc);
  await doc.flush();

  let changed: Array<[PDFRef, Uint8Array]> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const b = objBytes(obj);
    const old = before.get(ref.toString());
    if (!old || !sameBytes(old, b)) changed.push([ref, b]);
  }
  if (encrypted) {
    const { encryptObjects } = await import('@/lib/crypto/decrypt');
    await encryptObjects(doc.context, encrypted.unlocked, changed.map(([r]) => r));
    changed = changed.map(([r]) => [r, objBytes(doc.context.lookup(r)!)]);
  }
  const parts: Uint8Array[] = [original];
  let pos = original.length;
  const push = (b: Uint8Array) => {
    parts.push(b);
    pos += b.length;
  };
  if (original[original.length - 1] !== 0x0a) push(enc.encode('\n'));
  const start = pos;
  const offsets = new Map<number, { off: number; gen: number }>();
  for (const [ref, b] of changed.sort((a, c) => a[0].objectNumber - c[0].objectNumber)) {
    offsets.set(ref.objectNumber, { off: pos, gen: ref.generationNumber });
    push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(b);
    push(enc.encode('\nendobj\n'));
  }

  const trailer = doc.context.trailerInfo;
  const refText = (v: unknown) => (v instanceof PDFRef ? `${v.objectNumber} ${v.generationNumber} R` : null);
  const idText = trailer.ID ? new TextDecoder('latin1').decode(objBytes(trailer.ID as PDFObject)) : null;
  const encryptText = encrypted ? `/Encrypt ${encrypted.unlocked.security.entry}` : '';
  const common = [`/Root ${refText(trailer.Root)}`, trailer.Info ? `/Info ${refText(trailer.Info)}` : '', idText ? `/ID ${idText}` : '', encryptText, prev ? `/Prev ${prev.offset}` : ''].filter(Boolean).join(' ');

  const xrefAt = pos;
  if (existing && packed.size) {
    // A complete cross-reference stream: plain objects, objects in object streams, and the update.
    for (const [n, e] of offsets) {
      existing.set(n, e);
      packed.delete(n);
    }
    const own = Math.max(doc.context.largestObjectNumber, top) + 1;
    existing.set(own, { off: xrefAt, gen: 0 });
    const size = own + 1;
    const rows = new Uint8Array(size * 7);
    for (let n = 0; n < size; n++) {
      const e = existing.get(n);
      const p = packed.get(n);
      const [t, a, b] = e ? [1, e.off, e.gen] : p ? [2, p.stm, p.idx] : [0, 0, n === 0 ? 65535 : 0];
      rows.set([t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255], n * 7);
    }
    push(enc.encode(`${own} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] ${common} /Length ${rows.length} >>\nstream\n`));
    push(rows);
    push(enc.encode(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else if (existing) {
    for (const [n, e] of offsets) existing.set(n, e);
    const size = Math.max(doc.context.largestObjectNumber, top) + 1;
    let body = `xref\n0 ${size}\n`;
    for (let n = 0; n < size; n++) {
      const e = existing.get(n);
      body += e ? `${String(e.off).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n` : '0000000000 65535 f\r\n';
    }
    body += `trailer\n<< /Size ${size} ${common} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(enc.encode(body));
  } else if (!prev!.stream) {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let body = 'xref\n';
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      body += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const e = offsets.get(nums[k])!;
        body += `${String(e.off).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`;
      }
      i = j + 1;
    }
    const size = Math.max(doc.context.largestObjectNumber + 1, prev!.size);
    body += `trailer\n<< /Size ${size} ${common} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(enc.encode(body));
  } else {
    // A cross-reference stream (the previous section is one too).
    const own = doc.context.nextRef().objectNumber;
    offsets.set(own, { off: xrefAt, gen: 0 });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const index: number[] = [];
    const rows: number[] = [];
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      index.push(nums[i], j - i + 1);
      for (let k = i; k <= j; k++) {
        const e = offsets.get(nums[k])!;
        rows.push(1, (e.off >>> 24) & 255, (e.off >>> 16) & 255, (e.off >>> 8) & 255, e.off & 255, (e.gen >>> 8) & 255, e.gen & 255);
      }
      i = j + 1;
    }
    const data = new Uint8Array(rows);
    push(enc.encode(`${own} 0 obj\n<< /Type /XRef /Size ${own + 1} /W [1 4 2] /Index [${index.join(' ')}] ${common} /Length ${data.length} >>\nstream\n`));
    push(data);
    push(enc.encode(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, written: changed.map(([r]) => r), start };
}

/** True when the PDF's catalog has /Perms /DocMDP (a certified document). */
export function catalogKey(doc: PDFDocument, key: string): unknown {
  return doc.catalog.get(PDFName.of(key));
}
