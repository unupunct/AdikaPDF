/** Sample electronic invoices: a Romanian e-Factura (UBL, CIUS-RO) and a Factur-X / ZUGFeRD (CII EN 16931). */

export const EFACTURA_UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>
  <cbc:ID>ADK-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-09-15</cbc:IssueDate>
  <cbc:DueDate>2026-10-15</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Factură emisă conform contractului nr. 12/2026.</cbc:Note>
  <cbc:DocumentCurrencyCode>RON</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>PO-7781</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PostalAddress><cbc:StreetName>Str. Memorandumului 28</cbc:StreetName><cbc:CityName>Cluj-Napoca</cbc:CityName><cbc:PostalZone>400114</cbc:PostalZone><cbc:CountrySubentity>RO-CJ</cbc:CountrySubentity><cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>RO12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Adika Software SRL</cbc:RegistrationName><cbc:CompanyID>J12/3456/2020</cbc:CompanyID></cac:PartyLegalEntity>
    <cac:Contact><cbc:Telephone>0264 000 111</cbc:Telephone><cbc:ElectronicMail>facturi@adika.example</cbc:ElectronicMail></cac:Contact>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PostalAddress><cbc:StreetName>Bd. Ștefan cel Mare 4</cbc:StreetName><cbc:CityName>Iași</cbc:CityName><cbc:PostalZone>700064</cbc:PostalZone><cbc:CountrySubentity>RO-IS</cbc:CountrySubentity><cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>RO87654321</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Tipografia Moldova SA</cbc:RegistrationName><cbc:CompanyID>J22/111/1999</cbc:CompanyID></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>RO49AAAA1B31007593840000</cbc:ID><cbc:Name>Adika Software SRL</cbc:Name></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:PaymentTerms><cbc:Note>Plata în 30 de zile.</cbc:Note></cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="RON">399.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="RON">2100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="RON">399.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="RON">2100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="RON">2100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="RON">2499.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="RON">2499.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="H87">3</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="RON">1500.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Licență anuală, utilizator nominal</cbc:Description><cbc:Name>Adika PDF Editor – licență</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="RON">500.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID><cbc:InvoicedQuantity unitCode="HUR">4</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="RON">600.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Instruire utilizatori</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="RON">150.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

export const FACTURX_CII = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>RE-2026-100</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20260920</udt:DateTimeString></ram:IssueDateTime><ram:IncludedNote><ram:Content>Vielen Dank für Ihren Auftrag.</ram:Content></ram:IncludedNote></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Druckerpapier A4</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>4.50</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">20</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax><ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>90.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>04011000-12345-34</ram:BuyerReference>
      <ram:SellerTradeParty><ram:Name>Papier Müller GmbH</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>10115</ram:PostcodeCode><ram:LineOne>Hauptstraße 1</ram:LineOne><ram:CityName>Berlin</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Büro Schmidt</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>80331</ram:PostcodeCode><ram:LineOne>Marienplatz 2</ram:LineOne><ram:CityName>München</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02120300000000202051</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax><ram:CalculatedAmount>17.10</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>90.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20261020</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>90.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>90.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">17.10</ram:TaxTotalAmount><ram:GrandTotalAmount>107.10</ram:GrandTotalAmount><ram:DuePayableAmount>107.10</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
