/**
 * A readable PDF of an electronic invoice (like ANAF's "PDF visualisation"):
 * parties, lines, VAT breakdown, totals and payment details on A4, with the
 * original XML attached so the PDF still carries the legal invoice. Pure.
 */
import { AFRelationship, PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from '@/lib/pdf/fontEmbed';
import type { FontVariant } from '@/lib/fonts';
import { UNIT_NAMES, type EInvoice, type Party } from './parse';

export interface InvoiceLabels {
  invoice: string;
  credit: string;
  number: string;
  issueDate: string;
  dueDate: string;
  deliveryDate: string;
  currency: string;
  orderRef: string;
  buyerRef: string;
  contractRef: string;
  seller: string;
  buyer: string;
  vatId: string;
  companyId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: string;
  amount: string;
  allowance: string;
  charge: string;
  vatBreakdown: string;
  category: string;
  taxable: string;
  vat: string;
  lineTotal: string;
  totalWithoutVat: string;
  totalVat: string;
  total: string;
  prepaid: string;
  rounding: string;
  amountDue: string;
  payment: string;
  iban: string;
  bic: string;
  accountName: string;
  reference: string;
  terms: string;
  notes: string;
  page: string;
  footer: string;
  warnings: string;
}

export const EN_LABELS: InvoiceLabels = {
  invoice: 'Invoice',
  credit: 'Credit note',
  number: 'No.',
  issueDate: 'Issue date',
  dueDate: 'Due date',
  deliveryDate: 'Delivery date',
  currency: 'Currency',
  orderRef: 'Order no.',
  buyerRef: 'Buyer reference',
  contractRef: 'Contract',
  seller: 'Seller',
  buyer: 'Buyer',
  vatId: 'VAT ID',
  companyId: 'Registration',
  description: 'Description',
  quantity: 'Qty',
  unit: 'Unit',
  unitPrice: 'Unit price',
  vatRate: 'VAT',
  amount: 'Amount',
  allowance: 'Discount',
  charge: 'Charge',
  vatBreakdown: 'VAT breakdown',
  category: 'Category',
  taxable: 'Taxable amount',
  vat: 'VAT',
  lineTotal: 'Sum of lines',
  totalWithoutVat: 'Total without VAT',
  totalVat: 'Total VAT',
  total: 'Total with VAT',
  prepaid: 'Paid in advance',
  rounding: 'Rounding',
  amountDue: 'Amount due',
  payment: 'Payment',
  iban: 'IBAN',
  bic: 'BIC',
  accountName: 'Account',
  reference: 'Payment reference',
  terms: 'Terms',
  notes: 'Notes',
  page: 'Page {0} of {1}',
  footer: 'Visual copy of the electronic invoice {0} (attached). The XML is the legal invoice.',
  warnings: 'Checks',
};

const MEANS: Record<string, string> = {
  '1': '',
  '10': 'Cash',
  '20': 'Cheque',
  '30': 'Credit transfer',
  '31': 'Debit transfer',
  '42': 'Payment to bank account',
  '48': 'Bank card',
  '49': 'Direct debit',
  '57': 'Standing agreement',
  '58': 'SEPA credit transfer',
  '59': 'SEPA direct debit',
  '68': 'Online payment',
  '97': 'Clearing between partners',
};

/** Payment means name for a UNCL4461 code (English; the app translates it). */
export const paymentMeansName = (code: string) => MEANS[code] ?? code;

const A4: [number, number] = [595.28, 841.89];
const M = 40;

export async function renderEInvoice(
  inv: EInvoice,
  opts: { loadFont: (v: FontVariant) => Promise<Uint8Array>; labels?: InvoiceLabels; locale?: string; xml?: { name: string; bytes: Uint8Array }; warnings?: string[]; meansName?: (code: string) => string },
): Promise<Uint8Array> {
  const L = opts.labels ?? EN_LABELS;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // Only the letters this invoice uses (pdf-lib's own subsetter corrupts Noto glyphs).
  const used = [JSON.stringify(inv), JSON.stringify(L), (opts.warnings ?? []).join(' '), opts.xml?.name ?? '', '0123456789 .,:;-–—−+%/()[]#…•·?*€$£RON'];
  const regular = await embedFontForText(doc, await opts.loadFont({ family: 'sans', bold: false, italic: false }), used);
  const bold = await embedFontForText(doc, await opts.loadFont({ family: 'sans', bold: true, italic: false }), used.map((s) => s + s.toUpperCase()));
  const nf = new Intl.NumberFormat(opts.locale ?? 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qf = new Intl.NumberFormat(opts.locale ?? 'en-US', { maximumFractionDigits: 4 });
  const money = (n: number) => nf.format(n);
  const date = (iso: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat(opts.locale ?? 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
  };
  const grey = rgb(0.42, 0.45, 0.5);
  const ink = rgb(0.1, 0.12, 0.16);
  const rule = rgb(0.82, 0.85, 0.9);
  const shade = rgb(0.95, 0.96, 0.98);
  const accent = rgb(0.11, 0.33, 0.66);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    y = A4[1] - M;
  };
  const width = (s: string, f: PDFFont, size: number) => f.widthOfTextAtSize(s, size);
  const safe = (f: PDFFont, s: string) => {
    const set = f.getCharacterSet();
    return [...s].map((c) => (set.includes(c.codePointAt(0)!) ? c : c === '\t' ? ' ' : '?')).join('');
  };
  const wrap = (s: string, f: PDFFont, size: number, w: number): string[] => {
    const out: string[] = [];
    for (const para of safe(f, s).split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (width(next, f, size) <= w || !line) {
          // A single word longer than the column is cut.
          if (!line && width(word, f, size) > w) {
            let part = '';
            for (const ch of word) {
              if (width(part + ch, f, size) > w && part) {
                out.push(part);
                part = '';
              }
              part += ch;
            }
            line = part;
          } else line = next;
        } else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  };
  const text = (s: string, x: number, yy: number, size: number, f: PDFFont = regular, color = ink) => {
    if (s) page.drawText(safe(f, s), { x, y: yy, size, font: f, color });
  };
  const right = (s: string, xr: number, yy: number, size: number, f: PDFFont = regular, color = ink) => text(s, xr - width(safe(f, s), f, size), yy, size, f, color);
  const need = (h: number, onBreak?: () => void) => {
    if (y - h < M + 30) {
      newPage();
      onBreak?.();
    }
  };

  newPage();
  // --- title and document data
  const title = inv.kind === 'credit' ? L.credit : L.invoice;
  text(title.toUpperCase(), M, y - 20, 20, bold, accent);
  const meta: Array<[string, string]> = [
    [L.number, inv.number],
    [L.issueDate, date(inv.issueDate)],
    [L.dueDate, date(inv.dueDate)],
    [L.deliveryDate, date(inv.deliveryDate)],
    [L.currency, inv.currency],
    [L.orderRef, inv.orderReference],
    [L.contractRef, inv.contractReference],
    [L.buyerRef, inv.buyerReference],
  ].filter(([, v]) => v) as Array<[string, string]>;
  let my = y - 6;
  for (const [k, v] of meta) {
    right(k, A4[0] - M - 130, my - 10, 8.5, regular, grey);
    text(v, A4[0] - M - 122, my - 10, 9.5, k === L.number ? bold : regular);
    my -= 13;
  }
  y = Math.min(y - 40, my - 6);

  // --- parties
  const colW = (A4[0] - 2 * M - 16) / 2;
  const partyLines = (p: Party): Array<[string, PDFFont, number, ReturnType<typeof rgb>]> => {
    const a = p.address;
    const lines: Array<[string, PDFFont, number, ReturnType<typeof rgb>]> = [];
    for (const l of wrap(p.name, bold, 10.5, colW - 16)) lines.push([l, bold, 10.5, ink]);
    if (p.vatId) lines.push([`${L.vatId}: ${p.vatId}`, regular, 9, ink]);
    if (p.companyId) lines.push([`${L.companyId}: ${p.companyId}`, regular, 9, ink]);
    for (const l of wrap(a.street, regular, 9, colW - 16)) lines.push([l, regular, 9, ink]);
    const cityLine = [a.postalCode, a.city].filter(Boolean).join(' ');
    const place = [cityLine, a.region, a.country].filter(Boolean).join(', ');
    if (place) lines.push([place, regular, 9, ink]);
    if (p.email) lines.push([p.email, regular, 9, grey]);
    if (p.phone) lines.push([p.phone, regular, 9, grey]);
    return lines;
  };
  const left = partyLines(inv.seller);
  const rightLines = partyLines(inv.buyer);
  const boxH = 26 + Math.max(left.length, rightLines.length) * 12.5;
  for (const [i, [label, lines]] of ([
    [L.seller, left],
    [L.buyer, rightLines],
  ] as const).entries()) {
    const x = M + i * (colW + 16);
    page.drawRectangle({ x, y: y - boxH, width: colW, height: boxH, color: shade, borderColor: rule, borderWidth: 0.6 });
    text(label.toUpperCase(), x + 8, y - 14, 7.5, bold, grey);
    let ly = y - 28;
    for (const [s, f, size, c] of lines) {
      text(s, x + 8, ly, size, f, c);
      ly -= 12.5;
    }
  }
  y -= boxH + 18;

  // --- lines
  const cols = { no: M, desc: M + 22, qty: A4[0] - M - 250, unit: A4[0] - M - 206, price: A4[0] - M - 120, vat: A4[0] - M - 78, amount: A4[0] - M };
  const descW = cols.qty - 46 - cols.desc;
  const header = () => {
    page.drawRectangle({ x: M, y: y - 18, width: A4[0] - 2 * M, height: 18, color: accent });
    const w = rgb(1, 1, 1);
    text('#', cols.no + 4, y - 12.5, 8, bold, w);
    text(L.description, cols.desc, y - 12.5, 8, bold, w);
    right(L.quantity, cols.qty, y - 12.5, 8, bold, w);
    text(L.unit, cols.unit, y - 12.5, 8, bold, w);
    right(L.unitPrice, cols.price, y - 12.5, 8, bold, w);
    right(L.vatRate, cols.vat, y - 12.5, 8, bold, w);
    right(L.amount, cols.amount - 4, y - 12.5, 8, bold, w);
    y -= 22;
  };
  header();
  inv.lines.forEach((l, i) => {
    const name = wrap(l.name || l.description, regular, 9, descW);
    const desc = l.name && l.description && l.description !== l.name ? wrap(l.description, regular, 7.5, descW) : [];
    const h = name.length * 11 + desc.length * 9.5 + 6;
    need(h, header);
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - h + 4, width: A4[0] - 2 * M, height: h, color: shade });
    text(l.id || String(i + 1), cols.no + 4, y - 8, 8.5, regular, grey);
    name.forEach((s, k) => text(s, cols.desc, y - 8 - k * 11, 9));
    desc.forEach((s, k) => text(s, cols.desc, y - 8 - name.length * 11 - k * 9.5, 7.5, regular, grey));
    right(qf.format(l.quantity), cols.qty, y - 8, 9);
    text(UNIT_NAMES[l.unit] ?? l.unit, cols.unit, y - 8, 8.5, regular, grey);
    right(money(l.unitPrice), cols.price, y - 8, 9);
    right(l.vatPercent === null ? l.vatCategory : `${qf.format(l.vatPercent)}%`, cols.vat, y - 8, 9);
    right(money(l.net), cols.amount - 4, y - 8, 9, bold);
    y -= h;
  });
  for (const a of inv.allowances) {
    need(14);
    text(`${a.charge ? L.charge : L.allowance}${a.reason ? `: ${a.reason}` : ''}`, cols.desc, y - 8, 9, regular, grey);
    right(`${a.charge ? '' : '−'}${money(a.amount)}`, cols.amount - 4, y - 8, 9);
    y -= 14;
  }
  page.drawLine({ start: { x: M, y: y - 2 }, end: { x: A4[0] - M, y: y - 2 }, thickness: 0.6, color: rule });
  y -= 16;

  // --- VAT breakdown (left) and totals (right)
  const startY = y;
  need(16 + inv.vat.length * 13 + 100);
  const vy0 = y;
  text(L.vatBreakdown.toUpperCase(), M, y - 8, 7.5, bold, grey);
  let vy = y - 22;
  const vx = { cat: M, rate: M + 70, taxable: M + 190, vat: M + 270 };
  text(L.category, vx.cat, vy, 8, bold, grey);
  right(L.vatRate, vx.rate + 30, vy, 8, bold, grey);
  right(L.taxable, vx.taxable, vy, 8, bold, grey);
  right(L.vat, vx.vat, vy, 8, bold, grey);
  vy -= 13;
  for (const v of inv.vat) {
    text(v.category, vx.cat, vy, 9);
    right(v.percent === null ? '' : `${qf.format(v.percent)}%`, vx.rate + 30, vy, 9);
    right(money(v.taxable), vx.taxable, vy, 9);
    right(money(v.amount), vx.vat, vy, 9);
    vy -= 12;
    if (v.exemption) {
      for (const s of wrap(v.exemption, regular, 7.5, vx.vat - M)) {
        text(s, vx.cat, vy, 7.5, regular, grey);
        vy -= 9.5;
      }
    }
  }
  const tot: Array<[string, number, boolean]> = [[L.lineTotal, inv.totals.lineNet, false]];
  if (inv.totals.allowances) tot.push([L.allowance, -inv.totals.allowances, false]);
  if (inv.totals.charges) tot.push([L.charge, inv.totals.charges, false]);
  tot.push([L.totalWithoutVat, inv.totals.taxExclusive, false], [L.totalVat, inv.totals.tax, false], [L.total, inv.totals.taxInclusive, false]);
  if (inv.totals.prepaid) tot.push([L.prepaid, -inv.totals.prepaid, false]);
  if (inv.totals.rounding) tot.push([L.rounding, inv.totals.rounding, false]);
  let ty = vy0 - 8;
  const tx = A4[0] - M;
  for (const [k, v] of tot) {
    right(k, tx - 90, ty, 9, regular, grey);
    right(money(v), tx, ty, 9.5);
    ty -= 14;
  }
  page.drawRectangle({ x: tx - 230, y: ty - 10, width: 230, height: 22, color: accent });
  right(L.amountDue, tx - 90, ty - 3, 10, bold, rgb(1, 1, 1));
  right(`${money(inv.totals.payable)} ${inv.currency}`, tx - 6, ty - 3, 11, bold, rgb(1, 1, 1));
  y = Math.min(vy, ty - 14) - 16;
  void startY;

  // --- payment and notes
  const pay: Array<[string, string]> = [
    ['', (opts.meansName ?? paymentMeansName)(inv.payment.meansCode)],
    [L.iban, inv.payment.iban.replace(/(.{4})(?=.)/g, '$1 ')],
    [L.bic, inv.payment.bic],
    [L.accountName, inv.payment.accountName],
    [L.reference, inv.payment.reference],
    [L.terms, inv.payment.terms],
  ].filter(([, v]) => v) as Array<[string, string]>;
  if (pay.length) {
    need(18 + pay.length * 13);
    text(L.payment.toUpperCase(), M, y - 8, 7.5, bold, grey);
    y -= 22;
    for (const [k, v] of pay) {
      if (k) text(k, M, y, 8.5, regular, grey);
      for (const s of wrap(v, k === L.iban ? bold : regular, 9, A4[0] - 2 * M - 110)) {
        text(s, M + (k ? 110 : 0), y, 9, k === L.iban ? bold : regular);
        y -= 12;
      }
      y -= 1;
    }
    y -= 8;
  }
  const notes = inv.notes.flatMap((n) => wrap(n, regular, 8.5, A4[0] - 2 * M));
  if (notes.length) {
    need(20);
    text(L.notes.toUpperCase(), M, y - 8, 7.5, bold, grey);
    y -= 22;
    for (const s of notes) {
      need(11);
      text(s, M, y, 8.5);
      y -= 11;
    }
    y -= 8;
  }
  if (opts.warnings?.length) {
    need(20);
    text(L.warnings.toUpperCase(), M, y - 8, 7.5, bold, rgb(0.7, 0.35, 0.05));
    y -= 22;
    for (const w of opts.warnings.flatMap((x) => wrap(`• ${x}`, regular, 8.5, A4[0] - 2 * M))) {
      need(11);
      text(w, M, y, 8.5, regular, rgb(0.6, 0.3, 0.05));
      y -= 11;
    }
  }

  // --- footer on every page
  const footer = L.footer.replace('{0}', opts.xml?.name ?? inv.number);
  pages.forEach((p, i) => {
    page = p;
    page.drawLine({ start: { x: M, y: M - 4 }, end: { x: A4[0] - M, y: M - 4 }, thickness: 0.5, color: rule });
    const lines = wrap(footer, regular, 7, A4[0] - 2 * M - 80);
    lines.forEach((s, k) => text(s, M, M - 14 - k * 8.5, 7, regular, grey));
    right(L.page.replace('{0}', String(i + 1)).replace('{1}', String(pages.length)), A4[0] - M, M - 14, 7, regular, grey);
  });

  doc.setTitle(`${title} ${inv.number}`);
  doc.setAuthor(inv.seller.name);
  doc.setSubject(`${title} ${inv.number} – ${inv.buyer.name}`);
  doc.setProducer('Adika PDF Editor');
  if (opts.xml) await doc.attach(opts.xml.bytes, opts.xml.name, { mimeType: 'application/xml', description: `${title} ${inv.number}`, afRelationship: AFRelationship.Source });
  return doc.save();
}
