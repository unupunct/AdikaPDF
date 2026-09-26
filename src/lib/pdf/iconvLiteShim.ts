// Browser stand-in for `iconv-lite`, which @kenjiuno/msgreader imports for
// PT_STRING8 (ANSI) properties. The real iconv-lite needs Node's Buffer (via
// safer-buffer) and crashes on load in a browser bundle, so vite.config.ts
// aliases `iconv-lite` to this module. Only decode() matters for reading.

function normalise(label: string): string {
  const l = label.trim().toLowerCase();
  const cp = /^(?:cp|windows-?)(\d{3,5})$/.exec(l);
  if (cp) {
    const n = Number(cp[1]);
    if (n === 65001) return 'utf-8';
    if (n >= 28591 && n <= 28606) return `iso-8859-${n - 28590}`;
    if (n === 932) return 'shift_jis';
    if (n === 936) return 'gbk';
    if (n === 949) return 'euc-kr';
    if (n === 950) return 'big5';
    return `windows-${n}`;
  }
  return l;
}

export function decode(bytes: ArrayLike<number>, encoding: string): string {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  try {
    return new TextDecoder(normalise(encoding)).decode(u8);
  } catch {
    return new TextDecoder('windows-1252').decode(u8);
  }
}

export function encode(text: string, encoding: string): Uint8Array {
  const label = normalise(encoding);
  if (label === 'utf-8' || label === 'utf8') return new TextEncoder().encode(text);
  // Single-byte fallback: code points above 0xFF become '?'.
  return Uint8Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 256 ? code : 0x3f;
  });
}

export function encodingExists(encoding: string): boolean {
  try {
    new TextDecoder(normalise(encoding));
    return true;
  } catch {
    return false;
  }
}

export default { decode, encode, encodingExists };
