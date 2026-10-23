# Ghidul utilizatorului Adika PDF Editor

Adika PDF Editor este un program PDF pentru Windows. Cu el puteți citi, comenta, edita, semna, organiza, proteja și converti fișiere PDF. Acest ghid prezintă cele două lucruri pentru care birourile îl folosesc zilnic:

- **e-Factura și alte facturi electronice**: citirea facturilor primite, emiterea propriilor facturi, verificarea lor și trimiterea în SPV-ul ANAF.
- **Semnăturile digitale**: semnarea PDF-urilor cu un fișier de certificat, cu un token USB sau un card inteligent, cu un certificat instalat în Windows sau cu o semnătură în cloud, semnarea mai multor fișiere deodată și verificarea semnăturilor de pe documentele primite.

Folosiți Adika pentru prima dată? Începeți cu [Primii pași](getting-started.md).

## Ce conține ghidul

**Început**

- [Primii pași](getting-started.md): deschiderea fișierelor, salvarea, anularea, filele, recuperarea după o închidere neașteptată, limba interfeței, tragerea și plasarea, raportarea unei probleme.
- [Fereastra de bun venit și panglica](the-window.md): fereastra de la prima pornire, panglica simplă și cea completă, unde se află instrumentele.

**e-Factura**

- [Citirea unei e-Facturi primite](efactura-read.md)
- [Emiterea unei facturi](efactura-create.md)
- [TVA, monedă și plată](efactura-vat-payment.md)
- [Note de creditare](efactura-credit-notes.md)
- [Verificarea unei facturi la ANAF](efactura-anaf-check.md)
- [Trimiterea facturilor la ANAF (SPV)](efactura-anaf-send.md)
- [Probleme e-Factura și mesajele de eroare ANAF](efactura-troubleshooting.md)

**Semnături digitale**

- [Semnăturile pe înțelesul tuturor](signing-concepts.md)
- [Semnarea unui document](signing-sign.md)
- [Semnături vizibile și proiectarea aspectului](signing-appearance.md)
- [Semnarea mai multor fișiere deodată](signing-batch.md)
- [Verificarea semnăturilor](signing-verify.md)
- [Probleme la semnare](signing-troubleshooting.md)

## Fișierele rămân pe calculatorul dumneavoastră

Adika funcționează fără internet. Deschiderea, editarea, conversia, semnarea și emiterea facturilor se fac pe calculatorul dumneavoastră; nimic nu este încărcat pe internet. Bara de stare din partea de jos a ferestrei afișează **Offline și privat**.

Câteva funcții au nevoie de internet. Ele se conectează **doar când apăsați butonul lor** și doar la serviciul indicat:

| Funcție | Se conectează la | Când |
| --- | --- | --- |
| Căutare CUI la ANAF | Registrul public al plătitorilor de TVA (ANAF) | Apăsați **Căutare CUI la ANAF** într-o factură nouă |
| Verificare la ANAF | Serviciul public de validare ANAF | Apăsați **Verificare la ANAF** |
| ANAF e-Factura (SPV) | Pagina de autentificare și serviciul e-Factura ANAF | Vă conectați, trimiteți, verificați o stare sau afișați mesajele |
| Marcă temporală de încredere | Serverul de marcare temporală ales | Semnați cu opțiunea de marcă temporală bifată |
| Validare pe termen lung, verificarea revocării | Serverele OCSP / CRL ale emitentului certificatului | Semnați cu LTV sau verificați cu **Verificare online a revocării (OCSP / CRL)** |
| Listele de încredere UE | Comisia Europeană și listele naționale | Apăsați **Descărcare** sau actualizarea listelor în fereastra Verificare semnături |
| Semnătură în cloud | Furnizorul dumneavoastră de servicii de încredere | Vă autentificați și semnați |
| Verificarea actualizărilor | GitHub | Apăsați **Căutare actualizări** în fereastra Despre sau activați verificarea săptămânală |

> **Politicile organizației.** Departamentul IT poate dezactiva pentru toți utilizatorii funcțiile online, semnarea în cloud sau verificarea actualizărilor (politici de grup Windows). O funcție dezactivată vă spune acest lucru, de exemplu „Conexiunea cu ANAF este dezactivată de organizația dumneavoastră.” Fereastra **Despre** (butonul **i** din dreapta sus) arată setările impuse, la **Gestionat de organizația dumneavoastră**.

## Cum deschideți acest ajutor

- Apăsați **F1** oriunde în Adika. Într-o fereastră de dialog, F1 deschide pagina despre acea fereastră.
- Faceți clic pe butonul **?** din dreapta sus, lângă celelalte butoane.
- În ferestrele pentru e-Factura și semnare, faceți clic pe **?** de lângă butonul de închidere al ferestrei.

Ajutorul funcționează fără internet. Căsuța de căutare din stânga sus caută în toate paginile; **Înapoi** și **Înainte** vă duc la paginile văzute anterior. Ghidul se află și pe GitHub: <https://github.com/unupunct/AdikaPDF/tree/main/docs/guide>.

## Actualizări

Faceți clic pe butonul **i** (Despre) din dreapta sus. La **Actualizări**, apăsați **Căutare actualizări**. Dacă există o versiune nouă, **Actualizare…** o descarcă și o instalează după ce vă cere confirmarea; dacă aveți documente nesalvate, Adika vă întreabă și le păstrează o copie de recuperare. Bifați **Verificare automată o dată pe săptămână** dacă doriți ca Adika să întrebe GitHub o dată pe săptămână; nu se trimite nimic altceva.

Copia portabilă (varianta ZIP) oferă în schimb **Descarcă arhiva ZIP portabilă**: dezarhivați noul ZIP peste dosarul vechi; setările din dosarul `Data` rămân.

Versiunile noi sunt publicate și pe <https://github.com/unupunct/AdikaPDF/releases> și, pentru administratori, prin winget.
