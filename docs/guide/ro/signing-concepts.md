# Semnăturile pe înțelesul tuturor

Această pagină explică, fără detalii tehnice, termenii pe care îi întâlniți la semnarea PDF-urilor. Cadrul legal în UE este regulamentul **eIDAS**; în România se aplică prin Legea nr. 214/2024.

## Trei tipuri de semnătură electronică

**Semnătura electronică simplă.** Orice semnătură în formă electronică: o imagine a semnăturii olografe, numele scris de la tastatură, o semnătură scanată. Arată intenția, dar dovedește puțin: oricine poate copia o imagine. Este potrivită pentru documente interne și formulare care nu cer mai mult.

**Semnătura electronică avansată (AdES).** O semnătură digitală făcută cu un **certificat** care vă aparține. Vă identifică și arată orice modificare făcută documentului după semnare. Un certificat într-un fișier .pfx sau un certificat al firmei produce o semnătură avansată.

**Semnătura electronică calificată (QES).** O semnătură avansată făcută cu un **certificat calificat** păstrat pe un **dispozitiv calificat de creare a semnăturii** (un token USB, un card inteligent sau serverul securizat al unui furnizor, pentru semnătura în cloud). Juridic, are același efect ca semnătura olografă în toată UE. Instituțiile publice din România, contractele și multe formulare oficiale o cer. Certificatele calificate sunt emise de furnizori de servicii de încredere (în România, de exemplu certSIGN, DigiSign, Trans Sped, AlfaSign).

<a id="simple-electronic-signature-fill--sign"></a>

## Semnătura electronică simplă (Completare și semnare)

**Semnare → Semnare** (sau **Pornire → Completare și semnare**) deschide fereastra **Completare și semnare**: desenați semnătura cu mouse-ul sau cu un creion digital, scrieți-o sau încărcați o imagine a ei, apoi plasați-o pe pagină. Semnătura este păstrată doar pe acest calculator și poate fi refolosită din **Salvate**. Aceasta este o semnătură electronică simplă: o imagine pe pagină, fără certificat.

Le puteți combina: plasați mai întâi semnătura olografă, selectați-o, apoi semnați cu un certificat și alegeți **Pe semnătura olografă selectată**. Pagina arată scrisul dumneavoastră de mână; certificatul face din ea o semnătură digitală adevărată.

## Termenii pe care îi veți întâlni

**Certificat.** O carte de identitate electronică emisă de o autoritate de certificare: spune cine sunteți și vine împreună cu o cheie privată pe care doar dumneavoastră o puteți folosi. Un certificat are un **emitent** și o **dată de expirare**.

**Fișier .pfx / .p12.** Un certificat împreună cu cheia privată, într-un fișier protejat cu parolă.

**Token / card inteligent.** Un stick USB sau un card care conține certificatul calificat. Cheia privată nu părăsește niciodată dispozitivul; îl deblocați cu un **PIN**. După câteva PIN-uri greșite se blochează.

**Semnătura în cloud (semnătura la distanță).** Certificatul calificat rămâne pe serverul securizat al furnizorului. Vă autentificați prin browser și confirmați fiecare semnătură cu un PIN sau cu un cod unic (SMS sau aplicație).

**Marca temporală de încredere.** O confirmare semnată de un server de marcare temporală: „această semnătură exista la această oră”. Fără ea, ora semnării provine din ceasul calculatorului dumneavoastră. Cu ea, semnătura poate fi verificată și după expirarea certificatului.

**Validarea pe termen lung (LTV).** Lanțul de certificate și răspunsurile serverelor de revocare ale emitentului (OCSP / CRL) sunt păstrate în PDF, astfel încât semnătura poate fi verificată și peste mulți ani, fără internet, chiar dacă serverele emitentului nu mai există.

**Marca temporală de arhivare.** O marcă temporală peste întregul fișier, inclusiv datele de validare. Repetată la câțiva ani, păstrează semnăturile verificabile foarte mult timp.

## Nivelurile PAdES

PAdES este formatul european pentru semnăturile din fișierele PDF. Bifați **Format UE: PAdES baseline (eIDAS)** în fereastra de semnare (este bifat implicit). Fereastra arată nivelul rezultat:

| Nivel | Ce conține | Îl obțineți cu |
| --- | --- | --- |
| **B-B** | Semnătura și certificatul | PAdES bifat, nimic altceva |
| **B-T** | + o marcă temporală de încredere | **Adăugare marcă temporală de încredere** |
| **B-LT** | + date pentru verificarea pe termen lung | Marcă temporală + **Adăugare date de validare pe termen lung** |
| **B-LTA** | + o marcă temporală de arhivare | Marcă temporală + LTV + **Adăugare marcă temporală de arhivare…** |

Fără PAdES, Adika produce o **Semnătură PDF clasică (adbe.pkcs7.detached)**, pe care o așteaptă programele mai vechi.

**Ce nivel alegeți?** B-B pentru documentele obișnuite, verificate la scurt timp după semnare. **B-T** ori de câte ori contează data (contracte, oferte, documente pentru autorități). **B-LT** sau **B-LTA** pentru documentele păstrate mulți ani (arhive, achiziții publice). Marca temporală și LTV au nevoie de internet în momentul semnării.

## Semnături de aprobare și de certificare

**Semnătura de aprobare** (cea obișnuită): „aprob acest document”. Alte persoane pot semna după dumneavoastră; fiecare semnătură rămâne validă.

**Certificarea** (doar **prima** semnătură poate certifica): autorul stabilește ce se mai poate modifica. La **Certificare document** alegeți:

- **Certificare: nu sunt permise modificări**: nu se mai poate schimba nimic; chiar și o altă semnătură ar invalida-o.
- **Certificare: sunt permise completarea formularelor și semnarea**: alții pot completa formularul și pot semna.
- **Certificare: sunt permise formularele, semnarea și comentariile**: și comentarii.

Folosiți certificarea pentru formularele pe care le trimiteți spre completare și semnare sau pentru documentele finale care nu trebuie să se mai schimbe. Pentru un contract semnat de mai multe persoane, folosiți semnături de aprobare.

## Ce metodă folosiți?

| Situație | Metodă |
| --- | --- |
| Notă internă, un formular pentru un coleg | **Completare și semnare** (simplă) |
| Documente pentru ANAF, instanțe, instituții publice, contracte | Certificat calificat: **Token / card inteligent**, **Certificat Windows** sau **Semnătură în cloud** |
| Ați primit un fișier .pfx de la firmă | **ID certificat** |
| Teste sau dovada că documentul nu a fost modificat, fără identitate | **ID certificat → Creare ID autosemnat** |
| Multe documente deodată | **Semnare multiplă** |

Mai departe: [Semnarea unui document](signing-sign.md)
