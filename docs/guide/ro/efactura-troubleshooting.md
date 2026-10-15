# Probleme e-Factura și mesajele de eroare ANAF

## Mesajele de eroare ANAF

ANAF indică la începutul fiecărui mesaj regula încălcată de factură, de exemplu `BR-RO-110`. Regulile care încep cu **BR-RO** sunt românești (CIUS-RO); **BR-** și **BR-CO-** provin din standardul european EN 16931. Adika verifică majoritatea lor înainte de emiterea facturii și afișează aceleași coduri de reguli la **Verificări**.

| Regula | Ce înseamnă | Ce faceți |
| --- | --- | --- |
| **BR-RO-110** | Județul lipsește sau nu este un cod oficial. | Alegeți **Județul** din listă (RO-CJ, RO-B…). |
| **BR-RO-100** | În București, localitatea trebuie să fie sectorul. | Alegeți **București (RO-B)**, apoi **Sectorul** (SECTOR1 până la SECTOR6). |
| **BR-RO-080**, **BR-RO-090** | Lipsește strada sau localitatea furnizorului ori a cumpărătorului. | Completați **Strada și numărul** și **Localitatea**. |
| **BR-RO-120** | Cumpărătorul nu are cod de TVA sau număr de înregistrare. | Completați CUI-ul cumpărătorului (sau CNP-ul unei persoane fizice). |
| **BR-RO-030** | O factură în altă monedă trebuie să indice totalul TVA în RON. | Introduceți cursul la **RON pentru 1 EUR** (sau moneda folosită). |
| **BR-RO-010** | Numărul facturii nu conține nicio cifră. | Folosiți un număr cu cel puțin o cifră. |
| **BR-RO-020** | Tipul facturii nu este acceptat. | Folosiți 380, 381, 384, 389 sau 751. |
| **BR-RO-L…** (L020 … L300) | Un text este prea lung; numărul este limita (BR-RO-L100 = cel mult 100 de caractere). | Scurtați textul indicat în mesaj (denumirea articolului, strada, mențiunile…). |
| **BR-RO-A020** | Mai mult de 20 de mențiuni. | Combinați mențiunile. |
| **BR-CO-09** | Un cod de TVA nu începe cu codul țării. | Scrieți `RO12345678`, nu `12345678`; o firmă neînregistrată în scopuri de TVA trece CUI-ul la numărul de înregistrare. |
| **BR-CO-10**, **BR-CO-13**, **BR-CO-15**, **BR-CO-16** | Totalurile nu se potrivesc (totalul liniilor, totalul fără TVA, totalul cu TVA, totalul de plată). | De obicei o eroare de rotunjire a altui program. Facturile făcute în Adika sunt calculate după aceste reguli. |
| **BR-S-08**, **BR-CO-17** | TVA-ul unei cote nu este baza de impozitare × cota. | Ca mai sus. |
| **BR-16**, **BR-25**, **BR-22**, **BR-23** | Nicio linie; o linie fără denumire, fără cantitate sau fără cod de unitate valid. | Completați liniile. |
| **BR-27** | Un preț negativ. | Păstrați prețul pozitiv și faceți cantitatea negativă. |
| **BR-61** | Transfer credit fără IBAN. | Completați **IBAN**. |
| **BR-E-10**, **BR-AE-10**, **BR-IC-10**, **BR-G-10**, **BR-O-10** | O categorie de TVA scutită fără motiv. | Completați **Cod VATEX** sau **Motivul scutirii**. |
| **BR-AE-02**, **BR-IC-02** | Taxare inversă sau livrare intracomunitară fără codurile de TVA. | Completați ambele coduri de TVA. |

Mesajele care pomenesc *schema*, *cvc-* sau *SAXParseException* înseamnă că fișierul XML însuși este greșit construit. Acest lucru se întâmplă cu fișiere din alte programe; întrebați furnizorul programului.

Două verificări Adika nu au cod de regulă ANAF: **CIUS-RO BT-31** și **CIUS-RO BT-48** spun că CUI-ul sau CNP-ul furnizorului ori al cumpărătorului are cifra de control greșită. Verificați numărul pentru o greșeală de tastare.

## Probleme de autentificare (Conectare…)

- **În browser nu se întâmplă nimic sau, la final, browserul spune că nu poate accesa pagina.** Adika așteaptă pe portul adresei de callback (de exemplu 8765). Alt program poate folosi acel port sau un firewall îl blochează. Alegeți alt port, schimbați adresa de callback **atât** în aplicația înregistrată la ANAF, **cât și** în **Setări** în Adika și conectați-vă din nou.
- **„ANAF a refuzat autentificarea: …”** ANAF nu a acceptat datele aplicației. Verificați **ID client**, **Client Secret** și **Callback URL**: trebuie să fie exact ca la înregistrare (inclusiv `http` și finalul `/callback`).
- **„Callback URL-ul trebuie să fie https:// sau http://localhost:<port>/…, exact ca la înregistrarea la ANAF.”** Adresa de callback din Setări nu este utilizabilă.
- **„Răspunsul de autentificare nu corespunde acestei cereri. Încercați din nou.”** Ați finalizat o autentificare mai veche, în altă filă a browserului. Închideți filele vechi și apăsați din nou **Conectare…**.
- **„Conectați-vă din nou la ANAF: …”** Autentificarea păstrată a expirat sau a fost retrasă. Apăsați **Conectare…**.
- **Browserul nu cere certificatul.** Conectați tokenul înainte de conectare, închideți toate ferestrele browserului și încercați din nou. Driverul tokenului trebuie să fie instalat.
- **„Autentificare anulată.”** Ați apăsat Anulare sau ați închis caseta de lipire a adresei.

## Probleme la trimitere

- **„ANAF a refuzat accesul: certificatul folosit la conectare trebuie să aibă drepturi SPV pentru acest CUI, iar aplicația trebuie înregistrată pentru e-Factura.”** Certificatul cu care v-ați autentificat nu are drepturi SPV pentru **CUI (SPV)** introdus sau aplicația de la ANAF nu are bifat serviciul E-Factura.
- **„CUI invalid: …”** CUI-ul are cifra de control greșită. Scrieți-l fără RO.
- **„ANAF limitează frecvența apelurilor către serviciile sale. Așteptați puțin și încercați din nou.”** Prea multe cereri într-un timp scurt.
- **„Serviciul e-Factura ANAF a răspuns HTTP 5xx. Încercați din nou mai târziu.”** Serverele ANAF au o problemă.
- **Starea rămâne „În prelucrare”.** ANAF are uneori nevoie de mai mult de 10 minute. Verificați mai târziu cu **Verificare stare** în fila **Jurnal trimiteri** sau uitați-vă în SPV.
- **Ați trimis din greșeală în mediul de test.** Încărcările de test nu au efect juridic. Debifați **Folosire mediu de test ANAF**, conectați-vă din nou și trimiteți încă o dată factura.

## Probleme la deschidere și descărcare

- **„Acest fișier nu este o factură electronică (UBL, e-Factura sau CII).”** Fișierul este alt tip de XML sau arhiva ZIP nu conține o factură.
- **„Descărcarea nu conține nicio factură.”** sau o listă de erori când deschideți un mesaj: mesajul este un raport de erori, nu o factură. **Salvare** îl păstrează; erorile sunt afișate în fereastră.

## Căutarea unui CUI

- **„ANAF nu are nicio firmă cu acest CUI.”** Verificați numărul.
- **„ANAF înregistrează firma ca inactivă.”** sau **„ANAF înregistrează firma ca radiată.”**: așa arată registrul ANAF. Întrebați-l pe contabil înainte de a factura.
- **„Neînregistrat în scopuri de TVA: codul de TVA a rămas necompletat.”** Firma nu este plătitoare de TVA; pe factură acest lucru este corect.
- **„ANAF limitează frecvența interogărilor registrului. Așteptați puțin și încercați din nou.”**

## Funcții online dezactivate de organizație

Dacă vedeți **„Conexiunea cu ANAF este dezactivată de organizația dumneavoastră.”**, departamentul IT a dezactivat funcțiile online ale Adika printr-o politică Windows. Căutarea CUI, Verificare la ANAF și SPV nu funcționează; emiterea și citirea facturilor funcționează în continuare. Puteți încărca XML-ul prin paginile web ale SPV sau puteți cere departamentului IT să permită conexiunea. Fereastra **Despre** (butonul **i**) arată politicile la **Gestionat de organizația dumneavoastră**.
