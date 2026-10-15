# Adika PDF Editor user guide

Adika PDF Editor is a PDF program for Windows. You can read, comment, edit, sign, organise, protect and convert PDF files. This guide covers the two things most offices use it for every day:

- **e-Factura and other electronic invoices**: reading the invoices you receive, issuing your own, checking them and sending them to ANAF's SPV.
- **Digital signatures**: signing PDFs with a certificate file, a USB token or smart card, a certificate installed in Windows or a cloud signature, signing many files at once, and checking the signatures on documents you receive.

New to Adika? Start with [Getting started](getting-started.md).

## What is in this guide

**Start**

- [Getting started](getting-started.md): opening files, the ribbon, saving, undo, tabs, recovery after a crash, the interface language.

**e-Factura**

- [Read a received e-Factura](efactura-read.md)
- [Create an invoice](efactura-create.md)
- [VAT, currency and payment](efactura-vat-payment.md)
- [Credit notes](efactura-credit-notes.md)
- [Check an invoice with ANAF](efactura-anaf-check.md)
- [Send invoices to ANAF (SPV)](efactura-anaf-send.md)
- [e-Factura problems and ANAF error messages](efactura-troubleshooting.md)

**Digital signatures**

- [Signatures explained](signing-concepts.md)
- [Sign a document](signing-sign.md)
- [Visible signatures and the appearance designer](signing-appearance.md)
- [Sign many files at once](signing-batch.md)
- [Verify signatures](signing-verify.md)
- [Signing problems](signing-troubleshooting.md)

## Your files stay on your computer

Adika works offline. Opening, editing, converting, signing and creating invoices all happen on your computer; nothing is uploaded. The status bar at the bottom of the window says **Offline & private**.

A few features need the internet. They connect **only when you press their button**, and only to the service named:

| Feature | Connects to | When |
| --- | --- | --- |
| Look up the CUI at ANAF | ANAF's public VAT register | You press **Look up the CUI at ANAF** in a new invoice |
| Check with ANAF | ANAF's public validation service | You press **Check with ANAF** |
| ANAF e-Factura (SPV) | ANAF's sign-in page and e-Factura service | You connect, send, check a status or list messages |
| Trusted timestamp | The timestamp server you choose | You sign with **Add a trusted timestamp** ticked |
| Long-term validation, revocation check | The certificate issuer's OCSP / CRL servers | You sign with LTV, or verify with **Check revocation online** |
| EU Trusted Lists | The European Commission and the national lists | You press **Download** or **Update** in Signature verification |
| Cloud signature | Your trust service provider | You sign in and sign |
| Update check | GitHub | You press **Check for updates** in About, or turn on the weekly check |

> **Organisation policies.** Your IT department can turn off the online features, cloud signing or the update check for everyone (Windows group policies). A feature that is turned off says so, for example "The ANAF connection is turned off by your organisation." The **About** window (the **i** button at the top right) lists the settings your organisation manages under **Managed by your organisation**.

## Opening this help

- Press **F1** anywhere in Adika. Inside a dialog, F1 opens the page about that dialog.
- Click the **?** button at the top right of the window, next to the other buttons.
- In the e-Factura and signing dialogs, click the **?** next to the dialog's close button.

The help works without internet. Use the search box at the top left to search every page; **Back** and **Forward** return to the pages you saw. The guide is also on GitHub: <https://github.com/unupunct/AdikaPDF/tree/main/docs/guide>.

## Updates

Click the **i** button (About) at the top right. Under **Updates**, press **Check for updates**. If a new version is available, **Update…** downloads and installs it after asking you; if documents have unsaved changes, Adika asks first and keeps a recovery copy of them. Tick **Check automatically once a week** if you want Adika to ask GitHub once a week; nothing else is sent.

A portable copy (the ZIP version) offers **Download portable ZIP** instead: unpack the new ZIP over the old folder; your settings in the `Data` folder stay.

New versions are also published on <https://github.com/unupunct/AdikaPDF/releases> and, for administrators, through winget.
