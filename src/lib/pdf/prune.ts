/**
 * Drops every indirect object the saved file no longer references.
 *
 * pdf-lib writes *all* objects it loaded, so a page that was deleted,
 * replaced by a raster (redaction) or had its content rewritten would stay in
 * the file as an orphan — and its text could be recovered with any PDF tool.
 */
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFStream } from 'pdf-lib';

export function dropUnreachableObjects(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID];
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      const key = v.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(ctx.lookup(v));
    } else if (v instanceof PDFDict) {
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFStream) {
      stack.push(v.dict);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (seen.has(ref.toString())) continue;
    ctx.delete(ref);
    dropped++;
  }
  return dropped;
}
