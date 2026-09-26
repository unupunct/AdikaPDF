import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { burn, type Entry } from '@kenjiuno/msgreader/lib/Burner';
import { TypeEnum } from '@kenjiuno/msgreader/lib/Reader';
import {
  deEncapsulateHtmlFromRtf,
  emailToHtml,
  linkifyText,
  sanitizeHtml,
  type SanitizeContext,
} from '../src/lib/pdf/email';
import { outlookMakeMsg, scratchPath } from './helpers/office';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const enc = new TextEncoder();

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

function makeEml(): Uint8Array {
  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<base href="https://evil.example/">
<link rel="stylesheet" href="https://tracker.example/s.css">
<style>body { background: url(https://tracker.example/bg.png) } p.x { color: red }</style>
<script>alert('head')</script>
</head><body onload="steal()">
<p class="x">Bună ziua, <b>Ștefan</b>! Țară, pâine, înțeles.</p>
<img src="cid:logo123@adika" alt="logo">
<img src="https://tracker.example/pixel.gif" width="1" height="1">
<a href="javascript:alert(1)">rău</a> <a href="https://example.com/ok" onclick="x()">bun</a>
<a href="&#106;avascript:alert(2)">entitate</a>
<iframe src="https://evil.example/frame"></iframe>
<form action="https://evil.example/post"><input name="p" value="secret"><button>Trimite</button></form>
<object data="x.swf"></object><embed src="y.swf">
<script type="text/javascript">document.write('body')</script>
<div style="width: expression(alert(1)); background-image: url('https://tracker.example/d.png')">stil</div>
</body></html>`;
  const lines = [
    'From: =?UTF-8?Q?=C8=98tefan_Popescu?= <stefan@example.ro>',
    'To: Ana <ana@example.ro>, bob@example.com',
    'Cc: "Ioana" <ioana@example.ro>',
    'Subject: =?UTF-8?Q?Raport_=C8=99i_=C8=9Bar=C4=83_=E2=80=94_test?=',
    'Date: Fri, 26 Sep 2026 14:03:00 +0300',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    '--REL',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo123@adika>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    PNG_1x1,
    '--REL--',
    '--MIX',
    'Content-Type: text/plain; charset=iso-8859-2; name="notite.txt"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename*=UTF-8\'\'noti%C8%9Be%20%C3%AEnt%C3%A2lnire.txt',
    '',
    Buffer.from('continut atasament\r\n').toString('base64'),
    '--MIX--',
    '',
  ];
  return enc.encode(lines.join('\r\n'));
}

describe('emailToHtml (.eml)', () => {
  it('renders header, sanitises the body, inlines cid images and lists attachments', async () => {
    const r = await emailToHtml(makeEml(), 'mesaj.eml');
    expect(r.subject).toBe('Raport și țară — test');
    const h = r.html;
    expect(h.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(h).toContain('@page { margin: 15mm }');
    expect(h).toContain('<th>From</th><td>Ștefan Popescu &lt;stefan@example.ro&gt;</td>');
    expect(h).toContain('<th>To</th><td>Ana &lt;ana@example.ro&gt;, bob@example.com</td>');
    expect(h).toContain('<th>Cc</th><td>Ioana &lt;ioana@example.ro&gt;</td>');
    expect(h).toContain('<th>Date</th><td>');
    expect(h).toContain('Raport și țară — test');
    expect(h).toContain('Bună ziua, <b>Ștefan</b>! Țară, pâine, înțeles.');
    // cid -> data URI
    expect(h).not.toContain('cid:');
    expect(h).toContain(`src="data:image/png;base64,${PNG_1x1}"`);
    // active content removed
    expect(h).not.toMatch(/<script/i);
    expect(h).not.toContain('alert(');
    expect(h).not.toMatch(/\son[a-z]+=/i);
    expect(h).not.toMatch(/javascript:/i);
    expect(h).not.toMatch(/<iframe|<object|<embed|<form|<input|<button|<base/i);
    expect(h).not.toContain('http-equiv="refresh"');
    expect(h).not.toContain('expression(');
    expect(h).not.toContain('secret');
    // remote content blocked
    expect(h).not.toContain('tracker.example');
    expect(h).toContain('[remote image blocked]');
    expect(h).toMatch(/Remote content blocked for privacy \(\d+ items\)/);
    // plain links survive
    expect(h).toContain('href="https://example.com/ok"');
    // attachments
    expect(r.attachments).toHaveLength(2);
    const logo = r.attachments.find((a) => a.name === 'logo.png')!;
    expect(logo.inline).toBe(true);
    expect(logo.mime).toBe('image/png');
    const note = r.attachments.find((a) => !a.inline)!;
    expect(note.name).toBe('notițe întâlnire.txt');
    expect(new TextDecoder().decode(note.bytes)).toBe('continut atasament\r\n');
    expect(h).toContain('<h2>Attachments (1)</h2>');
    expect(h).toContain('notițe întâlnire.txt <span class="size">(20 B)</span>');
    expect(h).not.toMatch(/<li>logo\.png/);
  });

  it('keeps remote images when allowed', async () => {
    const r = await emailToHtml(makeEml(), 'mesaj.eml', { allowRemoteImages: true });
    expect(r.html).toContain('src="https://tracker.example/pixel.gif"');
    expect(r.html).not.toContain('[remote image blocked]');
    expect(r.html).not.toContain('Remote content blocked');
    expect(r.html).not.toMatch(/<script/i);
  });

  it('renders plain-text bodies escaped and linkified', async () => {
    const eml = [
      'From: a@example.com',
      'Subject: =?ISO-8859-2?Q?Salut_=BAi_=FEar=E3?=',
      'Content-Type: text/plain; charset=iso-8859-2',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Vezi https://example.com/a?b=3D1&c=3D2. <b>nu e html</b>',
      '=FEar=E3 =BAi p=E2ine',
      '',
    ].join('\r\n');
    const r = await emailToHtml(enc.encode(eml), 'x.eml');
    expect(r.subject).toBe('Salut şi ţară');
    expect(r.html).toContain('<pre class="adika-plain" style="white-space:pre-wrap">');
    expect(r.html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>.');
    expect(r.html).toContain('&lt;b&gt;nu e html&lt;/b&gt;');
    expect(r.html).toContain('ţară şi pâine');
  });
});

describe('sanitizer and helpers', () => {
  const ctx = (): SanitizeContext => ({ allowRemote: false, blocked: 0, resolveRef: () => null });
  it('strips obfuscated scripts and dangerous URLs', () => {
    const c = ctx();
    const out = sanitizeHtml(
      '<svg><a xlink:href="java&#x09;script:x()">s</a></svg><IMG SRC="  JaVaScRiPt:alert(1)" ONERROR=alert(2)>' +
        '<scr<script>ipt>alert(3)</script><a href="data:text/html;base64,PHNjcmlwdD4=">d</a><p title=\'a"b\'>ok</p>',
      c,
    );
    expect(out).not.toMatch(/javascript|onerror|<script|data:text\/html/i);
    expect(out).toContain('<p title="a&quot;b">ok</p>');
  });
  it('linkifies text', () => {
    expect(linkifyText('see (www.example.org), <x>')).toBe(
      'see (<a href="https://www.example.org" rel="noopener noreferrer">www.example.org</a>), &lt;x&gt;',
    );
  });
  it('de-encapsulates HTML from RTF', () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}' +
      '{\\*\\htmltag19 <html>}{\\*\\htmltag34 <body>}\\htmlrtf {\\htmlrtf0 ' +
      '{\\*\\htmltag64 <p>}Bun\\u259?\\htmlrtf ?\\htmlrtf0  ziua {\\*\\htmltag84 &amp;}\\htmlrtf &\\htmlrtf0  \\\'e9t\\\'e9' +
      '{\\*\\htmltag72 </p>}\\htmlrtf }\\htmlrtf0 {\\*\\htmltag42 </body>}{\\*\\htmltag27 </html>}}';
    const html = deEncapsulateHtmlFromRtf(enc.encode(rtf));
    expect(html).toBe('<html><body><p>Bună ziua &amp; été</p></body></html>');
    expect(deEncapsulateHtmlFromRtf(enc.encode('{\\rtf1\\ansi plain}'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// .msg: crafted with msgreader's own CFB burner (Outlook COM is used as well
// when it is reachable from this process).
// ---------------------------------------------------------------------------

const utf16 = (s: string) => new Uint8Array(Buffer.from(s + '\0', 'utf16le'));

function props(headerLen: number, list: Array<{ tag: number; value: Uint8Array }>): Uint8Array {
  const buf = new Uint8Array(headerLen + list.length * 16);
  const dv = new DataView(buf.buffer);
  list.forEach((p, i) => {
    const o = headerLen + i * 16;
    dv.setUint32(o, p.tag, true);
    dv.setUint32(o + 4, 6, true); // readable | writable
    buf.set(p.value.subarray(0, 8), o + 8);
  });
  return buf;
}
const u32 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
function filetime(d: Date): Uint8Array {
  const b = new Uint8Array(8);
  const ft = BigInt(d.getTime()) * 10000n + 116444736000000000n;
  new DataView(b.buffer).setBigUint64(0, ft, true);
  return b;
}

interface Node {
  name: string;
  data?: Uint8Array;
  children?: Node[];
}

function burnTree(children: Node[]): Uint8Array {
  const entries: Entry[] = [{ name: 'Root Entry', type: TypeEnum.ROOT, children: [], length: 0 }];
  const add = (parent: number, nodes: Node[]) => {
    for (const n of nodes) {
      const idx = entries.length;
      entries[parent].children!.push(idx);
      if (n.children) {
        entries.push({ name: n.name, type: TypeEnum.DIRECTORY, children: [], length: 0 });
        add(idx, n.children);
      } else {
        const data = n.data!;
        entries.push({ name: n.name, type: TypeEnum.DOCUMENT, length: data.length, binaryProvider: () => data });
      }
    }
  };
  add(0, children);
  return burn(entries);
}

function makeMsg(body: 'html' | 'rtf'): Uint8Array {
  const s = (id: string, v: string): Node => ({ name: `__substg1.0_${id}001F`, data: utf16(v) });
  const bin = (id: string, v: Uint8Array): Node => ({ name: `__substg1.0_${id}0102`, data: v });
  const html = `<html><head><style>p{color:#333}</style></head><body><p>Salut <b>Ștefan</b>, țară și pâine.</p><img src="cid:img001@x"><script>alert(1)</script></body></html>`;
  const rtfText =
    '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0 Arial;}}{\\*\\htmltag19 <html>}{\\*\\htmltag34 <body>}' +
    '{\\*\\htmltag64 <p>}Din RTF: \\u537?\\u539?\\htmlrtf  \\htmlrtf0{\\*\\htmltag72 </p>}' +
    '{\\*\\htmltag0 <script>alert(1)</script>}{\\*\\htmltag42 </body>}{\\*\\htmltag27 </html>}}';
  const raw = enc.encode(rtfText);
  const mela = new Uint8Array(16 + raw.length);
  const dv = new DataView(mela.buffer);
  dv.setUint32(0, raw.length + 12, true);
  dv.setUint32(4, raw.length, true);
  dv.setUint32(8, 0x414c454d, true);
  mela.set(raw, 16);
  const recip = (i: number, name: string, email: string, type: number): Node => ({
    name: `__recip_version1.0_#0000000${i}`,
    children: [s('3001', name), s('3003', email), { name: '__properties_version1.0', data: props(8, [{ tag: 0x0c150003, value: u32(type) }]) }],
  });
  const attach = (i: number, name: string, mime: string, data: Uint8Array, cid?: string): Node => ({
    name: `__attach_version1.0_#0000000${i}`,
    children: [
      s('3707', name),
      s('370E', mime),
      ...(cid ? [s('3712', cid)] : []),
      bin('3701', data),
      { name: '__properties_version1.0', data: props(8, [{ tag: 0x37050003, value: u32(1) }]) },
    ],
  });
  return burnTree([
    s('0037', 'Întâlnire: plan și buget'),
    s('0C1A', 'Ștefan Popescu'),
    s('5D01', 'stefan@example.ro'),
    s('1000', 'Salut Ștefan, țară și pâine.'),
    ...(body === 'html' ? [bin('1013', enc.encode(html))] : [bin('1009', mela)]),
    {
      name: '__properties_version1.0',
      data: props(32, [
        { tag: 0x0e060040, value: filetime(new Date('2026-09-26T11:03:00Z')) },
        { tag: 0x3fde0003, value: u32(65001) },
      ]),
    },
    recip(0, 'Ana Ionescu', 'ana@example.ro', 1),
    recip(1, 'Ioana', 'ioana@example.ro', 2),
    attach(0, 'image001.png', 'image/png', new Uint8Array(Buffer.from(PNG_1x1, 'base64')), 'img001@x'),
    attach(1, 'buget 2026.txt', 'text/plain', enc.encode('linia 1\r\nlinia 2')),
  ]);
}

describe('emailToHtml (.msg)', () => {
  it('parses an Outlook message with HTML body, recipients and attachments', async () => {
    const msg = makeMsg('html');
    // Kept in scratch so the Vite-bundled parser can be smoke-tested too.
    writeFileSync(scratchPath('crafted-html.msg'), msg);
    const r = await emailToHtml(msg, 'plan.msg');
    expect(r.subject).toBe('Întâlnire: plan și buget');
    const h = r.html;
    expect(h).toContain('<th>From</th><td>Ștefan Popescu &lt;stefan@example.ro&gt;</td>');
    expect(h).toContain('<th>To</th><td>Ana Ionescu &lt;ana@example.ro&gt;</td>');
    expect(h).toContain('<th>Cc</th><td>Ioana &lt;ioana@example.ro&gt;</td>');
    expect(h).toContain('<p>Salut <b>Ștefan</b>, țară și pâine.</p>');
    expect(h).toContain(`src="data:image/png;base64,${PNG_1x1}"`);
    expect(h).not.toMatch(/<script|alert\(/);
    expect(r.attachments.map((a) => [a.name, a.inline])).toEqual([
      ['image001.png', true],
      ['buget 2026.txt', false],
    ]);
    expect(h).toContain('<li>buget 2026.txt <span class="size">(16 B)</span></li>');
    expect(h).toMatch(/<th>Date<\/th><td>[^<]*2026/);
  });

  it('de-encapsulates HTML from a compressed-RTF-only body', async () => {
    const r = await emailToHtml(makeMsg('rtf'), 'plan.msg');
    expect(r.html).toContain('<p>Din RTF: șț</p>');
    expect(r.html).not.toMatch(/<script|alert\(/);
  });

  it('decodes non-Unicode (PT_STRING8) properties with the message code page', async () => {
    // "Întâlnire şi ţară" in windows-1250 (cedilla forms exist in cp1250).
    const subject = new Uint8Array([0xce, ...enc.encode('nt'), 0xe2, ...enc.encode('lnire '), 0xba, 0x69, 0x20, 0xfe, 0x61, 0x72, 0xe3, 0]);
    const msg = burnTree([
      { name: '__substg1.0_0037001E', data: subject },
      { name: '__substg1.0_1000001E', data: new Uint8Array([0xfe, 0x61, 0x72, 0xe3, 0]) },
      { name: '__properties_version1.0', data: props(32, [{ tag: 0x3ffd0003, value: u32(1250) }]) },
    ]);
    writeFileSync(scratchPath('crafted-ansi.msg'), msg);
    const r = await emailToHtml(msg, 'ansi.msg');
    expect(r.subject).toBe('Întâlnire şi ţară');
    expect(r.html).toContain('<pre class="adika-plain" style="white-space:pre-wrap">ţară</pre>');
  });

  // Opt-in: activating Outlook COM next to a running (differently elevated)
  // Outlook hangs or fails with CO_E_SERVER_EXEC_FAILURE and can raise the
  // Outlook security prompt in the user's session. Set ADIKA_TEST_OUTLOOK=1.
  it('parses a .msg created by Outlook (COM)', async (ctx) => {
    if (process.env.ADIKA_TEST_OUTLOOK !== '1') ctx.skip('Outlook COM test is opt-in (set ADIKA_TEST_OUTLOOK=1)');
    const att = scratchPath('outlook-att.txt');
    writeFileSync(att, 'atasament outlook');
    const msgPath = scratchPath('outlook-test.msg');
    const made = outlookMakeMsg(msgPath, att);
    if (!made.ok) ctx.skip(`Outlook COM unavailable from this process: ${made.reason.split('\n')[0]}`);
    const r = await emailToHtml(new Uint8Array(readFileSync(msgPath)), 'outlook-test.msg');
    expect(r.subject).toBe('Test diacritice șăț');
    expect(r.html).toContain('Outlook');
    expect(r.html).toContain('șț');
    expect(r.html).not.toMatch(/<script/);
    expect(r.attachments.some((a) => a.name === 'outlook-att.txt' && !a.inline)).toBe(true);
  });
});

describe('iconv-lite browser shim', () => {
  it('decodes Windows code pages via TextDecoder', async () => {
    const shim = await import('../src/lib/pdf/iconvLiteShim');
    expect(shim.decode(new Uint8Array([0xba, 0xfe, 0xe3]), 'windows-1250')).toBe('şţă');
    expect(shim.decode([0xba, 0xfe], 'cp1250')).toBe('şţ');
    expect(shim.decode(new Uint8Array([0xc8, 0x99]), 'utf-8')).toBe('ș');
    expect(shim.encodingExists('windows-1250')).toBe(true);
    expect(Array.from(shim.encode('aș', 'windows-1252'))).toEqual([0x61, 0x3f]);
  });
});
