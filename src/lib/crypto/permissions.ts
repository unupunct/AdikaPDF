import type { PdfPermissions } from './encrypt';

/** The permissions in /P (ISO 32000-2 Table 22); R2 files only know bits 3–6. */
export function permissionsFromP(p: number, r: number): PdfPermissions {
  const bit = (n: number) => (p & (1 << (n - 1))) !== 0;
  const legacy = r < 3;
  return {
    print: bit(3),
    modify: bit(4),
    copy: bit(5),
    annotate: bit(6),
    fillForms: legacy ? bit(6) : bit(9),
    extractForAccessibility: legacy ? bit(5) : bit(10),
    assemble: legacy ? bit(4) : bit(11),
    printHighQuality: legacy ? bit(3) : bit(12),
  };
}
