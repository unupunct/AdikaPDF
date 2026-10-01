/**
 * CCITT Group 4 (ITU-T T.6) encoder for black-and-white pages: each line is
 * coded against the line above it, so text scans shrink to a fraction of
 * their size (PDF /CCITTFaxDecode, K = -1). Input: one byte per pixel,
 * 1 = black.
 */

// Run-length codes of T.4 (shared by T.6 horizontal mode).
const WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011',
  '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011',
];
const BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
];
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010',
  '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101',
];
/** 1792 … 2560, both colours. */
const EXT_MAKEUP = ['00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111'];

const VERTICAL: Record<number, string> = { [-3]: '0000010', [-2]: '000010', [-1]: '010', 0: '1', 1: '011', 2: '000011', 3: '0000011' };

class BitWriter {
  private buf: number[] = [];
  private acc = 0;
  private n = 0;
  put(code: string): void {
    for (let i = 0; i < code.length; i++) {
      this.acc = (this.acc << 1) | (code.charCodeAt(i) === 49 ? 1 : 0);
      if (++this.n === 8) {
        this.buf.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  bytes(): Uint8Array {
    if (this.n) this.buf.push(this.acc << (8 - this.n));
    return Uint8Array.from(this.buf);
  }
}

function putRun(w: BitWriter, run: number, black: boolean): void {
  const term = black ? BLACK_TERM : WHITE_TERM;
  const makeup = black ? BLACK_MAKEUP : WHITE_MAKEUP;
  while (run >= 2560) {
    w.put(EXT_MAKEUP[12]);
    run -= 2560;
  }
  if (run >= 64) {
    const m = Math.floor(run / 64) * 64;
    w.put(m >= 1792 ? EXT_MAKEUP[(m - 1792) / 64] : makeup[m / 64 - 1]);
    run -= m;
  }
  w.put(term[run]);
}

/** Pixel colour, with white before the line start. */
const at = (line: Uint8Array, x: number) => (x < 0 ? 0 : line[x]);

/** First changing element after position `a` whose colour is `color` (w when none). */
function changing(line: Uint8Array, w: number, a: number, color: number): number {
  for (let x = Math.max(0, a + 1); x < w; x++) if (line[x] === color && at(line, x - 1) !== color) return x;
  return w;
}

export function encodeG4(bits: Uint8Array, width: number, height: number): Uint8Array {
  const out = new BitWriter();
  let ref = new Uint8Array(width); // imaginary white line above the page
  for (let y = 0; y < height; y++) {
    const cur = bits.subarray(y * width, (y + 1) * width);
    let a0 = -1;
    let color = 0; // white
    while (a0 < width) {
      const a1 = changing(cur, width, a0, 1 - color);
      const b1 = changing(ref, width, a0, 1 - color);
      const b2 = b1 < width ? changing(ref, width, b1, color) : width;
      if (b2 < a1) {
        out.put('0001'); // pass
        a0 = b2;
      } else if (Math.abs(a1 - b1) <= 3) {
        out.put(VERTICAL[a1 - b1]);
        a0 = a1;
        color = 1 - color;
      } else {
        const a2 = a1 < width ? changing(cur, width, a1, color) : width;
        out.put('001'); // horizontal
        putRun(out, a1 - Math.max(0, a0), color === 1);
        putRun(out, a2 - a1, color === 0);
        a0 = a2;
      }
    }
    ref = cur.slice();
  }
  out.put('000000000001000000000001'); // EOFB
  return out.bytes();
}

/** 1-bit PDF image of the bitmap: Group 4 when that is smaller than packed bits with Flate. */
export function bitmapStreamParts(bits: Uint8Array, width: number, height: number): { data: Uint8Array; filter: 'CCITTFaxDecode'; parms: { K: number; Columns: number; Rows: number; BlackIs1: boolean } } {
  return { data: encodeG4(bits, width, height), filter: 'CCITTFaxDecode', parms: { K: -1, Columns: width, Rows: height, BlackIs1: false } };
}
