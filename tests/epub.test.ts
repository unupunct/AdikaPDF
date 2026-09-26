import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { epubToHtml, pdfToEpub } from '../src/lib/pdf/epub';
import type { PageText, TextLine } from '../src/lib/pdf/convert';

const line = (text: string, y: number, fontSize = 11, bold = false, cells?: string[]): TextLine => ({
  y,
  x: 72,
  text,
  fontSize,
  bold,
  width: text.length * fontSize * 0.5,
  cells: (cells ?? [text]).map((t, k) => ({ x: 72 + k * 150, text: t })),
});

const body = (n: number, y0: number, prefix: string): TextLine[] =>
  Array.from({ length: n }, (_, k) => line(`${prefix} rândul ${k + 1} continuă textul paragrafului aici fără oprire`, y0 + k * 14));

// Tiny 1x1 PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function epub2Fixture(extra?: (zip: JSZip) => void): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile media-type="application/oebps-package+xml"
              full-path="OPS/book.opf" />
  </rootfiles>
</container>`,
  );
  zip.file(
    'OPS/book.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>Carte &amp; Poveşti</dc:title>
  <dc:creator opf:role="aut">Ion Creangă</dc:creator>
  <dc:language>ro</dc:language>
  <dc:identifier id="uid">x-1</dc:identifier>
 </metadata>
 <manifest>
  <item href="Text/ch%201.xhtml" id="c1" media-type="application/xhtml+xml"/>
  <item media-type="application/xhtml+xml" id="c2" href="Text/ch2.xhtml" />
  <item id="css" href="Styles/main.css" media-type="text/css"/>
  <item id="img" href="Images/pic.png" media-type="image/png"/>
  <item id="font" href="Fonts/f.ttf" media-type="application/x-font-ttf"/>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
 </manifest>
 <spine toc="ncx">
  <itemref idref="c1"/>
  <itemref idref="c2" linear="yes"/>
 </spine>
</package>`,
  );
  zip.file('OPS/Styles/main.css', `@font-face { font-family: F; src: url('../Fonts/f.ttf'); }\nbody { background: url("http://evil.example/x.png"); }\n.pic { border: 1px solid; }`);
  zip.file('OPS/Fonts/f.ttf', new Uint8Array([0, 1, 0, 0, 1, 2, 3]));
  zip.file('OPS/Images/pic.png', PNG);
  zip.file(
    'OPS/Text/ch 1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
<head>
  <title>Unu</title>
  <link type="text/css" href="../Styles/main.css" rel="stylesheet"/>
  <script type="text/javascript">alert('head')</script>
</head>
<body class="calibre" onload="alert(1)">
  <h1 id="s1">Capitolul Întâi</h1>
  <p onclick="steal()" class="x">Știință și țară.</p>
  <script>alert("body")</script>
  <div class="pic"><img alt="pic" class="pic" src="../Images/pic.png"/></div>
  <img src='https://tracker.example/pixel.gif' alt="remote"/>
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" xlink:href="../Images/pic.png"/></svg>
  <p><a href="ch2.xhtml">next</a> <a href="javascript:alert(1)">bad</a> <a href="https://example.com/">web</a></p>
  <div id="empty"/>
</body>
</html>`,
  );
  zip.file(
    'OPS/Text/ch2.xhtml',
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Doi</title><link rel="stylesheet" href="../Styles/main.css"/></head>
<BODY><h1>Capitolul Doi</h1><p>Sfârşit.</p></BODY></html>`,
  );
  extra?.(zip);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('pdfToEpub', () => {
  const pages: PageText[] = [
    {
      pageNumber: 1,
      width: 595,
      height: 842,
      lines: [line('Introducere', 60, 24, true), ...body(6, 100, 'Primul'), line('Știință ăâî țară', 220, 11)],
    },
    {
      pageNumber: 2,
      width: 595,
      height: 842,
      lines: [
        line('Capitolul Doi', 60, 24, true),
        line('Secțiune', 100, 15),
        ...body(5, 130, 'Al doilea'),
        line('Nume Preț', 230, 11, false, ['Nume', 'Preț']),
        line('Măr 3', 244, 11, false, ['Măr', '3']),
        line('Text <b> & "citate"', 270, 11, true),
      ],
    },
  ];

  it('builds a valid EPUB 3 that round-trips through epubToHtml', async () => {
    const blob = await pdfToEpub(pages, { title: 'Carte de test', author: 'Autor Român', language: 'ro' });
    expect(blob.type).toBe('application/epub+zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // OCF: first local header is `mimetype`, stored, with the exact content.
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(8, true)).toBe(0); // compression method: STORE
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const dec = new TextDecoder();
    expect(dec.decode(bytes.subarray(30, 30 + nameLen))).toBe('mimetype');
    const size = dv.getUint32(18, true);
    expect(dec.decode(bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + size))).toBe('application/epub+zip');

    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toMatch(/<dc:identifier id="bookid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/);
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);
    expect(opf).toContain('properties="nav"');
    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string');
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('Introducere');
    expect(nav).toContain('Secțiune');
    expect(zip.file('OEBPS/toc.ncx')).not.toBeNull();
    const ch2 = await zip.file('OEBPS/chapter002.xhtml')!.async('string');
    expect(ch2).toContain('<table>');
    expect(ch2).toContain('<td>Preț</td>');
    expect(ch2).toContain('<strong>Text &lt;b&gt; &amp; &quot;citate&quot;</strong>');
    // Consecutive body lines are one paragraph.
    expect(ch2.match(/<p>/g)?.length).toBe(1 + 1);

    const out = await epubToHtml(bytes);
    expect(out.title).toBe('Carte de test');
    expect(out.author).toBe('Autor Român');
    expect(out.chapters).toBe(2);
    expect(out.html).toContain('Știință ăâî țară');
    expect(out.html).toContain('<h1 id="h1">Introducere</h1>');
    expect(out.html).toContain('<h2 id="h3">Secțiune</h2>');
    expect(out.html).toContain('<div style="break-before: page"></div>');
    expect(out.html.match(/break-before: page"/g)?.length).toBe(1);
  });

  it('splits every 5 pages when there are no headings', async () => {
    const many: PageText[] = Array.from({ length: 12 }, (_, k) => ({
      pageNumber: k + 1,
      width: 595,
      height: 842,
      lines: body(3, 100, `Pagina ${k + 1}`),
    }));
    const out = await epubToHtml(new Uint8Array(await (await pdfToEpub(many, { title: 'T', author: '' })).arrayBuffer()));
    expect(out.chapters).toBe(3);
    expect(out.author).toBeNull();
  });

  it('strips invalid XML characters', async () => {
    const p: PageText[] = [{ pageNumber: 1, width: 100, height: 100, lines: [line('a\u0001b\uFFFEc', 10)] }];
    const zip = await JSZip.loadAsync(await (await pdfToEpub(p, { title: 'x\u0002y', author: 'z' })).arrayBuffer());
    const ch = await zip.file('OEBPS/chapter001.xhtml')!.async('string');
    expect(ch).toContain('<p>abc</p>');
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:title>xy</dc:title>');
  });
});

describe('epubToHtml', () => {
  it('inlines images and CSS, strips scripts and remote references (EPUB 2)', async () => {
    const out = await epubToHtml(await epub2Fixture());
    const { html } = out;
    expect(out.title).toBe('Carte & Poveşti');
    expect(out.author).toBe('Ion Creangă');
    expect(out.chapters).toBe(2);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<html lang="ro">');

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('alert');
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('javascript:');

    const b64 = btoa(String.fromCharCode(...PNG));
    expect(html).toContain(`src="data:image/png;base64,${b64}"`);
    expect(html).toContain(`xlink:href="data:image/png;base64,${b64}"`);
    // Stylesheet linked from both chapters is inlined once; font url() inlined.
    expect(html.match(/\.pic \{ border/g)?.length).toBe(1);
    expect(html).toContain('url("data:application/x-font-ttf;base64,');
    expect(html).toContain('background: none');

    // Chapter wrappers, page break between chapters, internal link rewritten.
    expect(html).toContain('<section class="epub-chapter calibre" id="epub-ch-1">');
    expect(html).toContain('<div style="break-before: page"></div>\n<section class="epub-chapter" id="epub-ch-2">');
    expect(html).toContain('<a href="#epub-ch-2">next</a>');
    expect(html).toContain('<a>bad</a>');
    expect(html).toContain('<a href="https://example.com/">web</a>');
    expect(html).toContain('<div id="empty"></div>');
    expect(html).toContain('Știință și țară.');
    expect(html).toContain('<h1>Capitolul Doi</h1>');
    expect(html.match(/<body/gi)?.length).toBe(1);
    expect(html.match(/<\/body>/gi)?.length).toBe(1);
  });

  it('rejects DRM-protected books', async () => {
    const bytes = await epub2Fixture((zip) =>
      zip.file(
        'META-INF/encryption.xml',
        `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OPS/Text/ch2.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`,
      ),
    );
    await expect(epubToHtml(bytes)).rejects.toThrow(/DRM-protected/);
  });

  it('tolerates obfuscated fonts (not DRM) without inlining them', async () => {
    const bytes = await epub2Fixture((zip) =>
      zip.file(
        'META-INF/encryption.xml',
        `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
  <enc:CipherData><enc:CipherReference URI="OPS/Fonts/f.ttf"/></enc:CipherData></enc:EncryptedData>
</encryption>`,
      ),
    );
    const { html } = await epubToHtml(bytes);
    expect(html).not.toContain('x-font-ttf;base64');
    expect(html).toContain('Capitolul Doi');
  });

  it('rejects non-EPUB input', async () => {
    await expect(epubToHtml(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a valid EPUB/);
    const zip = new JSZip();
    zip.file('a.txt', 'x');
    await expect(epubToHtml(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/container\.xml/);
  });
});
