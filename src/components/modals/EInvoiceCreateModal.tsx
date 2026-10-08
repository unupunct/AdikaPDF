/** Convert → New e-invoice: seller, buyer, lines, payment, live totals and checks; issues e-Factura, Peppol or Factur-X files. */
import { useEffect, useMemo, useState } from 'react';
import { ImagePlus, Plus, Save, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Input, Select, Textarea } from '@/components/ui/primitives';
import { translate } from '@/lib/i18n';
import { bytesToBase64, pickFiles } from '@/lib/platform';
import { calculate, emptyDraft, emptyLine, EXEMPT_CATEGORIES, roundingFor, VAT_CATEGORIES, type DraftLine, type DraftParty, type EInvoiceProfile, type InvoiceDraft, type VatCategory } from '@/lib/einvoice/model';
import { BUCHAREST_SECTORS, defaultEndpoint, RO_COUNTIES, validateInvoice } from '@/lib/einvoice/rules';
import { draftForSeller, emptyBook, lineFromProduct, newSeller, searchCustomers, type InvoiceBook, type SellerProfile } from '@/lib/einvoice/book';
import type { EInvoiceOutput } from '@/actions/einvoiceCreate';

const PROFILES: Array<{ value: EInvoiceProfile; label: string }> = [
  { value: 'ro', label: 'Romania: e-Factura (CIUS-RO)' },
  { value: 'peppol', label: 'EU: Peppol BIS Billing 3.0 (UBL)' },
  { value: 'facturx', label: 'Factur-X / ZUGFeRD (CII, EN 16931)' },
];
const TYPES = [
  { value: '380', label: 'Invoice (380)' },
  { value: '381', label: 'Credit note (381)' },
  { value: '384', label: 'Corrected invoice (384)' },
  { value: '389', label: 'Self-billed invoice (389)' },
  { value: '751', label: 'Invoice information for accounting (751)' },
];
const UNITS = [
  { value: 'H87', label: 'H87 piece' },
  { value: 'C62', label: 'C62 one (unit)' },
  { value: 'HUR', label: 'HUR hour' },
  { value: 'DAY', label: 'DAY day' },
  { value: 'MON', label: 'MON month' },
  { value: 'KGM', label: 'KGM kilogram' },
  { value: 'MTR', label: 'MTR metre' },
  { value: 'MTK', label: 'MTK square metre' },
  { value: 'LTR', label: 'LTR litre' },
  { value: 'KWH', label: 'KWH kilowatt hour' },
  { value: 'SET', label: 'SET set' },
  { value: 'XPP', label: 'XPP package' },
];
const MEANS = [
  { value: '30', label: 'Credit transfer (30)' },
  { value: '42', label: 'Payment to bank account (42)' },
  { value: '58', label: 'SEPA credit transfer (58)' },
  { value: '10', label: 'Cash (10)' },
  { value: '48', label: 'Bank card (48)' },
  { value: '49', label: 'Direct debit (49)' },
  { value: '1', label: 'Not specified (1)' },
];
const CATEGORY_NAMES: Record<VatCategory, string> = {
  S: 'S standard rate',
  Z: 'Z zero rated',
  E: 'E exempt',
  AE: 'AE reverse charge',
  K: 'K intra-community',
  G: 'G export outside the EU',
  O: 'O not subject to VAT',
  L: 'L Canary Islands (IGIC)',
  M: 'M Ceuta and Melilla (IPSI)',
};

const num = (s: string) => {
  const n = Number(s.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const money = (n: number) => n.toFixed(2);

/** A number field that keeps what is typed (commas, a trailing point) until it parses. */
function NumberInput({ value, onChange, className, ariaLabel, testId }: { value: number; onChange: (n: number) => void; className?: string; ariaLabel?: string; testId?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (num(text) !== value) setText(String(value));
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(num(e.target.value));
      }}
    />
  );
}

function Row({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? 'col-span-2 flex flex-col gap-0.5' : 'flex flex-col gap-0.5'}>
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-app p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function PartyFields({ party, onChange, profile, who }: { party: DraftParty; onChange: (p: DraftParty) => void; profile: EInvoiceProfile; who: 'seller' | 'buyer' }) {
  const set = (k: keyof DraftParty) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...party, [k]: e.target.value });
  const ro = party.country.toUpperCase() === 'RO';
  const tid = (k: string) => `einv-${who}-${k}`;
  const ep = defaultEndpoint(party);
  return (
    <div className="grid grid-cols-4 gap-2">
      <Row label="Name" wide>
        <Input value={party.name} onChange={set('name')} data-testid={tid('name')} />
      </Row>
      <Row label={ro ? 'VAT number (RO + CUI)' : 'VAT number'}>
        <Input value={party.vatId} onChange={set('vatId')} data-testid={tid('vat')} />
      </Row>
      <Row label={ro ? (who === 'buyer' ? 'CUI / CNP / Reg. no.' : 'CUI / Reg. no.') : 'Registration no.'}>
        <Input value={party.companyId} onChange={set('companyId')} data-testid={tid('reg')} />
      </Row>
      <Row label="Street and number" wide>
        <Input value={party.street} onChange={set('street')} data-testid={tid('street')} />
      </Row>
      <Row label="Country">
        <Input value={party.country} maxLength={2} onChange={(e) => onChange({ ...party, country: e.target.value.toUpperCase() })} data-testid={tid('country')} />
      </Row>
      <Row label={ro ? 'County' : 'Region'}>
        {ro ? (
          <span data-no-translate className="block">
            <Select
              value={party.region}
              ariaLabel="County"
              onChange={(v) => onChange({ ...party, region: v, city: v === 'RO-B' && !BUCHAREST_SECTORS.includes(party.city) ? 'SECTOR1' : party.city })}
              options={[{ value: '', label: '—' }, ...Object.entries(RO_COUNTIES).map(([value, name]) => ({ value, label: `${name} (${value})` })).sort((a, b) => a.label.localeCompare(b.label, 'ro'))]}
            />
          </span>
        ) : (
          <Input value={party.region} onChange={set('region')} />
        )}
      </Row>
      <Row label={ro && party.region === 'RO-B' ? 'Sector' : 'City'}>
        {ro && party.region === 'RO-B' ? (
          <span data-no-translate className="block">
            <Select value={party.city} ariaLabel="Sector" onChange={(v) => onChange({ ...party, city: v })} options={BUCHAREST_SECTORS.map((s) => ({ value: s, label: s }))} />
          </span>
        ) : (
          <Input value={party.city} onChange={set('city')} data-testid={tid('city')} />
        )}
      </Row>
      <Row label="Postal code">
        <Input value={party.postalCode} onChange={set('postalCode')} />
      </Row>
      <Row label="E-mail">
        <Input value={party.email} onChange={set('email')} />
      </Row>
      <Row label="Phone">
        <Input value={party.phone} onChange={set('phone')} />
      </Row>
      {profile === 'peppol' ? (
        <>
          <Row label="Electronic address (endpoint)" wide>
            <Input value={party.endpointId} onChange={set('endpointId')} placeholder={ep.id} data-testid={tid('endpoint')} />
          </Row>
          <Row label="Scheme (EAS)">
            <Input value={party.endpointScheme} onChange={set('endpointScheme')} placeholder={ep.scheme} />
          </Row>
        </>
      ) : null}
    </div>
  );
}

/** Peppol endpoints default to the VAT number (or e-mail) when left empty. */
function withDefaults(d: InvoiceDraft): InvoiceDraft {
  if (d.profile !== 'peppol') return d;
  const fill = (p: DraftParty) => {
    if (p.endpointId.trim()) return p;
    const ep = defaultEndpoint(p);
    return { ...p, endpointId: ep.id, endpointScheme: ep.scheme };
  };
  return { ...d, seller: fill(d.seller), buyer: fill(d.buyer) };
}

export function EInvoiceCreateModal() {
  const open = usePDFStore((s) => s.modal === 'einvoiceNew');
  const close = () => usePDFStore.getState().openModal(null);
  const [book, setBook] = useState<InvoiceBook>(emptyBook());
  const [sellerId, setSellerId] = useState('');
  const [draft, setDraft] = useState<InvoiceDraft>(() => emptyDraft());
  const [editSeller, setEditSeller] = useState(false);
  const [buyerQuery, setBuyerQuery] = useState('');
  const [outputs, setOutputs] = useState<EInvoiceOutput[]>(['xml', 'pdf']);
  const [saveProducts, setSaveProducts] = useState(true);
  const [notesText, setNotesText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const m = await import('@/actions/einvoiceCreate');
      const b = await m.loadInvoiceBook();
      const prefill = m.useInvoicePrefill.getState().draft;
      setBook(b);
      const seller = b.sellers.find((s) => s.id === b.lastSellerId) ?? b.sellers[0];
      const matched = prefill ? b.sellers.find((s) => (s.party.vatId || s.party.companyId) && (s.party.vatId || s.party.companyId) === (prefill.seller.vatId || prefill.seller.companyId)) : seller;
      setSellerId(matched?.id ?? '');
      const d = prefill ?? (seller ? draftForSeller(seller) : emptyDraft('ro'));
      setDraft(d);
      setNotesText(d.notes.join('\n'));
      setEditSeller(!matched);
      setBuyerQuery('');
      setOutputs(d.profile === 'facturx' ? ['pdf'] : ['xml', 'pdf']);
    })();
  }, [open]);

  const effective = useMemo(() => withDefaults({ ...draft, notes: notesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }), [draft, notesText]);
  const calc = useMemo(() => calculate(effective), [effective]);
  const issues = useMemo(() => validateInvoice(calc), [calc]);
  const errors = issues.filter((i) => i.severity === 'error');
  const seller = book.sellers.find((s) => s.id === sellerId);
  const matches = useMemo(() => (buyerQuery.trim() ? searchCustomers(book, buyerQuery) : []), [book, buyerQuery]);
  const exemptCats = [...new Set(draft.lines.map((l) => l.vatCategory).concat(draft.allowances.map((a) => a.vatCategory)))].filter((c) => EXEMPT_CATEGORIES.has(c));

  const patch = (p: Partial<InvoiceDraft>) => setDraft((d) => ({ ...d, ...p }));
  const setLine = (i: number, p: Partial<DraftLine>) => setDraft((d) => ({ ...d, lines: d.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) }));
  const persist = async (b: InvoiceBook) => {
    setBook(b);
    const m = await import('@/actions/einvoiceCreate');
    await m.saveInvoiceBook(b);
  };

  const pickSeller = (id: string) => {
    setSellerId(id);
    const s = book.sellers.find((x) => x.id === id);
    if (!s) {
      setEditSeller(true);
      return;
    }
    const fresh = draftForSeller(s, draft.issueDate);
    setDraft((d) => ({ ...d, profile: s.profile, seller: fresh.seller, number: d.typeCode === '381' && d.number ? d.number : fresh.number, currency: fresh.currency, dueDate: fresh.dueDate || d.dueDate, payment: { ...d.payment, iban: fresh.payment.iban, bic: fresh.payment.bic, accountName: fresh.payment.accountName, terms: fresh.payment.terms || d.payment.terms } }));
    setEditSeller(false);
  };

  const saveSeller = async () => {
    const base: SellerProfile = seller ?? newSeller(draft.seller.country);
    const accounts = draft.payment.iban.trim() ? [{ iban: draft.payment.iban.replace(/\s+/g, ''), bic: draft.payment.bic, bank: '' }, ...base.accounts.filter((a) => a.iban !== draft.payment.iban.replace(/\s+/g, ''))] : base.accounts;
    const s: SellerProfile = { ...base, party: { ...draft.seller }, accounts, profile: draft.profile, currency: draft.currency, terms: draft.payment.terms };
    const sellers = book.sellers.some((x) => x.id === s.id) ? book.sellers.map((x) => (x.id === s.id ? s : x)) : [...book.sellers, s];
    await persist({ ...book, sellers, lastSellerId: s.id });
    setSellerId(s.id);
    usePDFStore.getState().toast('Seller profile saved.', 'success');
  };
  const updateSeller = (p: Partial<SellerProfile>) => {
    if (!seller) return;
    void persist({ ...book, sellers: book.sellers.map((x) => (x.id === seller.id ? { ...x, ...p } : x)) });
  };
  const pickLogo = async () => {
    const f = (await pickFiles([{ name: 'Images (PNG, JPEG)', extensions: ['png', 'jpg', 'jpeg'] }], false))[0];
    if (f) updateSeller({ logo: bytesToBase64(f.bytes) });
  };

  const create = async () => {
    setBusy(true);
    try {
      const m = await import('@/actions/einvoiceCreate');
      if (await m.issueEInvoice(effective, outputs, sellerId, saveProducts)) close();
    } finally {
      setBusy(false);
    }
  };

  const toggleOutput = (o: EInvoiceOutput, on: boolean) => setOutputs((all) => (on ? [...all.filter((x) => x !== o), o] : all.filter((x) => x !== o)));
  const xmlLabel = draft.profile === 'ro' ? 'e-Factura XML (for ANAF SPV)' : draft.profile === 'peppol' ? 'Peppol UBL XML' : 'Factur-X XML (CII)';
  const series = seller?.series[0];
  const roForeign = draft.profile === 'ro' && draft.currency !== 'RON';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="New e-invoice"
      description="Made on this computer. Upload the e-Factura XML to ANAF's SPV yourself."
      width={1040}
      testId="einvoice-new-modal"
      footer={
        <>
          <div className="mr-auto flex flex-wrap items-center gap-x-4" data-testid="einv-outputs">
            <Checkbox checked={outputs.includes('xml')} onChange={(v) => toggleOutput('xml', v)} label={xmlLabel} ariaLabel="XML file" />
            <Checkbox checked={outputs.includes('pdf')} onChange={(v) => toggleOutput('pdf', v)} label={draft.profile === 'facturx' ? 'Factur-X PDF' : 'PDF with XML attached (PDF/A-3)'} ariaLabel="PDF with XML" />
            {draft.profile !== 'facturx' ? <Checkbox checked={outputs.includes('facturx')} onChange={(v) => toggleOutput('facturx', v)} label="Factur-X PDF" ariaLabel="Factur-X PDF" /> : null}
          </div>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || errors.length > 0 || !outputs.length} onClick={() => void create()} data-testid="einv-create">
            Create e-invoice
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_300px] gap-3 text-[13px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Row label="Seller profile">
              <span data-no-translate className="block">
                <Select value={sellerId} ariaLabel="Seller profile" onChange={pickSeller} options={[...book.sellers.map((s) => ({ value: s.id, label: s.party.name || '?' })), { value: '', label: translate('New seller…') }]} />
              </span>
            </Row>
            <Row label="Format">
              <Select value={draft.profile} ariaLabel="Format" onChange={(v) => patch({ profile: v })} options={PROFILES} />
            </Row>
            <Row label="Type">
              <Select value={draft.typeCode} ariaLabel="Type" onChange={(v) => patch({ typeCode: v })} options={TYPES} />
            </Row>
          </div>

          <Section
            title="Seller"
            right={
              <div className="flex gap-1">
                {!editSeller ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditSeller(true)}>
                    Edit
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => void saveSeller()} data-testid="einv-save-seller">
                  <Save size={13} /> Save seller profile
                </Button>
              </div>
            }
          >
            {editSeller ? (
              <>
                <PartyFields party={draft.seller} onChange={(p) => patch({ seller: p })} profile={draft.profile} who="seller" />
                {seller ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Row label="Number prefix">
                      <Input className="w-32" value={series?.prefix ?? ''} onChange={(e) => updateSeller({ series: [{ ...(series ?? { next: 1, digits: 4 }), prefix: e.target.value }] })} />
                    </Row>
                    <Row label="Next number">
                      <NumberInput className="w-20" value={series?.next ?? 1} onChange={(n) => updateSeller({ series: [{ ...(series ?? { prefix: '', digits: 4 }), next: Math.max(1, Math.floor(n)) }] })} />
                    </Row>
                    <Row label="Digits">
                      <NumberInput className="w-14" value={series?.digits ?? 4} onChange={(n) => updateSeller({ series: [{ ...(series ?? { prefix: '', next: 1 }), digits: Math.min(10, Math.max(0, Math.floor(n))) }] })} />
                    </Row>
                    <Row label="Payment days">
                      <NumberInput className="w-16" value={seller.paymentDays} onChange={(n) => updateSeller({ paymentDays: Math.max(0, Math.floor(n)) })} />
                    </Row>
                    <Button size="sm" onClick={() => void pickLogo()}>
                      <ImagePlus size={13} /> {seller.logo ? 'Change logo…' : 'Logo…'}
                    </Button>
                    {seller.logo ? (
                      <Button size="sm" variant="ghost" onClick={() => updateSeller({ logo: '' })}>
                        Remove logo
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted">Save the seller profile to keep these details, the bank account and a numbering series for the next invoices.</p>
                )}
              </>
            ) : (
              <div className="text-xs" data-no-translate>
                <b>{draft.seller.name}</b> · {[draft.seller.vatId || draft.seller.companyId, draft.seller.city, draft.seller.country].filter(Boolean).join(' · ')}
              </div>
            )}
          </Section>

          <Section title="Buyer">
            <div className="relative mb-2">
              <Input value={buyerQuery} onChange={(e) => setBuyerQuery(e.target.value)} placeholder="Search saved customers (name, CUI, VAT number, city)" data-testid="einv-buyer-search" />
              {matches.length ? (
                <div className="absolute left-0 right-0 top-9 z-10 max-h-56 overflow-auto rounded-md border border-app bg-panel shadow-lg" data-no-translate>
                  {matches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="block w-full px-2 py-1.5 text-left text-xs hover-app"
                      data-testid="einv-buyer-match"
                      onClick={() => {
                        const { id: _id, lastUsed: _u, ...party } = c;
                        patch({ buyer: party });
                        setBuyerQuery('');
                      }}
                    >
                      <b>{c.name}</b> <span className="text-muted">{[c.vatId || c.companyId, c.city].filter(Boolean).join(' · ')}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <PartyFields party={draft.buyer} onChange={(p) => patch({ buyer: p })} profile={draft.profile} who="buyer" />
          </Section>

          <Section title="Invoice">
            <div className="grid grid-cols-4 gap-2">
              <Row label="Number">
                <Input value={draft.number} onChange={(e) => patch({ number: e.target.value })} data-testid="einv-number" />
              </Row>
              <Row label="Issue date">
                <Input type="date" value={draft.issueDate} onChange={(e) => patch({ issueDate: e.target.value })} />
              </Row>
              <Row label="Due date">
                <Input type="date" value={draft.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} data-testid="einv-due" />
              </Row>
              <Row label="Delivery date">
                <Input type="date" value={draft.deliveryDate} onChange={(e) => patch({ deliveryDate: e.target.value })} />
              </Row>
              <Row label="Currency">
                <Input value={draft.currency} maxLength={3} onChange={(e) => patch({ currency: e.target.value.toUpperCase() })} data-testid="einv-currency" />
              </Row>
              {roForeign ? (
                <Row label={`RON per 1 ${draft.currency}`}>
                  <NumberInput value={draft.exchangeRate} onChange={(n) => patch({ exchangeRate: n })} testId="einv-rate" />
                </Row>
              ) : null}
              <Row label="Buyer reference">
                <Input value={draft.buyerReference} onChange={(e) => patch({ buyerReference: e.target.value })} />
              </Row>
              <Row label="Order no.">
                <Input value={draft.orderReference} onChange={(e) => patch({ orderReference: e.target.value })} />
              </Row>
              <Row label="Contract">
                <Input value={draft.contractReference} onChange={(e) => patch({ contractReference: e.target.value })} />
              </Row>
              {draft.typeCode === '381' || draft.typeCode === '384' || draft.precedingNumber ? (
                <>
                  <Row label="Corrected invoice no.">
                    <Input value={draft.precedingNumber} onChange={(e) => patch({ precedingNumber: e.target.value })} data-testid="einv-preceding" />
                  </Row>
                  <Row label="Its issue date">
                    <Input type="date" value={draft.precedingDate} onChange={(e) => patch({ precedingDate: e.target.value })} />
                  </Row>
                </>
              ) : null}
            </div>
          </Section>

          <Section
            title="Lines"
            right={
              <div className="flex items-center gap-1">
                {book.products.length ? (
                  <span data-no-translate className="block w-56">
                    <Select
                      value=""
                      ariaLabel="Add from catalogue"
                      onChange={(id) => {
                        const p = book.products.find((x) => x.id === id);
                        if (p) setDraft((d) => ({ ...d, lines: [...d.lines.filter((l) => l.name.trim() || l.price), lineFromProduct(p)] }));
                      }}
                      options={[{ value: '', label: translate('Add from catalogue…') }, ...book.products.map((p) => ({ value: p.id, label: `${p.name} · ${p.price}` }))]}
                    />
                  </span>
                ) : null}
                <Button size="sm" onClick={() => setDraft((d) => ({ ...d, lines: [...d.lines, { ...emptyLine(), vatPercent: d.lines[d.lines.length - 1]?.vatPercent ?? 21 }] }))} data-testid="einv-add-line">
                  <Plus size={13} /> Add line
                </Button>
              </div>
            }
          >
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] text-muted">
                <tr>
                  <th className="pb-1 font-normal">Item</th>
                  <th className="w-16 pb-1 font-normal">Qty</th>
                  <th className="w-28 pb-1 font-normal">Unit</th>
                  <th className="w-20 pb-1 font-normal">Price</th>
                  <th className="w-14 pb-1 font-normal">Disc. %</th>
                  <th className="w-36 pb-1 font-normal">VAT</th>
                  <th className="w-20 pb-1 text-right font-normal">Amount</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l, i) => (
                  <tr key={i} className="align-top" data-testid="einv-line">
                    <td className="py-0.5 pr-1">
                      <Input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label="Item name" data-testid="einv-line-name" />
                      <Input className="mt-0.5 h-6 text-[11px]" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description (optional)" aria-label="Description" />
                    </td>
                    <td className="py-0.5 pr-1">
                      <NumberInput value={l.quantity} onChange={(n) => setLine(i, { quantity: n })} ariaLabel="Quantity" testId="einv-line-qty" />
                    </td>
                    <td className="py-0.5 pr-1" data-no-translate>
                      <Select value={l.unit} ariaLabel="Unit" onChange={(v) => setLine(i, { unit: v })} options={UNITS.some((u) => u.value === l.unit) ? UNITS : [...UNITS, { value: l.unit, label: l.unit }]} />
                    </td>
                    <td className="py-0.5 pr-1">
                      <NumberInput value={l.price} onChange={(n) => setLine(i, { price: n })} ariaLabel="Price" testId="einv-line-price" />
                    </td>
                    <td className="py-0.5 pr-1">
                      <NumberInput value={l.discountPercent} onChange={(n) => setLine(i, { discountPercent: n })} ariaLabel="Discount %" />
                    </td>
                    <td className="py-0.5 pr-1">
                      <div className="flex gap-0.5">
                        <Select className="w-16 px-1" value={l.vatCategory} ariaLabel="VAT category" onChange={(v) => setLine(i, { vatCategory: v })} options={VAT_CATEGORIES.map((c) => ({ value: c, label: c }))} />
                        <NumberInput className="w-14" value={l.vatPercent} onChange={(n) => setLine(i, { vatPercent: n })} ariaLabel="VAT rate" testId="einv-line-vat" />
                      </div>
                    </td>
                    <td className="py-1.5 text-right font-medium" data-no-translate>
                      {money(calc.lines[i]?.net ?? 0)}
                    </td>
                    <td className="py-0.5">
                      <button type="button" aria-label="Remove line" className="rounded p-1 hover-app" onClick={() => setDraft((d) => ({ ...d, lines: d.lines.filter((_, k) => k !== i) }))}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {draft.allowances.map((a, i) => (
              <div key={i} className="mt-1 flex items-center gap-1 text-xs">
                <span className="w-24 text-muted">{a.charge ? 'Charge' : 'Discount'}</span>
                <Input className="flex-1" value={a.reason} placeholder="Reason" onChange={(e) => setDraft((d) => ({ ...d, allowances: d.allowances.map((x, k) => (k === i ? { ...x, reason: e.target.value } : x)) }))} />
                <NumberInput className="w-24" value={a.amount} ariaLabel="Amount" onChange={(n) => setDraft((d) => ({ ...d, allowances: d.allowances.map((x, k) => (k === i ? { ...x, amount: n } : x)) }))} />
                <Select className="w-16 px-1" value={a.vatCategory} ariaLabel="VAT category" onChange={(v) => setDraft((d) => ({ ...d, allowances: d.allowances.map((x, k) => (k === i ? { ...x, vatCategory: v } : x)) }))} options={VAT_CATEGORIES.map((c) => ({ value: c, label: c }))} />
                <NumberInput className="w-14" value={a.vatPercent} ariaLabel="VAT rate" onChange={(n) => setDraft((d) => ({ ...d, allowances: d.allowances.map((x, k) => (k === i ? { ...x, vatPercent: n } : x)) }))} />
                <button type="button" aria-label="Remove" className="rounded p-1 hover-app" onClick={() => setDraft((d) => ({ ...d, allowances: d.allowances.filter((_, k) => k !== i) }))}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="mt-2 flex flex-wrap gap-1">
              {[false, true].map((charge) => (
                <Button key={String(charge)} size="sm" variant="ghost" onClick={() => setDraft((d) => ({ ...d, allowances: [...d.allowances, { charge, reason: '', amount: 0, vatCategory: d.lines[0]?.vatCategory ?? 'S', vatPercent: d.lines[0]?.vatPercent ?? 21 }] }))}>
                  <Plus size={13} /> {charge ? 'Document charge' : 'Document discount'}
                </Button>
              ))}
            </div>
            {exemptCats.length ? (
              <div className="mt-2 flex flex-col gap-1">
                {exemptCats.map((c) => {
                  const ex = draft.exemptions[c] ?? calc.vat.find((v) => v.category === c);
                  const code = ex ? ('code' in ex ? ex.code : ex.exemptionCode) : '';
                  const reason = ex ? ('reason' in ex ? ex.reason : ex.exemptionReason) : '';
                  return (
                    <div key={c} className="flex items-center gap-1 text-xs">
                      <span className="w-40 text-muted">{CATEGORY_NAMES[c]}</span>
                      <Input className="w-36" value={code} placeholder="VATEX code" aria-label="VATEX code" onChange={(e) => patch({ exemptions: { ...draft.exemptions, [c]: { code: e.target.value, reason } } })} />
                      <Input className="flex-1" value={reason} placeholder="Exemption reason" aria-label="Exemption reason" onChange={(e) => patch({ exemptions: { ...draft.exemptions, [c]: { code, reason: e.target.value } } })} />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </Section>

          <Section title="Payment and notes">
            <div className="grid grid-cols-4 gap-2">
              <Row label="Payment means">
                <Select value={draft.payment.meansCode} ariaLabel="Payment means" onChange={(v) => patch({ payment: { ...draft.payment, meansCode: v } })} options={MEANS} />
              </Row>
              <Row label="IBAN" wide>
                <Input value={draft.payment.iban} onChange={(e) => patch({ payment: { ...draft.payment, iban: e.target.value } })} list="einv-ibans" data-testid="einv-iban" />
                <datalist id="einv-ibans">
                  {seller?.accounts.map((a) => <option key={a.iban} value={a.iban} />)}
                </datalist>
              </Row>
              <Row label="BIC">
                <Input value={draft.payment.bic} onChange={(e) => patch({ payment: { ...draft.payment, bic: e.target.value } })} />
              </Row>
              <Row label="Payment reference">
                <Input value={draft.payment.reference} onChange={(e) => patch({ payment: { ...draft.payment, reference: e.target.value } })} />
              </Row>
              <Row label="Payment terms" wide>
                <Input value={draft.payment.terms} onChange={(e) => patch({ payment: { ...draft.payment, terms: e.target.value } })} />
              </Row>
              <Row label="Paid in advance">
                <NumberInput value={draft.prepaid} onChange={(n) => patch({ prepaid: n })} />
              </Row>
              <Row label="Notes (one per line)" wide>
                <Textarea rows={2} value={notesText} onChange={(e) => setNotesText(e.target.value)} />
              </Row>
              <Row label="Rounding">
                <span className="flex gap-1">
                  <NumberInput value={draft.rounding} onChange={(n) => patch({ rounding: n })} ariaLabel="Rounding" />
                  <Button size="sm" variant="ghost" onClick={() => patch({ rounding: roundingFor(calc.totals.taxInclusive, calc.totals.prepaid, 1) })} title="Round the amount due to a whole unit">
                    ±1
                  </Button>
                </span>
              </Row>
            </div>
          </Section>
        </div>

        <aside className="flex flex-col gap-3">
          <Section title="Totals">
            <div className="flex flex-col gap-0.5 text-xs" data-testid="einv-totals">
              <Total label="Sum of lines" value={calc.totals.lineNet} />
              {calc.totals.allowances ? <Total label="Discount" value={-calc.totals.allowances} /> : null}
              {calc.totals.charges ? <Total label="Charge" value={calc.totals.charges} /> : null}
              <Total label="Total without VAT" value={calc.totals.taxExclusive} />
              <Total label="Total VAT" value={calc.totals.tax} />
              <Total label="Total with VAT" value={calc.totals.taxInclusive} />
              {calc.totals.prepaid ? <Total label="Paid in advance" value={-calc.totals.prepaid} /> : null}
              {calc.totals.rounding ? <Total label="Rounding" value={calc.totals.rounding} /> : null}
              <div className="mt-1 flex justify-between border-t border-app pt-1 text-[13px] font-semibold">
                <span>Amount due</span>
                <span data-no-translate data-testid="einv-payable">{`${money(calc.totals.payable)} ${draft.currency}`}</span>
              </div>
              {calc.taxCurrency ? (
                <div className="flex justify-between text-muted">
                  <span>VAT in RON</span>
                  <span data-no-translate>{money(calc.taxCurrency.tax)}</span>
                </div>
              ) : null}
            </div>
            <table className="mt-2 w-full text-[11px]">
              <thead className="text-muted">
                <tr>
                  <th className="text-left font-normal">VAT</th>
                  <th className="text-right font-normal">Taxable amount</th>
                  <th className="text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody data-no-translate>
                {calc.vat.map((v) => (
                  <tr key={`${v.category}${v.percent}`}>
                    <td>{`${v.category}${v.percent === null ? '' : ` ${v.percent}%`}`}</td>
                    <td className="text-right">{money(v.taxable)}</td>
                    <td className="text-right">{money(v.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Checks">
            {issues.length ? (
              <ul className="flex flex-col gap-1 text-[11.5px]" data-testid="einv-issues">
                {issues.map((i, k) => (
                  <li key={k} className={i.severity === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}>
                    <span className="mr-1 font-mono text-[10px] opacity-70" data-no-translate>
                      {i.rule}
                    </span>
                    <span data-no-translate>{translate(i.message)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Callout kind="success">
                <span data-testid="einv-valid">No problems found.</span>
              </Callout>
            )}
          </Section>
          <Checkbox checked={saveProducts} onChange={setSaveProducts} label="Add the items to the catalogue" />
        </aside>
      </div>
    </Dialog>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span data-no-translate>{money(value)}</span>
    </div>
  );
}
