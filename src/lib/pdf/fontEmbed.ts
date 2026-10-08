/**
 * Font embedding that works around pdf-lib's broken subsetter.
 *
 * `embedFont(bytes, { subset: true })` (fontkit's createSubset) writes corrupt
 * glyph data for Noto fonts: text still extracts, but viewers draw only some
 * of the letters. Instead we embed the font *unsubset* (so pdf-lib encodes by
 * real glyph ids), after emptying every glyph outline the document does not
 * use. Glyph ids, metrics and cmap stay identical, so files stay small and
 * render correctly everywhere.
 */
import { PDFDocument, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/**
 * Embeds `fontBytes` into `doc`, keeping outlines only for glyphs used by
 * `texts` (`prune: false` embeds the whole font, for licences that forbid subsetting).
 */
export async function embedFontForText(doc: PDFDocument, fontBytes: Uint8Array, texts: Iterable<string>, opts: { prune?: boolean } = {}): Promise<PDFFont> {
  if (opts.prune === false) return doc.embedFont(fontBytes, { subset: false });
  const scratch = await PDFDocument.create();
  scratch.registerFontkit(fontkit);
  const measuring = await scratch.embedFont(fontBytes, { subset: false });
  const gids = new Set<number>();
  for (const t of texts) {
    if (!t) continue;
    const hex = measuring.encodeText(t).toString().replace(/[<>]/g, '');
    for (let i = 0; i + 4 <= hex.length; i += 4) gids.add(parseInt(hex.slice(i, i + 4), 16));
  }
  let bytes = fontBytes;
  try {
    bytes = pruneTrueType(fontBytes, gids);
  } catch {
    bytes = fontBytes; // unusual font structure: embed it whole rather than fail
  }
  return doc.embedFont(bytes, { subset: false });
}

// ---------------------------------------------------------------------------
// TrueType glyph pruning
// ---------------------------------------------------------------------------

const KEEP_TABLES = new Set(['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'glyf', 'loca', 'cvt ', 'fpgm', 'prep', 'gasp']);

/**
 * Returns a copy of a TrueType font in which every glyph outside `keep` (plus
 * .notdef and composite components) is empty and layout tables are dropped.
 * Glyph ids, metrics and cmap are unchanged, so text encoded against the full
 * font stays valid. CFF (OTTO) fonts are returned unchanged.
 */
export function pruneTrueType(src: Uint8Array, keep: Set<number>): Uint8Array {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const version = dv.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565) return src;
  const numTables = dv.getUint16(4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16;
    const tag = String.fromCharCode(src[e], src[e + 1], src[e + 2], src[e + 3]);
    tables.set(tag, { off: dv.getUint32(e + 8), len: dv.getUint32(e + 12) });
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp || !loca || !glyf) return src;
  const longLoca = dv.getInt16(head.off + 50) === 1;
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const locaAt = (g: number) => (longLoca ? dv.getUint32(loca.off + g * 4) : dv.getUint16(loca.off + g * 2) * 2);
  const glyphRange = (g: number): [number, number] => [glyf.off + locaAt(g), glyf.off + locaAt(g + 1)];

  const wanted = new Set<number>();
  const queue = [0, ...[...keep].filter((g) => g >= 0 && g < numGlyphs)];
  while (queue.length) {
    const g = queue.pop() as number;
    if (wanted.has(g)) continue;
    wanted.add(g);
    const [a, b] = glyphRange(g);
    if (b - a < 10 || dv.getInt16(a) >= 0) continue;
    // Composite glyph: queue its components.
    let o = a + 10;
    for (let guard = 0; guard < 64 && o + 4 <= b; guard++) {
      const flags = dv.getUint16(o);
      const comp = dv.getUint16(o + 2);
      if (comp < numGlyphs && !wanted.has(comp)) queue.push(comp);
      o += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      if (!(flags & 0x20)) break;
    }
  }

  const glyphParts: Uint8Array[] = [];
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    locaView.setUint32(g * 4, pos);
    if (!wanted.has(g)) continue;
    const [a, b] = glyphRange(g);
    if (b <= a) continue;
    const len = (b - a + 3) & ~3;
    const part = new Uint8Array(len);
    part.set(src.subarray(a, b));
    glyphParts.push(part);
    pos += len;
  }
  locaView.setUint32(numGlyphs * 4, pos);
  const newGlyf = new Uint8Array(pos);
  let w = 0;
  for (const part of glyphParts) {
    newGlyf.set(part, w);
    w += part.length;
  }
  const newHead = src.slice(head.off, head.off + head.len);
  const headView = new DataView(newHead.buffer);
  headView.setUint32(8, 0); // checkSumAdjustment
  headView.setInt16(50, 1); // long loca
  // post format 3 (no glyph names): the names of 4,000+ glyphs are dead weight.
  const post = tables.get('post');
  const newPost = post && post.len >= 32 ? src.slice(post.off, post.off + 32) : undefined;
  if (newPost) new DataView(newPost.buffer).setUint32(0, 0x00030000);

  const out = new Map<string, Uint8Array>();
  for (const [tag, t] of tables) {
    if (!KEEP_TABLES.has(tag)) continue;
    out.set(tag, tag === 'glyf' ? newGlyf : tag === 'loca' ? newLoca : tag === 'head' ? newHead : tag === 'post' && newPost ? newPost : src.subarray(t.off, t.off + t.len));
  }
  const tags = [...out.keys()].sort();
  const n = tags.length;
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= n) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  let size = 12 + n * 16;
  for (const t of tags) size += ((out.get(t)?.length ?? 0) + 3) & ~3;
  const buf = new Uint8Array(size);
  const bv = new DataView(buf.buffer);
  bv.setUint32(0, 0x00010000);
  bv.setUint16(4, n);
  bv.setUint16(6, searchRange);
  bv.setUint16(8, entrySelector);
  bv.setUint16(10, n * 16 - searchRange);
  let off = 12 + n * 16;
  tags.forEach((tag, i) => {
    const data = out.get(tag) ?? new Uint8Array();
    buf.set(data, off);
    let sum = 0;
    for (let k = 0; k < data.length; k += 4) {
      const word = ((data[k] << 24) | ((data[k + 1] ?? 0) << 16) | ((data[k + 2] ?? 0) << 8) | (data[k + 3] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    const e = 12 + i * 16;
    for (let k = 0; k < 4; k++) buf[e + k] = tag.charCodeAt(k);
    bv.setUint32(e + 4, sum);
    bv.setUint32(e + 8, off);
    bv.setUint32(e + 12, data.length);
    off += (data.length + 3) & ~3;
  });
  return buf;
}
