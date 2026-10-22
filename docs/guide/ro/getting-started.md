# Primii pași

Această pagină arată cum deschideți documente, cum vă orientați în fereastră, cum vă salvați munca și cum o recuperați după o închidere neașteptată.

![Fereastra Adika fără niciun document deschis](../img/ro/start-screen.png)

Fereastra de bun venit, panglica simplă și cea completă și filele panglicii sunt descrise în [Fereastra de bun venit și panglica](the-window.md).

## Deschiderea unui document

- Faceți clic pe **Deschidere** în fila **Pornire** sau apăsați **Ctrl+O** și alegeți fișierul.
- Sau trageți un fișier din File Explorer oriunde în fereastra Adika.
- **Recente** (în fila Pornire) arată fișierele deschise în ultima vreme.

Adika deschide fișiere PDF, imagini (JPG, PNG, HEIC, TIFF…), documente Office (Word, Excel, PowerPoint, dacă Microsoft Office este instalat) și facturi electronice (fișiere XML e-Factura și arhivele ZIP descărcate din SPV-ul ANAF). Imaginile, documentele Office și facturile sunt transformate în PDF la deschidere; fișierul original nu se modifică.

Dacă un PDF este protejat cu parolă, Adika v-o cere.

## Salvarea

- **Salvare** (Ctrl+S) scrie modificările în fișierul deschis.
- **Salvare ca…** (Ctrl+Shift+S) scrie o copie cu un nume nou și lasă originalul neschimbat.
- Un punct (●) lângă numele fișierului înseamnă că există modificări nesalvate.

Documentele provenite dintr-o factură, o imagine sau un fișier Office nu au încă un PDF pe disc: prima salvare vă întreabă unde să pună noul PDF.

> **Documente semnate.** Când salvați un PDF care are semnături digitale, Adika adaugă modificările la sfârșitul fișierului (o „actualizare incrementală”), astfel încât semnăturile rămân valide. Unele modificări nu pot fi adăugate astfel; atunci Adika vă avertizează înainte de salvare. Vedeți [Probleme la semnare](signing-troubleshooting.md#salvarea-va-invalida-semnăturile).

## Anulare și refacere

- **Anulare** (Ctrl+Z) retrage ultima modificare; apăsați din nou pentru a merge mai departe înapoi.
- **Refacere** (Ctrl+Y) readuce o modificare.

Anularea funcționează pentru editări, comentarii, modificări de pagini, căutare și înlocuire și anonimizare, până la închiderea documentului.

## Mai multe documente: filele

Fiecare document se deschide în propria filă, sub panglică.

- Faceți clic pe o filă pentru a trece la ea sau apăsați **Ctrl+Tab** (și **Ctrl+Shift+Tab** pentru a reveni).
- **Ctrl+W** închide documentul curent. Adika vă întreabă mai întâi dacă are modificări nesalvate.
- Butonul **+** de lângă file deschide alt fișier.
- Trageți o filă în afara ferestrei pentru a deschide documentul într-o fereastră separată.

<a id="after-a-crash"></a>

## După o închidere neașteptată

Adika păstrează automat o copie de siguranță a fiecărui document cu modificări nesalvate, la câteva secunde după fiecare modificare. Dacă Adika sau Windows se oprește neașteptat, la următoarea pornire fereastra **Recuperare documente nesalvate** arată aceste documente și ora ultimei copii.

1. Bifați documentele pe care le doriți înapoi.
2. Faceți clic pe **Recuperare**. Ele se deschid așa cum erau la ultima copie.
3. Salvați-le (cel mai sigur cu Salvare ca…).

**Renunțare** șterge copiile de siguranță. Când închideți Adika normal, copiile sale sunt eliminate.

## Limba și aspectul

- **Butonul de limbă** din dreapta sus (afișează limba curentă, de exemplu **RO**) schimbă interfața între English, Română, Deutsch, Français, Magyar, Italiano și Español. Acest ghid există în engleză și română; pentru celelalte limbi este afișat în engleză.
- Butonul **lună / soare** comută între modul luminos și cel întunecat.
- Butonul **i** (Despre) arată versiunea, comenzile rapide de la tastatură, actualizările și opțiunile de salvare.

<a id="drag-and-drop"></a>

## Tragere și plasare

Trageți fișiere din Explorer peste Adika. PDF-urile se deschid în file; plasate peste miniaturile paginilor sau peste o pagină, Adika vă întreabă dacă le inserează paginile acolo sau le deschide într-o filă nouă. O imagine plasată pe o pagină este așezată acolo unde ați eliberat-o. Fișierele Office și celelalte fișiere sunt convertite mai întâi în PDF. Trageți miniatura unei pagini peste fila altui document, așteptați să se deschidă, apoi plasați pagina printre miniaturile lui pentru a o copia acolo. Listele din Procesare în lot și Semnarea mai multor fișiere primesc și ele PDF-uri și dosare trase acolo.

<a id="report-a-problem"></a>

## Raportarea unei probleme

În **Despre** (butonul **i**) sau în partea de jos a ajutorului, alegeți **Raportare problemă** sau **Propunere funcție**. Adika vă arată textul pe care îl va pune într-un tichet nou pe GitHub: versiunile Adika și Windows, limba interfeței și dacă Adika este instalată sau portabilă. Documentele, numele fișierelor și dosarele dumneavoastră nu sunt incluse niciodată și nu se trimite nimic până când nu trimiteți dumneavoastră tichetul pe GitHub. **Copiere text** copiază același text, de exemplu pentru departamentul IT, când organizația nu permite deschiderea GitHub.

După o eroare gravă, Adika vă propune **Raportare eroare** la următoarea pornire. Dosarele, numele documentelor și numele dumneavoastră de utilizator Windows sunt eliminate mai întâi din raport; citiți-l, modificați-l dacă doriți, apoi deschideți GitHub. Puteți dezactiva aceste propuneri.

## Pașii următori

- [Citirea unei e-Facturi primite](efactura-read.md)
- [Emiterea unei facturi](efactura-create.md)
- [Semnarea unui document](signing-sign.md)
