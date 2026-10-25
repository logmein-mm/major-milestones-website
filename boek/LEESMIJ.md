# Boekviewer — installatie en beheer

Online bladerversie van *Achter de Schermen van SAFe® Transformaties*. De viewer rendert de PDF in de browser met **PDF.js** en laat de pagina's omslaan met **StPageFlip**. Beide zijn gratis open source (Apache-2.0 en MIT). Er is geen extern flipbookplatform nodig.

## Inhoud van deze map

```
boek/
├── index.html          ← de pagina, met bovenin het blok INSTELLINGEN
├── viewer.css          ← vormgeving (huisstijl Major Milestones)
├── viewer.js           ← werking: laden, renderen, bladeren, zoom, links
├── boek.pdf            ← het boek (vervang dit bestand bij een nieuwe versie)
├── cover.jpg           ← voorbeeldafbeelding bij delen op LinkedIn/WhatsApp
├── LEESMIJ.md          ← dit bestand
└── lib/
    ├── pdfjs/          ← pdfjs-dist 6.4.299 (legacy build): library, worker, fonts, wasm
    └── page-flip/      ← page-flip 2.0.7
```

De versies liggen vast. De library (`pdf.min.mjs`) en de worker (`pdf.worker.min.mjs`) komen uit hetzelfde pakket, versie 6.4.299. De viewer gebruikt de *legacy* build, die ook op wat oudere browsers en iPhones werkt.

## 1. Waar zet je de PDF?

Zet het bestand in deze map onder de naam **`boek.pdf`**, dus in `deploy\boek\boek.pdf`.

Wil je een andere naam of plek? Pas dan in `index.html` het blok **INSTELLINGEN** aan:

```js
window.BOEK_CONFIG = {
  pdf:          'boek.pdf',
  titel:        'Achter de Schermen van SAFe® Transformaties',
  ondertitel:   'ing. R.P. Peels · Major Milestones B.V.',
  downloadNaam: 'Achter-de-Schermen-van-SAFe-Transformaties-Roel-Peels.pdf',
  terugLink:    '../index.html#boek',
  terugTekst:   'majormilestones.nl'
};
```

De `<title>`- en `og:`-regels in de kop van `index.html` zijn wat LinkedIn en WhatsApp tonen bij het delen. Pas die mee aan als de titel verandert.

## 2. Publiceren en insluiten

- **Publiceren:** draai `PUSH_TO_GITHUB.bat` in de map `deploy`. Die kopieert de hele map `boek/`, inclusief `lib/`, naar GitHub Pages. Daarna staat het boek op **https://www.majormilestones.nl/boek/**.
- **Linken vanaf de homepage:** dat gebeurt al. De knoppen "Lees het boek online" (`boek/`) en "Download PDF" (`boek/boek.pdf`) en de boekfoto staan in de sectie *Het boek*.
- **Naar een pagina linken:** `https://www.majormilestones.nl/boek/#page=24` opent direct op PDF-pagina 24. Ook `#pagina=24` werkt.
- **Insluiten in een andere pagina:** gebruik een iframe:
  ```html
  <iframe src="/boek/" style="width:100%;height:85vh;border:0" allow="fullscreen" title="Boek"></iframe>
  ```

## 3. Hostinginstellingen

| Onderwerp | Nodig | GitHub Pages |
|---|---|---|
| PDF via dezelfde website (zelfde domein) | Ja. Een PDF op een ander domein vraagt CORS-headers. | Ja |
| **Range Requests** (`Accept-Ranges: bytes`, antwoord `206`) | Sterk aanbevolen. De browser haalt dan alleen de stukken op die nodig zijn. | Ja |
| `Content-Length` header | Ja, voor Range Requests en de laadbalk | Ja |
| MIME-type `.mjs` → `text/javascript` | Ja. Anders laadt de viewer niet. | Ja |
| MIME-type `.wasm` → `application/wasm` | Ja, voor sommige afbeeldingstypen in PDF's | Ja |
| PDF als `application/pdf` | Ja | Ja |
| HTTPS | Aanbevolen | Ja |
| Bestandsgrootte | GitHub weigert bestanden boven 100 MB en waarschuwt boven 50 MB | — |

**Zonder Range Requests** werkt de viewer ook, maar dan downloadt de browser eerst de hele PDF. Het laadscherm meldt dat en toont een percentage.

Of jouw server Range Requests ondersteunt, zie je zo: open de viewer, druk op F12 en kijk op het tabblad *Console*. Daar staat de melding `[boekviewer] … server ondersteunt Range Requests`. Je kunt het ook controleren met:
`curl -I -H "Range: bytes=0-99" https://www.majormilestones.nl/boek/boek.pdf`
Je hoort dan `HTTP/… 206` terug te krijgen.

Gebruik je ooit Apache of IIS in plaats van GitHub Pages? Voeg dan de MIME-types `.mjs` en `.wasm` toe. Range Requests staan op beide standaard aan.

**Downloaden** gaat via het `download`-attribuut op de knop. Bezoekers krijgen dan het originele bestand onder de naam uit `downloadNaam`.

## 4. Een nieuwe boekversie plaatsen

1. Exporteer de nieuwe PDF. Bladwijzers in de PDF worden automatisch de inhoudsopgave in de viewer.
2. Overschrijf `deploy\boek\boek.pdf` met de nieuwe versie, onder dezelfde naam.
3. Vervang eventueel `cover.jpg`, de deelafbeelding: een JPG van de voorkant van zo'n 800 px breed.
4. Draai `PUSH_TO_GITHUB.bat`. Na 1 à 2 minuten staat de nieuwe versie online.

Aantal pagina's, paginaformaat en inhoudsopgave past de viewer zelf aan. Een even of oneven aantal pagina's maakt niet uit.

**Tip:** comprimeer de PDF vóór publicatie, bijvoorbeeld in Acrobat met *Bestand → Opslaan als andere → Verkleinde PDF*. Dat versnelt de download. Voor het bladeren maakt het weinig uit, omdat de viewer per pagina laadt.

**Let op met caching:** browsers kunnen de oude PDF korte tijd onthouden. Zie je na publicatie nog de oude versie, ververs dan met Ctrl+F5.

## Bediening (voor bezoekers)

| Actie | Hoe |
|---|---|
| Bladeren | Klik of sleep aan een paginahoek, gebruik de pijlen of ← → (op mobiel: vegen of tikken op de rand) |
| Begin / einde | Knoppen ⏮ ⏭ of Home / End |
| Naar pagina | Typ een nummer in het paginaveld en druk op Enter, of gebruik de schuifbalk |
| Inhoud | Knop "Inhoud" (uit de PDF-bladwijzers) |
| Zoomen | − / + (of de toetsen − + 0, of Ctrl + scrollwiel). Ingezoomd verschuif je het beeld door te slepen. |
| Volledig scherm | Knop ⛶ of F |
| Downloaden | Knop "Download PDF" |

De viewer onthoudt de laatst gelezen pagina in de browser van de bezoeker (`localStorage`). Een link met `#page=` gaat daar altijd voor.

## Technische keuzes

- Alleen de zichtbare pagina's worden gerenderd, met een buffer van 4 pagina's vooruit en 2 terug. De overige pagina's zijn lichte placeholders.
- Canvassen hebben een geheugenbudget: ongeveer 48 megapixel op desktop en 22 megapixel op mobiel. Oude canvassen worden opgeruimd. Een render die niet meer nodig is, wordt afgebroken.
- Zoomen bouwt het boek opnieuw op in het grotere formaat en rendert op hogere resolutie, rekening houdend met het schermtype (devicePixelRatio). Zoomen dat je tijdens een omslaganimatie start, wacht tot de animatie klaar is.
- Hyperlinks komen uit de annotaties van de PDF:
  - Externe links (`http`, `mailto`, `tel`) openen in een nieuw tabblad.
  - Interne links (zoals de inhoudsopgave) bladeren naar de doelpagina.
  - Een klik op een link start geen omslag.
- Pagina's met een afwijkend formaat behouden hun eigen verhouding.
- De PDF staat als los bestand op de server en wordt niet in JavaScript ingebed.
