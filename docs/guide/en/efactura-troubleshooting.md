# e-Factura problems and ANAF error messages

## ANAF error messages

ANAF names the rule an invoice breaks at the start of each message, for example `BR-RO-110`. Rules starting with **BR-RO** are Romanian (CIUS-RO); **BR-** and **BR-CO-** come from the European standard EN 16931. Adika checks most of them before you create the invoice and shows the same rule ids in **Checks**.

| Rule | What it means | What to do |
| --- | --- | --- |
| **BR-RO-110** | The county is missing or not an official code. | Choose the **County** from the list (RO-CJ, RO-B…). |
| **BR-RO-100** | In Bucharest the city must be the sector. | Choose **București (RO-B)**, then the **Sector** (SECTOR1 to SECTOR6). |
| **BR-RO-080**, **BR-RO-090** | The street or the city of the seller or buyer is missing. | Fill in **Street and number** and **City**. |
| **BR-RO-120** | The buyer has no VAT number or registration number. | Fill in the buyer's CUI (or the CNP of a person). |
| **BR-RO-030** | An invoice in another currency needs the VAT total in RON. | Enter the exchange rate in **RON per 1 EUR** (or the currency you use). |
| **BR-RO-010** | The invoice number has no digit. | Use a number with at least one digit. |
| **BR-RO-020** | The invoice type is not accepted. | Use 380, 381, 384, 389 or 751. |
| **BR-RO-L…** (L020 … L300) | A text is too long; the number is the limit (BR-RO-L100 = at most 100 characters). | Shorten the text named in the message (item name, street, notes…). |
| **BR-RO-A020** | More than 20 notes. | Merge notes. |
| **BR-CO-09** | A VAT number does not start with the country code. | Write `RO12345678`, not `12345678`; a company not registered for VAT puts its CUI in the registration number instead. |
| **BR-CO-10**, **BR-CO-13**, **BR-CO-15**, **BR-CO-16** | The totals do not add up (sum of lines, total without VAT, total with VAT, amount due). | Usually a rounding error in another program. Invoices made in Adika are calculated by these rules. |
| **BR-S-08**, **BR-CO-17** | The VAT of a rate is not taxable amount × rate. | As above. |
| **BR-16**, **BR-25**, **BR-22**, **BR-23** | No lines; a line without name, quantity or a valid unit code. | Complete the lines. |
| **BR-27** | A negative price. | Keep the price positive and make the quantity negative. |
| **BR-61** | A credit transfer without IBAN. | Fill in the **IBAN**. |
| **BR-E-10**, **BR-AE-10**, **BR-IC-10**, **BR-G-10**, **BR-O-10** | An exempt VAT category without a reason. | Fill in the **VATEX code** or the **Exemption reason**. |
| **BR-AE-02**, **BR-IC-02** | Reverse charge or intra-community supply without the VAT numbers. | Fill in both VAT numbers. |

Messages that mention *schema*, *cvc-* or *SAXParseException* mean the XML file itself is malformed. That happens with files from other programs; ask the program's supplier.

Two Adika checks have no ANAF rule id: **CIUS-RO BT-31** and **CIUS-RO BT-48** say that the seller's or buyer's CUI or CNP has a wrong check digit. Check the number for a typing error.

## Sign-in problems (Connect…)

- **Nothing happens in the browser, or the browser shows "This site can't be reached" at the end.** Adika waits on the port of your callback URL (for example 8765). Another program may be using that port, or a firewall blocks it. Choose another port, change the callback URL **both** in your application at ANAF and in Adika's **Settings**, and connect again.
- **"ANAF refused the sign-in: …"** ANAF did not accept the application details. Check the **Client ID**, **Client secret** and **Callback URL**: they must be exactly as registered (including `http` and the final `/callback`).
- **"The callback URL must be https:// or http://localhost:<port>/…, exactly as registered with ANAF."** The callback URL in Settings is not a usable address.
- **"The sign-in answer did not match this request. Try again."** You finished an older sign-in in another browser tab. Close the old tabs and press **Connect…** again.
- **"Connect to ANAF again: …"** The stored sign-in expired or was withdrawn. Press **Connect…**.
- **The browser does not ask for the certificate.** Plug in the token before you connect, close all browser windows and try again. The token's driver must be installed.
- **"Sign-in cancelled."** You pressed Cancel, or closed the paste box.

## Sending problems

- **"ANAF refused access: the certificate used to connect needs SPV rights for this CUI, and the application must be registered for e-Factura."** The certificate you signed in with has no SPV rights for the **CUI (SPV)** you entered, or the application at ANAF does not have the E-Factura service ticked.
- **"Not a valid CUI: …"** The CUI has a wrong check digit. Write it without RO.
- **"ANAF limits how often its services can be called. Wait a little and try again."** Too many requests in a short time.
- **"ANAF's e-Factura service answered HTTP 5xx. Try again later."** ANAF's servers have a problem.
- **The status stays "Being processed".** ANAF sometimes needs longer than 10 minutes. Check later with **Check status** on the **Sent log** tab, or look in SPV.
- **Sent to the test environment by mistake.** Test uploads have no legal effect. Untick **Use ANAF's test environment**, connect again and send the invoice again.

## Opening and downloading problems

- **"This file is not an electronic invoice (UBL, e-Factura or CII)."** The file is another kind of XML, or the ZIP holds no invoice.
- **"The download holds no invoice."** or a list of errors when you open a message: the message is an error report, not an invoice. **Save** keeps it; the errors are shown in the window.

## Looking up a CUI

- **"ANAF has no company with this CUI."** Check the number.
- **"ANAF lists the company as inactive"** or **"… deregistered (radiată)"**: ANAF's register says so. Ask your accountant before invoicing.
- **"Not registered for VAT: the VAT number was left empty."** The company is not a VAT payer; that is correct on the invoice.
- **"ANAF limits how often its register can be asked. Wait a moment and try again."**

## Online features turned off by your organisation

If you see **"The ANAF connection is turned off by your organisation."**, your IT department has turned off Adika's online features with a Windows policy. The CUI lookup, Check with ANAF and SPV do not work; creating and reading invoices still work. You can upload the XML through SPV's web pages, or ask IT to allow it. **About** (the **i** button) lists the policies under **Managed by your organisation**.
