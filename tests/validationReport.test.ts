import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { reportRows, validationReportPdf } from '@/lib/crypto/validationReport';
import type { FontVariant } from '@/lib/fonts';
import type { SignatureValidation } from '@/types';

const loadFont = (v: FontVariant) => Promise.resolve(new Uint8Array(readFileSync(join(process.cwd(), 'node_modules', '@expo-google-fonts', 'noto-sans', v.bold ? '700Bold' : '400Regular', `NotoSans_${v.bold ? '700Bold' : '400Regular'}.ttf`))));

const sig: SignatureValidation = {
  fieldName: 'Signature1',
  signerName: 'Ana Popescu',
  signedAt: '2026-09-30 14:05',
  reason: 'Aprob',
  integrity: 'valid',
  coversWholeFile: false,
  laterChanges: { ltv: true, signatures: false, form: false, other: false },
  selfSigned: false,
  certSubject: 'CN=Ana Popescu, O=Adika SRL',
  certIssuer: 'CN=Test Qualified CA',
  certValidFrom: '2026-01-01',
  certValidTo: '2028-01-01',
  hasTimestamp: true,
  message: 'Signature is valid.',
  chainStatus: 'trusted',
  revocationStatus: 'good',
  padesLevel: 'B-LT',
  qualified: 'qscd',
  ltv: true,
};

describe('signature validation report', () => {
  it('lists every check with its result', () => {
    const rows = reportRows(sig);
    const get = (l: string) => rows.find((r) => r[0] === l);
    expect(get('Integrity')).toEqual(['Integrity', 'The signed content has not changed.', 'ok']);
    expect(get('Later changes')).toEqual(['Later changes', 'validation data', 'warn']);
    expect(get('Revocation')?.[2]).toBe('ok');
    expect(get('PAdES level')?.[1]).toBe('PAdES B-LT');
    expect(reportRows({ ...sig, integrity: 'invalid' }).find((r) => r[0] === 'Integrity')?.[2]).toBe('bad');
  });

  it('shows warnings, unverified timestamps and the reasons for later changes', () => {
    const rows = reportRows({
      ...sig,
      timestampVerified: false,
      warnings: ['The signature uses SHA-1, which is no longer considered secure.'],
      modifiedAfterSigning: true,
      laterChanges: { ltv: false, signatures: false, form: false, annotations: true, other: true, reasons: ['Page content or another stream was changed.'] },
      euTrusted: 'RO: Test',
    });
    const get = (l: string) => rows.find((r) => r[0] === l);
    expect(get('Signing time')).toEqual(['Signing time', '2026-09-30 14:05 (timestamp not verified; signer’s claim)', 'warn']);
    expect(get('Warning')).toEqual(['Warning', 'The signature uses SHA-1, which is no longer considered secure.', 'warn']);
    expect(get('Later changes')).toEqual(['Later changes', 'comments, other changes', 'bad']);
    expect(rows.some((r) => r[1] === 'Page content or another stream was changed.' && r[2] === 'bad')).toBe(true);
    expect(get('EU Trusted List')?.[1]).toMatch(/own signature is not verified/);
    expect(get('Result')?.[2]).toBe('warn');
    expect(reportRows({ ...sig, timestampVerified: true }).find((r) => r[0] === 'Signing time')?.[2]).toBe('ok');
  });

  it('writes a readable PDF', async () => {
    const bytes = await validationReportPdf([sig], { fileName: 'contract.pdf', loadFont, checkedAt: new Date(Date.UTC(2026, 9, 1, 10, 0)) });
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    await doc.loadingTask.destroy();
    for (const s of ['Signature validation report', 'contract.pdf', 'Ana Popescu', 'The signed content has not changed.', 'CN=Test Qualified CA', 'PAdES B-LT']) expect(text).toContain(s);
  });
});
