/**
 * A small, independent Standard-security-handler encryptor for test fixtures
 * (node:crypto for MD5 / SHA / AES, its own RC4 and writer). It shares no
 * code with src/lib/crypto, so decrypting its output checks the app against
 * the specification rather than against itself.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib';

export type Handler = 'rc4-40' | 'rc4-128' | 'aesv2' | 'aesv3-r5' | 'aesv3-r6';

export interface FixtureOptions {
  handler: Handler;
  userPassword: string;
  ownerPassword: string;
  p: number;
  /** V4/V5 only: leave /Type /Metadata streams in clear. */
  encryptMetadata?: boolean;
  /** Non-stream objects go into one encrypted object stream, with an (unencrypted) xref stream. */
  objectStreams?: boolean;
}

export interface Fixture {
  bytes: Uint8Array;
  opts: FixtureOptions;
  key: Buffer;
  id0: Buffer;
  encryptDict: string;
  size: number;
  root: string;
  info?: string;
}

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...b: Buffer[]) => createHash('md5').update(Buffer.concat(b)).digest();
const hash = (alg: string, ...b: Buffer[]) => createHash(alg).update(Buffer.concat(b)).digest();

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) % 256];
  }
  return out;
}

const pad32 = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1').subarray(0, 32), PAD]).subarray(0, 32);
const xor = (key: Buffer, i: number) => Buffer.from(key.map((b) => b ^ i));
const le32 = (p: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(p);
  return b;
};

function aes(bits: 128 | 256, key: Buffer, iv: Buffer, data: Buffer, padding: boolean): Buffer {
  const c = createCipheriv(`aes-${bits}-cbc`, key, iv);
  c.setAutoPadding(padding);
  return Buffer.concat([c.update(data), c.final()]);
}

/** ISO 32000-2 Algorithm 2.B. */
function hash2B(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = hash('sha256', pw, salt, udata);
  let e = Buffer.alloc(0);
  for (let round = 0; round < 64 || e[e.length - 1] > round - 32; round++) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, k, udata])));
    e = aes(128, k.subarray(0, 16), k.subarray(16, 32), k1, false);
    const mod = [...e.subarray(0, 16)].reduce((a, b) => a + b, 0) % 3;
    k = hash(['sha256', 'sha384', 'sha512'][mod], e);
  }
  return k.subarray(0, 32);
}

const hex = (b: Buffer) => `<${b.toString('hex')}>`;

interface Keys {
  key: Buffer;
  dict: string;
  stm: 'rc4' | 'aes128' | 'aes256';
}

function deriveKeys(o: FixtureOptions, id0: Buffer): Keys {
  const em = o.encryptMetadata !== false;
  if (o.handler === 'aesv3-r5' || o.handler === 'aesv3-r6') {
    const r6 = o.handler === 'aesv3-r6';
    const h = (pw: Buffer, salt: Buffer, u: Buffer) => (r6 ? hash2B(pw, salt, u) : hash('sha256', pw, salt, u));
    const key = randomBytes(32);
    const up = Buffer.from(o.userPassword, 'utf8');
    const op = Buffer.from(o.ownerPassword, 'utf8');
    const [uv, uk, ov, ok] = [randomBytes(8), randomBytes(8), randomBytes(8), randomBytes(8)];
    const none = Buffer.alloc(0);
    const U = Buffer.concat([h(up, uv, none), uv, uk]);
    const UE = aes(256, h(up, uk, none), Buffer.alloc(16), key, false);
    const O = Buffer.concat([h(op, ov, U), ov, ok]);
    const OE = aes(256, h(op, ok, U), Buffer.alloc(16), key, false);
    const block = Buffer.concat([le32(o.p), Buffer.from([255, 255, 255, 255]), Buffer.from(em ? 'Tadb' : 'Fadb', 'latin1'), randomBytes(4)]);
    const c = createCipheriv('aes-256-ecb', key, null);
    c.setAutoPadding(false);
    const perms = Buffer.concat([c.update(block), c.final()]);
    const dict = `<< /Filter /Standard /V 5 /R ${r6 ? 6 : 5} /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /P ${o.p} /O ${hex(O)} /U ${hex(U)} /OE ${hex(OE)} /UE ${hex(UE)} /Perms ${hex(perms)}${em ? '' : ' /EncryptMetadata false'} >>`;
    return { key, dict, stm: 'aes256' };
  }
  const r = o.handler === 'rc4-40' ? 2 : o.handler === 'rc4-128' ? 3 : 4;
  const n = r === 2 ? 5 : 16;
  // Algorithm 3: /O.
  let oh = md5(pad32(o.ownerPassword || o.userPassword));
  if (r >= 3) for (let i = 0; i < 50; i++) oh = md5(oh);
  const okey = oh.subarray(0, n);
  let O = rc4(okey, pad32(o.userPassword));
  if (r >= 3) for (let i = 1; i <= 19; i++) O = rc4(xor(okey, i), O);
  // Algorithm 2: the file key.
  let k = md5(pad32(o.userPassword), O, le32(o.p), id0, r >= 4 && !em ? Buffer.from([255, 255, 255, 255]) : Buffer.alloc(0));
  if (r >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
  const key = k.subarray(0, n);
  // Algorithms 4 / 5: /U.
  let U: Buffer;
  if (r === 2) U = rc4(key, PAD);
  else {
    let x = rc4(key, md5(PAD, id0));
    for (let i = 1; i <= 19; i++) x = rc4(xor(key, i), x);
    U = Buffer.concat([x, Buffer.alloc(16)]);
  }
  const base = `/Filter /Standard /O ${hex(O)} /U ${hex(U)} /P ${o.p}`;
  if (r === 2) return { key, dict: `<< ${base} /V 1 /R 2 >>`, stm: 'rc4' };
  if (r === 3) return { key, dict: `<< ${base} /V 2 /R 3 /Length 128 >>`, stm: 'rc4' };
  return {
    key,
    dict: `<< ${base} /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF${em ? '' : ' /EncryptMetadata false'} >>`,
    stm: 'aes128',
  };
}

function objectKey(k: Keys, num: number, gen: number): Buffer {
  if (k.stm === 'aes256') return k.key;
  const extra = k.stm === 'aes128' ? Buffer.from('sAlT', 'latin1') : Buffer.alloc(0);
  const tail = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  return md5(k.key, tail, extra).subarray(0, Math.min(k.key.length + 5, 16));
}

function encryptBytes(k: Keys, num: number, gen: number, data: Uint8Array): Buffer {
  const key = objectKey(k, num, gen);
  if (k.stm === 'rc4') return rc4(key, Buffer.from(data));
  const iv = randomBytes(16);
  return Buffer.concat([iv, aes(k.stm === 'aes128' ? 128 : 256, key, iv, Buffer.from(data), true)]);
}

function encryptStrings(obj: PDFObject, fn: (b: Uint8Array) => Buffer): PDFObject | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(fn(obj.asBytes()).toString('hex'));
  if (obj instanceof PDFDict) {
    for (const [key, v] of obj.entries()) {
      const rep = encryptStrings(v, fn);
      if (rep) obj.set(key, rep);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const rep = encryptStrings(obj.get(i), fn);
      if (rep) obj.set(i, rep);
    }
  }
  return undefined;
}

function bytesOf(obj: PDFObject): Buffer {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return Buffer.from(out);
}

/** Encrypts one indirect object; returns its bytes (with "N G obj" framing left to the caller). */
function encryptObject(k: Keys, o: FixtureOptions, ref: PDFRef, obj: PDFObject): Buffer {
  const fn = (b: Uint8Array) => encryptBytes(k, ref.objectNumber, ref.generationNumber, b);
  if (obj instanceof PDFStream) {
    encryptStrings(obj.dict, fn);
    const clear = o.encryptMetadata === false && obj.dict.get(PDFName.of('Type')) === PDFName.of('Metadata');
    const data = clear ? Buffer.from(obj.getContents()) : fn(obj.getContents());
    return bytesOf(PDFRawStream.of(obj.dict, data));
  }
  const rep = encryptStrings(obj, fn);
  return bytesOf(rep ?? obj);
}

const refText = (r: unknown) => (r instanceof PDFRef ? `${r.objectNumber} ${r.generationNumber} R` : undefined);

/** Encrypts a PDF written by pdf-lib (or anything pdf-lib can load) with the chosen handler. */
export async function encryptFixture(plain: Uint8Array, o: FixtureOptions): Promise<Fixture> {
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const ctx = doc.context;
  const id0 = randomBytes(16);
  const k = deriveKeys(o, id0);
  const objects = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  const encNum = ctx.largestObjectNumber + 1;
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = parts[0].length;
  const push = (b: Buffer) => {
    parts.push(b);
    pos += b.length;
  };
  const offsets = new Map<number, { type: 1 | 2; a: number; b: number }>();
  const writeObj = (num: number, gen: number, body: Buffer) => {
    offsets.set(num, { type: 1, a: pos, b: gen });
    push(Buffer.from(`${num} ${gen} obj\n`, 'latin1'));
    push(body);
    push(Buffer.from('\nendobj\n', 'latin1'));
  };
  const root = refText(ctx.trailerInfo.Root)!;
  const info = refText(ctx.trailerInfo.Info);
  writeObj(encNum, 0, Buffer.from(k.dict, 'latin1'));
  const trailerCommon = `/Root ${root}${info ? ` /Info ${info}` : ''} /Encrypt ${encNum} 0 R /ID [${hex(id0)} ${hex(id0)}]`;

  if (!o.objectStreams) {
    for (const [ref, obj] of objects) writeObj(ref.objectNumber, ref.generationNumber, encryptObject(k, o, ref, obj));
    const size = encNum + 1;
    const xrefAt = pos;
    let xref = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
    for (let i = 1; i < size; i++) {
      const e = offsets.get(i);
      xref += e ? `${String(e.a).padStart(10, '0')} ${String(e.b).padStart(5, '0')} n\r\n` : '0000000000 00000 f\r\n';
    }
    push(Buffer.from(`${xref}trailer\n<< /Size ${size} ${trailerCommon} >>\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'));
  } else {
    const packed: Array<[number, Buffer]> = [];
    for (const [ref, obj] of objects) {
      if (obj instanceof PDFStream || ref.generationNumber !== 0) writeObj(ref.objectNumber, ref.generationNumber, encryptObject(k, o, ref, obj));
      else packed.push([ref.objectNumber, bytesOf(obj)]);
    }
    const stmNum = encNum + 1;
    let header = '';
    const bodies: Buffer[] = [];
    let off = 0;
    packed.forEach(([n, b], i) => {
      header += `${n} ${off} `;
      bodies.push(b, Buffer.from('\n'));
      off += b.length + 1;
      offsets.set(n, { type: 2, a: stmNum, b: i });
    });
    const content = Buffer.concat([Buffer.from(header, 'latin1'), ...bodies]);
    const enc = encryptBytes(k, stmNum, 0, content);
    writeObj(stmNum, 0, Buffer.concat([Buffer.from(`<< /Type /ObjStm /N ${packed.length} /First ${Buffer.byteLength(header)} /Length ${enc.length} >>\nstream\n`, 'latin1'), enc, Buffer.from('\nendstream', 'latin1')]));
    const xrefNum = stmNum + 1;
    const size = xrefNum + 1;
    offsets.set(xrefNum, { type: 1, a: pos, b: 0 });
    const rows: number[] = [];
    for (let i = 0; i < size; i++) {
      const e = offsets.get(i);
      const t = e ? e.type : 0;
      const a = e ? e.a : 0;
      const b = e ? e.b : i === 0 ? 65535 : 0;
      rows.push(t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255);
    }
    const data = Buffer.from(rows);
    const xrefAt = pos;
    push(Buffer.from(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] ${trailerCommon} /Length ${data.length} >>\nstream\n`, 'latin1'));
    push(data);
    push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'));
    return { bytes: new Uint8Array(Buffer.concat(parts)), opts: o, key: k.key, id0, encryptDict: k.dict, size, root, info };
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), opts: o, key: k.key, id0, encryptDict: k.dict, size: encNum + 1, root, info };
}

/** Appends an incremental update (classic xref) with `objects` encrypted like the rest of the fixture. */
export function appendUpdate(f: Fixture, objects: Array<[PDFRef, PDFObject]>): Fixture {
  const prevAt = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(Buffer.from(f.bytes).toString('latin1'))![1]);
  const k = deriveKeysFrom(f);
  const parts: Buffer[] = [Buffer.from(f.bytes)];
  let pos = f.bytes.length;
  const lines: string[] = [];
  for (const [ref, obj] of objects) {
    const body = encryptObject(k, f.opts, ref, obj);
    lines.push(`${ref.objectNumber} 1\n${String(pos).padStart(10, '0')} ${String(ref.generationNumber).padStart(5, '0')} n\r\n`);
    const b = Buffer.concat([Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    pos += b.length;
  }
  const encNum = /\/Encrypt (\d+) 0 R/.exec(Buffer.from(f.bytes).toString('latin1'))![1];
  const trailer = `trailer\n<< /Size ${f.size} /Root ${f.root}${f.info ? ` /Info ${f.info}` : ''} /Encrypt ${encNum} 0 R /ID [${hex(f.id0)} ${hex(f.id0)}] /Prev ${prevAt} >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(`xref\n${lines.join('')}${trailer}`, 'latin1'));
  return { ...f, bytes: new Uint8Array(Buffer.concat(parts)) };
}

function deriveKeysFrom(f: Fixture): Keys {
  const stm = f.opts.handler.startsWith('rc4') ? 'rc4' : f.opts.handler === 'aesv2' ? 'aes128' : 'aes256';
  return { key: f.key, dict: f.encryptDict, stm };
}
