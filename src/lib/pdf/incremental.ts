/**
 * Incremental updates: new and changed objects are appended after the
 * original bytes (with a new cross-reference section pointing back to the
 * previous one), so everything before stays byte for byte identical and
 * existing digital signatures remain valid.
 */
import { PDFDocument, PDFName, PDFRef, type PDFObject } from 'pdf-lib';

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

/** Offset of the last cross-reference section, whether it is a stream, and its /Size. */
function lastXref(bytes: Uint8Array): { offset: number; stream: boolean; size: number } {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error('This PDF has no cross-reference table, so it cannot be updated incrementally.');
  const offset = Number(m[1]);
  const head = new TextDecoder('latin1').decode(bytes.subarray(offset, offset + 64));
  const stream = !/^\s*xref/.test(head);
  // The trailer (or xref stream dictionary) of that section: its /Size.
  const section = new TextDecoder('latin1').decode(bytes.subarray(offset, Math.min(bytes.length, offset + (stream ? 1024 : bytes.length - offset))));
  const sm = stream ? /\/Size\s+(\d+)/.exec(section) : /trailer[\s\S]*?\/Size\s+(\d+)/.exec(section);
  return { offset, stream, size: sm ? Number(sm[1]) : 0 };
}

export interface IncrementalResult {
  bytes: Uint8Array;
  /** Objects written in the update (new or changed). */
  written: PDFRef[];
  /** Byte offset where the update starts. */
  start: number;
}

/**
 * Loads `original`, lets `edit` change it with pdf-lib, then appends only
 * what changed. Encrypted files are refused (their objects would need
 * encrypting).
 */
export async function incrementalUpdate(original: Uint8Array, edit: (doc: PDFDocument) => void | Promise<void>): Promise<IncrementalResult> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  if (doc.context.trailerInfo.Encrypt) throw new Error('Encrypted PDFs cannot be updated incrementally.');
  const prev = lastXref(original);
  // pdf-lib does not count object-stream containers or the xref stream itself:
  // new objects must be numbered above everything the file already uses.
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, prev.size - 1);
  const before = new Map<string, Uint8Array>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) before.set(ref.toString(), objBytes(obj));
  await edit(doc);
  await doc.flush();

  const changed: Array<[PDFRef, Uint8Array]> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const b = objBytes(obj);
    const old = before.get(ref.toString());
    if (!old || !sameBytes(old, b)) changed.push([ref, b]);
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
  const common = [`/Root ${refText(trailer.Root)}`, trailer.Info ? `/Info ${refText(trailer.Info)}` : '', idText ? `/ID ${idText}` : '', `/Prev ${prev.offset}`].filter(Boolean).join(' ');

  const xrefAt = pos;
  if (!prev.stream) {
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
    const size = Math.max(doc.context.largestObjectNumber + 1, prev.size);
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
