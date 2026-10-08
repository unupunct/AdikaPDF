/**
 * Signature validation report: a PDF that records what Adika found when it
 * checked a document's signatures (who signed, when, integrity, coverage,
 * certificate chain, revocation, PAdES level, qualified status, changes
 * after signing), to keep with the file or send on. Pure (pdf-lib + fonts).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontVariant } from '@/lib/fonts';
import type { SignatureValidation } from '@/types';
import { embedFontForText } from '@/lib/pdf/fontEmbed';

/** One labelled line per check; `t` translates the English labels and values. */
export function reportRows(v: SignatureValidation, t: (s: string) => string = (s) => s): Array<[string, string, 'ok' | 'bad' | 'warn' | 'info']> {
  const rows: Array<[string, string, 'ok' | 'bad' | 'warn' | 'info']> = [];
  rows.push([t('Signed by'), v.signerName || v.certSubject || '—', 'info']);
  if (v.documentTimestamp) rows.push([t('Kind'), t('Document timestamp'), 'info']);
  // Older results (before timestamps were verified) only have hasTimestamp.
  const tsOk = v.timestampVerified ?? v.hasTimestamp;
  if (v.signedAt) {
    const how = tsOk ? t('trusted timestamp') : v.hasTimestamp ? t('timestamp not verified; signer’s claim') : t('signer’s computer clock');
    rows.push([t('Signing time'), `${v.signedAt} (${how})`, tsOk ? 'ok' : 'warn']);
  }
  if (v.reason) rows.push([t('Reason'), v.reason, 'info']);
  rows.push([t('Integrity'), v.integrity === 'valid' ? t('The signed content has not changed.') : v.integrity === 'invalid' ? t('The document was changed after it was signed.') : t('Could not be checked.'), v.integrity === 'valid' ? 'ok' : v.integrity === 'invalid' ? 'bad' : 'warn']);
  if (!v.coversWholeFile) {
    const c = v.laterChanges;
    const what = c ? [c.ltv && t('validation data'), c.signatures && t('signatures'), c.form && t('form filling'), c.annotations && t('comments'), c.other && t('other changes')].filter(Boolean).join(', ') : '';
    rows.push([t('Later changes'), what || t('The file was added to after signing.'), c?.other || v.modifiedAfterSigning ? 'bad' : 'warn']);
    for (const why of c?.reasons ?? []) rows.push(['', why, 'bad']);
  }
  const chain = v.chainStatus ?? 'unknown';
  const chainText: Record<string, string> = {
    trusted: 'Trusted (the chain ends at a trusted root).',
    untrusted: 'Not trusted on this computer.',
    incomplete: 'Incomplete chain.',
    expired: 'A certificate in the chain has expired.',
    unknown: 'Not checked.',
  };
  rows.push([t('Certificate chain'), t(chainText[chain]) + (v.selfSigned ? ` ${t('Self-signed certificate.')}` : ''), chain === 'trusted' ? 'ok' : chain === 'unknown' ? 'warn' : 'bad']);
  for (const c of v.chainDetails ?? []) rows.push(['', c, 'info']);
  rows.push([t('Certificate'), `${v.certSubject}`, 'info']);
  rows.push([t('Issued by'), v.certIssuer, 'info']);
  rows.push([t('Valid'), `${v.certValidFrom} – ${v.certValidTo}`, 'info']);
  const rev = v.revocationStatus ?? 'not-checked';
  const revText: Record<string, string> = { good: 'Not revoked.', revoked: 'The certificate was revoked.', unknown: 'Could not be checked.', 'not-checked': 'Not checked.' };
  rows.push([t('Revocation'), t(revText[rev]) + (v.revocationDetails ? ` ${v.revocationDetails}` : ''), rev === 'good' ? 'ok' : rev === 'revoked' ? 'bad' : 'warn']);
  if (v.algorithm) rows.push([t('Algorithm'), v.algorithm, 'info']);
  if (v.padesLevel) rows.push([t('PAdES level'), `PAdES ${v.padesLevel}`, 'info']);
  if (v.qualified) rows.push([t('Qualified'), v.qualified === 'qscd' ? t('Qualified electronic signature (qualified certificate, key on a secure device)') : t('Qualified certificate'), 'ok']);
  if (v.euTrusted) rows.push([t('EU Trusted List'), `${v.euTrusted} (${t('downloaded over HTTPS; the list’s own signature is not verified')})`, 'ok']);
  if (v.ltv) rows.push([t('Long-term validation'), t('Validation data is stored in the file.'), 'ok']);
  if (v.certified) rows.push([t('Certification'), t(['', 'No changes allowed', 'Form filling and signing allowed', 'Form filling, signing and comments allowed'][v.certified]), 'info']);
  for (const w of v.warnings ?? []) rows.push([t('Warning'), w, 'warn']);
  if (v.message) rows.push([t('Result'), v.message, v.integrity === 'valid' && !v.modifiedAfterSigning && !v.warnings?.length ? 'ok' : 'warn']);
  return rows;
}

export async function validationReportPdf(
  sigs: SignatureValidation[],
  o: { fileName: string; loadFont: (v: FontVariant) => Promise<Uint8Array>; t?: (s: string) => string; locale?: string; checkedAt?: Date },
): Promise<Uint8Array> {
  const t = o.t ?? ((s: string) => s);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const allText = [o.fileName, ...sigs.flatMap((s) => reportRows(s, t).flat()), t('Signature validation report'), t('Signature {0} of {1}'), t('Checked on {0} by Adika PDF Editor.'), t('This document has no signatures.'), '0123456789 .,:;-–()/✓✗!'];
  const reg = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: false, italic: false }), allText);
  const bold = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: true, italic: false }), allText);
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
  page.drawText(safe(bold, t('Signature validation report')), { x: M, y: y - 18, size: 18, font: bold, color: rgb(0.1, 0.12, 0.16) });
  y -= 34;
  page.drawText(safe(reg, o.fileName), { x: M, y, size: 11, font: bold });
  y -= 16;
  const when = new Intl.DateTimeFormat(o.locale ?? 'en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(o.checkedAt ?? new Date());
  page.drawText(safe(reg, t('Checked on {0} by Adika PDF Editor.').replace('{0}', when)), { x: M, y, size: 9, font: reg, color: rgb(0.4, 0.42, 0.46) });
  y -= 28;
  if (!sigs.length) page.drawText(safe(reg, t('This document has no signatures.')), { x: M, y, size: 11, font: reg });
  const colors = { ok: rgb(0.1, 0.55, 0.25), bad: rgb(0.8, 0.15, 0.15), warn: rgb(0.7, 0.45, 0.05), info: rgb(0.1, 0.12, 0.16) };
  const mark = { ok: '✓', bad: '✗', warn: '!', info: '' };
  sigs.forEach((s, i) => {
    need(60);
    page.drawRectangle({ x: M - 6, y: y - 6, width: W - 2 * M + 12, height: 22, color: rgb(0.93, 0.95, 0.98) });
    page.drawText(safe(bold, `${t('Signature {0} of {1}').replace('{0}', String(i + 1)).replace('{1}', String(sigs.length))} · ${s.fieldName}`), { x: M, y, size: 11, font: bold });
    y -= 26;
    for (const [label, value, kind] of reportRows(s, t)) {
      const lines = wrap(value, reg, 9.5, W - 2 * M - 150);
      need(lines.length * 12.5 + 4);
      if (label) page.drawText(safe(reg, label), { x: M, y, size: 9, font: reg, color: rgb(0.4, 0.42, 0.46) });
      if (mark[kind]) page.drawText(mark[kind], { x: M + 132, y, size: 9.5, font: bold, color: colors[kind] });
      lines.forEach((l, k) => page.drawText(l, { x: M + 145, y: y - k * 12.5, size: 9.5, font: reg, color: kind === 'info' ? colors.info : colors[kind] }));
      y -= lines.length * 12.5 + 3;
    }
    y -= 14;
  });
  doc.setTitle(`${t('Signature validation report')} – ${o.fileName}`);
  doc.setProducer('Adika PDF Editor');
  return doc.save();
}
