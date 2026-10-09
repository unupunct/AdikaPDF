/**
 * The PDF/UA check as a report to keep or send: plain text, HTML and PDF
 * (like the signature validation report). Grouped by Matterhorn checkpoint;
 * every failure with its condition id, page and object, then the checks a
 * person has to make. `t` translates the English texts. Pure (pdf-lib + fonts).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontVariant } from '@/lib/fonts';
import { embedFontForText } from '@/lib/pdf/fontEmbed';
import { groupIssues, type UaIssue, type UaReport } from './pdfua';

type T = (s: string) => string;
const id = (s: string) => s;
const fill = (s: string, ...a: Array<string | number>) => a.reduce<string>((r, v, i) => r.replace(`{${i}}`, String(v)), s);

export interface ReportMeta {
  fileName: string;
  checkedAt?: Date;
  locale?: string;
}

function where(i: UaIssue, t: T): string {
  const parts: string[] = [];
  if (i.page !== null) parts.push(fill(t('page {0}'), i.page + 1));
  if (i.tag) parts.push(`<${i.tag}>`);
  if (i.object) parts.push(fill(t('object {0}'), i.object.replace('-0', '').replace('-', ' ')));
  return parts.join(', ');
}

const fixText = (i: UaIssue, t: T) => (!i.fix ? t('needs a person') : i.confirm ? t('Adika can fix it (after you confirm)') : t('Adika can fix it'));

function summary(r: UaReport, t: T): string {
  const failed = r.checkpoints.filter((c) => c.status === 'fail').length;
  return r.issues.length ? fill(t('{0} failure(s) in {1} checkpoint(s).'), r.issues.length, failed) : t('No failures of the machine-checkable conditions.');
}

export function reportText(r: UaReport, meta: ReportMeta, t: T = id): string {
  const out: string[] = [t('PDF/UA accessibility report'), meta.fileName, fill(t('Checked on {0} by Adika PDF Editor (PDF/UA-1, Matterhorn Protocol 1.1).'), (meta.checkedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')), '', summary(r, t), ''];
  for (const c of r.checkpoints) out.push(`[${c.status === 'pass' ? t('pass') : c.status === 'fail' ? t('FAIL') : t('check')}] ${c.id} ${t(c.title)}${c.failures ? ` (${c.failures})` : ''}`);
  for (const g of groupIssues(r.issues)) {
    out.push('', `${g.checkpoint} ${t(g.title)}`);
    for (const i of g.issues) out.push(`  ${i.condition}  ${i.message}${where(i, t) ? ` — ${where(i, t)}` : ''} [${fixText(i, t)}]`);
  }
  out.push('', t('Needs a person to check'));
  for (const m of r.manual) out.push(`  ${m.checkpoint} ${t(m.title)}: ${t(m.guidance)}`);
  return out.join('\n') + '\n';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function reportHtml(r: UaReport, meta: ReportMeta, t: T = id, lang = 'en'): string {
  const rows = groupIssues(r.issues)
    .map(
      (g) =>
        `<h2>${esc(`${g.checkpoint} ${t(g.title)}`)}</h2><table><thead><tr><th scope="col">${esc(t('Condition'))}</th><th scope="col">${esc(t('Problem'))}</th><th scope="col">${esc(t('Where'))}</th><th scope="col">${esc(t('Fix'))}</th></tr></thead><tbody>${g.issues
          .map((i) => `<tr><td>${esc(i.condition)}</td><td>${esc(i.message)}</td><td>${esc(where(i, t))}</td><td>${esc(fixText(i, t))}</td></tr>`)
          .join('')}</tbody></table>`,
    )
    .join('');
  const cps = r.checkpoints.map((c) => `<li class="${c.status}">${esc(`${c.id} ${t(c.title)}`)}: ${esc(c.status === 'pass' ? t('pass') : c.status === 'fail' ? fill(t('{0} failure(s)'), c.failures) : t('needs a person to check'))}</li>`).join('');
  const manual = r.manual.map((m) => `<li><strong>${esc(`${m.checkpoint} ${t(m.title)}`)}</strong>: ${esc(t(m.guidance))}</li>`).join('');
  const title = `${t('PDF/UA accessibility report')} – ${meta.fileName}`;
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px/1.45 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1a1f29}table{border-collapse:collapse;width:100%;margin-bottom:12px}th,td{border:1px solid #d5d9e0;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eef2f7}.fail{color:#b4231f}.pass{color:#1a7a3c}.manual{color:#8a5a00}</style></head><body><h1>${esc(t('PDF/UA accessibility report'))}</h1><p>${esc(meta.fileName)}<br>${esc(fill(t('Checked on {0} by Adika PDF Editor (PDF/UA-1, Matterhorn Protocol 1.1).'), (meta.checkedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')))}</p><p><strong>${esc(summary(r, t))}</strong></p><ul>${cps}</ul>${rows}<h2>${esc(t('Needs a person to check'))}</h2><ul>${manual}</ul></body></html>`;
}

export async function reportPdf(r: UaReport, meta: ReportMeta & { loadFont: (v: FontVariant) => Promise<Uint8Array>; t?: T }): Promise<Uint8Array> {
  const t = meta.t ?? id;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const lines = reportText(r, meta, t).split('\n');
  const allText = [...lines, '0123456789 .,:;-–()/✓✗!<>[]'];
  const reg = await embedFontForText(doc, await meta.loadFont({ family: 'sans', bold: false, italic: false }), allText);
  const bold = await embedFontForText(doc, await meta.loadFont({ family: 'sans', bold: true, italic: false }), allText);
  const [W, H] = [595.28, 841.89];
  const M = 48;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const safe = (f: PDFFont, s: string) => {
    const set = f.getCharacterSet();
    return [...s].map((c) => (set.includes(c.codePointAt(0)!) ? c : '?')).join('');
  };
  const wrap = (s: string, f: PDFFont, size: number, w: number) => {
    const out: string[] = [];
    let line = '';
    for (const word of safe(f, s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > w && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const need = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const text = (s: string, o: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; width?: number; gap?: number }) => {
    const size = o.size ?? 9.5;
    const font = o.font ?? reg;
    const ls = wrap(s, font, size, o.width ?? W - 2 * M - (o.x ?? 0));
    need(ls.length * (size + 3));
    ls.forEach((l, k) => page.drawText(l, { x: M + (o.x ?? 0), y: y - k * (size + 3), size, font, color: o.color ?? rgb(0.1, 0.12, 0.16) }));
    y -= ls.length * (size + 3) + (o.gap ?? 2);
  };
  const red = rgb(0.75, 0.14, 0.12);
  const green = rgb(0.1, 0.5, 0.24);
  const amber = rgb(0.6, 0.38, 0.02);
  const grey = rgb(0.4, 0.42, 0.46);
  y -= 18;
  page.drawText(safe(bold, t('PDF/UA accessibility report')), { x: M, y, size: 18, font: bold });
  y -= 22;
  text(meta.fileName, { font: bold, size: 11 });
  const when = new Intl.DateTimeFormat(meta.locale ?? 'en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(meta.checkedAt ?? new Date());
  text(fill(t('Checked on {0} by Adika PDF Editor (PDF/UA-1, Matterhorn Protocol 1.1).'), when), { size: 9, color: grey, gap: 10 });
  text(summary(r, t), { font: bold, size: 11, color: r.issues.length ? red : green, gap: 8 });
  for (const c of r.checkpoints) {
    const [mark, color] = c.status === 'pass' ? ['✓', green] : c.status === 'fail' ? ['✗', red] : ['!', amber];
    need(13);
    page.drawText(mark, { x: M, y, size: 9.5, font: bold, color });
    text(`${c.id}  ${t(c.title)}${c.failures ? `  (${c.failures})` : ''}`, { x: 16, gap: 1 });
  }
  y -= 10;
  for (const g of groupIssues(r.issues)) {
    need(40);
    page.drawRectangle({ x: M - 6, y: y - 6, width: W - 2 * M + 12, height: 20, color: rgb(0.93, 0.95, 0.98) });
    text(`${g.checkpoint}  ${t(g.title)}`, { font: bold, size: 11, gap: 8 });
    for (const i of g.issues) {
      need(26);
      page.drawText(safe(bold, i.condition), { x: M, y, size: 9, font: bold, color: red });
      text(i.message, { x: 70, gap: 0 });
      text([where(i, t), fixText(i, t)].filter(Boolean).join(' · '), { x: 70, size: 8.5, color: grey, gap: 5 });
    }
    y -= 6;
  }
  need(40);
  text(t('Needs a person to check'), { font: bold, size: 11, gap: 6 });
  for (const m of r.manual) {
    text(`${m.checkpoint}  ${t(m.title)}`, { font: bold, size: 9.5, gap: 0 });
    text(t(m.guidance), { x: 16, size: 9, color: grey, gap: 5 });
  }
  doc.setTitle(`${t('PDF/UA accessibility report')} – ${meta.fileName}`);
  doc.setProducer('Adika PDF Editor');
  return doc.save();
}
