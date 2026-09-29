/**
 * Romanian strings not taken from the extracted UI text: standard stamps
 * (placed on the page in the interface language) and sentences built from
 * a count. The main dictionary is ro.json (English -> Română).
 */
export const RO_EXTRA: Record<string, string> = {
  APPROVED: 'APROBAT',
  'NOT APPROVED': 'RESPINS',
  DRAFT: 'CIORNĂ',
  FINAL: 'FINAL',
  CONFIDENTIAL: 'CONFIDENȚIAL',
  'FOR COMMENT': 'PENTRU OBSERVAȚII',
  COMPLETED: 'FINALIZAT',
  REVIEWED: 'REVIZUIT',
  RECEIVED: 'PRIMIT',
  VOID: 'ANULAT',
  'Merge {0} files': 'Combinare {0#un fișier|# fișiere|# de fișiere}',
  'Create PDF': 'Creare PDF',
  'Create PDF from {0} capture{1}': 'Creare PDF din {0#o captură|# capturi|# de capturi}',
  'Run on {0} file{1}': 'Rulare pe {0#un fișier|# fișiere|# de fișiere}',
  '{0} signature{1} · {2}': '{0#o semnătură|# semnături|# de semnături} · {2}',
  '{0} signature{1} · intact': '{0#o semnătură intactă|# semnături intacte|# de semnături intacte}',
  '{0} signature{1} · problem': '{0#o semnătură cu probleme|# semnături, cu probleme|# de semnături, cu probleme}',
  '{0} page{1}': '{0#o pagină|# pagini|# de pagini}',
  'Interface language: Română (switch to English)': 'Limba interfeței: Română (comutare la English)',
  'Interface language: English (switch to Română)': 'Limba interfeței: English (comutare la Română)',
  Language: 'Limbă',

  // Crash recovery and closing the window.
  'Recover unsaved documents': 'Recuperare documente nesalvate',
  'Adika PDF Editor closed before these documents were saved. Their last automatic backups can be opened again.':
    'Adika PDF Editor s-a închis înainte ca aceste documente să fie salvate. Ultimele copii de siguranță automate pot fi redeschise.',
  Discard: 'Renunțare',
  Recover: 'Recuperare',
  '{0} edit{1}': '{0#o modificare|# modificări|# de modificări}',
  'Recovered {0} document{1}. Save to keep the changes.': '{0#S-a recuperat un document|S-au recuperat # documente|S-au recuperat # de documente}. Salvați pentru a păstra modificările.',
  'Recovery failed: {0}': 'Recuperarea a eșuat: {0}',
  'Close Adika PDF Editor?': 'Închideți Adika PDF Editor?',
  'A document has unsaved changes. Close without saving?': 'Un document are modificări nesalvate. Închideți fără salvare?',
  '{0} documents have unsaved changes. Close without saving?': '{0#Un document are|# documente au|# de documente au} modificări nesalvate. Închideți fără salvare?',
  'Close without saving': 'Închidere fără salvare',

  // Find & redact patterns.
  'E-mail addresses': 'Adrese de e-mail',
  'Phone numbers': 'Numere de telefon',
  'IBAN bank accounts': 'Conturi bancare IBAN',
  'Romanian personal numeric codes (CNP)': 'Coduri numerice personale (CNP)',
  'Payment card numbers': 'Numere de card bancar',
  Dates: 'Date calendaristice',

  // Shapes and fonts.
  Strikethrough: 'Tăiere',
  Oval: 'Oval',
  'Insert text': 'Inserare text',
  'Mono (Noto Sans Mono)': 'Monospațiat (Noto Sans Mono)',
  'Font {0} failed to load ({1})': 'Fontul {0} nu a putut fi încărcat ({1})',

  // Images.
  'No image found in the HEIC file.': 'Fișierul HEIC nu conține nicio imagine.',
  'No image found in the TIFF file.': 'Fișierul TIFF nu conține nicio imagine.',
  'This image format is not supported.': 'Acest format de imagine nu este acceptat.',
  'Read failed': 'Citirea a eșuat',
  'Image encoding failed': 'Codificarea imaginii a eșuat',
  'JPEG encoding failed': 'Codificarea JPEG a eșuat',
  'Canvas encoding failed': 'Codificarea imaginii a eșuat',
  'Canvas 2D context unavailable': 'Suprafața de desenare nu este disponibilă',
  'Canvas 2D is not available': 'Suprafața de desenare nu este disponibilă',
  'No pages to encode': 'Nu există pagini de codificat',

  // Import errors (DXF, e-mail, EPUB, XPS, FDF/XFDF).
  'Binary DXF files are not supported. Save the drawing as ASCII DXF and try again.': 'Fișierele DXF binare nu sunt acceptate. Salvați desenul ca DXF ASCII și încercați din nou.',
  'This file is not a readable DXF drawing (no DXF sections were found).': 'Fișierul nu este un desen DXF lizibil (nu s-au găsit secțiuni DXF).',
  'The DXF file could not be read: {0}': 'Fișierul DXF nu a putut fi citit: {0}',
  'The DXF file could not be read.': 'Fișierul DXF nu a putut fi citit.',
  'Not a readable Outlook message: {0}': 'Nu este un mesaj Outlook lizibil: {0}',
  'This file is not a valid EPUB (it is not a ZIP archive).': 'Fișierul nu este un EPUB valid (nu este o arhivă ZIP).',
  'This EPUB is DRM-protected (its content is encrypted) and cannot be converted. Remove the protection with the software you bought it from, or use a DRM-free copy.':
    'Acest EPUB este protejat DRM (conținutul este criptat) și nu poate fi convertit. Eliminați protecția cu programul din care l-ați cumpărat sau folosiți o copie fără DRM.',
  'Invalid EPUB: META-INF/container.xml is missing.': 'EPUB nevalid: lipsește META-INF/container.xml.',
  'Invalid EPUB: the package (OPF) file was not found.': 'EPUB nevalid: fișierul pachetului (OPF) nu a fost găsit.',
  'This EPUB has no readable chapters.': 'Acest EPUB nu are capitole lizibile.',
  'Not an XPS package: the file is not a ZIP container': 'Nu este un pachet XPS: fișierul nu este un container ZIP',
  'Not an XPS package: no FixedDocumentSequence or FixedPage found': 'Nu este un pachet XPS: nu s-a găsit FixedDocumentSequence sau FixedPage',
  'Not an FDF file (no %FDF- header).': 'Nu este un fișier FDF (lipsește antetul %FDF-).',
  'FDF file has no /FDF dictionary.': 'Fișierul FDF nu are dicționarul /FDF.',
  'Not an XFDF file (no <xfdf> element).': 'Nu este un fișier XFDF (lipsește elementul <xfdf>).',
  'XFDF: unexpected end of file': 'XFDF: sfârșit neașteptat al fișierului',
  'XFDF: unterminated tag': 'XFDF: etichetă neterminată',
  'XFDF: malformed tag': 'XFDF: etichetă incorectă',

  // PDF/A and repair.
  'PDF/A cannot be produced from an encrypted PDF. Remove the password protection first.': 'PDF/A nu poate fi creat dintr-un PDF criptat. Eliminați mai întâi protecția prin parolă.',
  'The file is empty; there is nothing to repair.': 'Fișierul este gol; nu există nimic de reparat.',
  'This file is not a PDF (no %PDF- header found), so it cannot be repaired.': 'Fișierul nu este un PDF (lipsește antetul %PDF-), deci nu poate fi reparat.',
  'No recoverable pages: the file contains no readable PDF objects.': 'Nicio pagină recuperabilă: fișierul nu conține obiecte PDF lizibile.',
  'This PDF is encrypted and damaged. It cannot be repaired without its encryption keys;': 'Acest PDF este criptat și deteriorat. Nu poate fi reparat fără cheile de criptare;',
  'try the original, undamaged file or ask the sender for an unencrypted copy.': 'încercați fișierul original, nedeteriorat, sau cereți expeditorului o copie necriptată.',
  'No recoverable pages: no page objects survived in this file.': 'Nicio pagină recuperabilă: în fișier nu a rămas niciun obiect de pagină.',
};
