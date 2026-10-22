/** Hand-written PDFs for engine tests (damaged or unusual structures). */
/** A PDF from object bodies (numbered from 1) with a correct cross-reference table. */
export function rawPdf(objects: string[], trailer = '/Root 1 0 R'): Uint8Array {
  let s = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(s.length);
    s += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) s += `${String(o).padStart(10, '0')} 00000 n \n`;
  s += `trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

export const stream = (content: string, dict = '') => `<< /Length ${content.length} ${dict}>>\nstream\n${content}\nendstream`;
