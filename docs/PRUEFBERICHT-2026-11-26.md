# Prüfbericht Packraft-Planer – 26.11.2026

Stand: `main` @ 1cb9058 (PR #23). Geprüft im Dev-Server (`npx vite --port 5173`) und im Produktions-Build
(`vite preview`) mit Playwright/Chromium (headless, Desktop 1440×900 und Handy 390×844, deviceScaleFactor 2).
**Am App-Code wurde nichts geändert.** Neu sind nur Prüfskripte:

| Datei | Zweck |
|---|---|
| `tests/e2e/pruefung.cjs` | Rahmen + Phase `ref` (Referenzstrecken) und `presets`; protokolliert Konsolenfehler, Netzfehler, Anfragen je Host |
| `tests/e2e/pruefung-ui.cjs` | Phase `ui`: Grundfunktionen Desktop + Handy, Export, Schlüssel-Felder, Tastatur, Tippziele, GPX-Schema |
| `tests/e2e/pruefung-fail.cjs` | Phase `fail`: Quellen einzeln blockiert, Grenzfälle, localStorage gesperrt, Open-Meteo-Anfragen zählen |
| `tests/e2e/pruefung-karte.cjs` | Hintergründe, 3D, Zoomstufen 17–19 einzeln |
| `tests/e2e/fixtures/gpx.xsd` | GPX-1.1-Schema (Kopie von topografix.com, dort ist der Host in der Cloud gesperrt) |
| `scripts/pruefung-snap.mts` | Punkte auf die OSM-Flusslinie setzen (für Strecken ohne feste Koordinaten) |
| `scripts/pruefung-gpx-sonderzeichen.mts` | GPX mit „Şarın“, „Soča“, „&“, „<“ erzeugen und gegen das Schema prüfen |

Aufruf: `node tests/e2e/pruefung.cjs ref ui fail` (Dev-Server muss laufen). Rohdaten (JSON, alle 84 Screenshots, 256 MB)
liegen nur lokal in `tests/e2e/out/pruefung/` (gitignored); 25 ausgewählte Belege komprimiert in
[`docs/pruefbericht-2026-11-26/`](pruefbericht-2026-11-26/).

> **Hinweis zur Umgebung:** In der Cloud-Umgebung sind `nominatim.openstreetmap.org`, `tiles.maps.eox.at`
> (Sentinel-2-Hintergrund) und `tile.opentopomap.org` gesperrt (Proxy 403). Ortssuche, Sentinel-2- und Topo-Hintergrund
> konnten deshalb nur auf ihr Fehlverhalten geprüft werden. Open-Meteo antwortete während der Prüfung meist mit
> **429 (Tageslimit)** – siehe F1, das ist zu einem großen Teil von der App selbst verursacht.

## Vorbereitung – Ergebnisse

| Schritt | Ergebnis |
|---|---|
| `npm install` | ok |
| `npm test` (vitest) | **119/119** grün in 5,3 s (15 Dateien) |
| `npx tsc --noEmit` | ok, keine Fehler |
| `npm run build` | ok in 3,8 s; Haupt-Bundle **1 243 kB (367 kB gzip)**, CSS 80 kB; keine Build-Warnung – allerdings nur, weil `vite.config.ts` die Chunk-Warnung auf 1 500 kB hochsetzt (siehe O4) |
| `npm run e2e` | **62/62 OK** in 671 s, keine JS-Fehler |
| `npm audit` | 5 Lücken (3 kritisch, 1 hoch, 1 mittel) – alle in **vite 6.3.5 / launch-editor**, also nur Dev-Server, nicht in der ausgelieferten App |
| `npm outdated` | maplibre-gl 5.6.0 → 6.19, vite 6.3.5 → 8.4, vitest 3 → 5, typescript 5.8 → 7, geotiff 2 → 3, proj4 2.15 → 2.23 |
| GitHub Actions | Deploy: alle Läufe grün (zuletzt PR #23, 13:00 UTC). Tirol-Spiegel: grün, aber trotz `cron: 7,37 * * * *` real nur alle **~70–80 min** (08:46, 10:09, 11:27, 12:35 UTC) |
| Lighthouse (Build) | Desktop: Leistung **96**, Barrierefreiheit 100, Best Practices 100. Handy (4× CPU-Drosselung): Leistung **71** – Total Blocking Time 2,9 s, Time to Interactive 8,4 s, ungenutztes JS ~243 kB |

### Dauer der Analysen (Ein-/Ausstieg bzw. Auswahlfeld, inkl. Pegel/Wetter/Weißwasser)

| Strecke | Dauer | Länge | Ø Gefälle | Pegel | Schwall / Gefahr |
|---|---|---|---|---|---|
| Soča Srpenica–Trnovo | 30 s | 5,47 km | 7,5 m/km | ≈ 39 m³/s geschätzt (Log Čezsoški / Kobarid I) ✓ | 7 / 0 |
| Koritnica | 27 s | 5,53 km | 15,2 m/km | Kal-Koritnica 7,6 m³/s ✓ | 2 / 0 |
| Sjoa Åmot (Kartverket) | 21 s | 3,65 km | 12,3 m/km | keiner (kein NVE-Schlüssel) – Hinweis ✓ | Hinweis „kein auswertbares Luftbild“ ✓ |
| Jökulsá á Fjöllum (Dettifoss) | 37 s | 4,97 km | 38,9 m/km | keiner (Island ohne API) | 0 / **2** (km 2,17 Dettifoss, km 4,35 Hafragilsfoss; Selfoss fehlt – bekannt) |
| Sanna | 21 s | 6,98 km | 13,4 m/km | Landeck Bruggen **5,5 m³/s** ✓ (+ Perjen 11) | 6 / 0 (Schiefes Eck km 1,29, Pianser Schwall km 2,68–2,86, Wehr km 5,58 ✓) |
| Inn Imster Schlucht | 35 s | 15,3 km | 3,9 m/km | Imst **≈ 29 m³/s** geschätzt (siehe F7) | 5 / 0 |
| Salzach Taxenbach–Lend | 23 s | 7,75 km | **15,2 m/km** (siehe F2) | keiner (Salzburg ohne API) | 5 / 0 (Wehr km 3,73–3,75 ✓) |
| Ötztaler Ache | 23 s | 5,56 km | 30,0 m/km | Tumpen 6,3 m³/s ✓, Gletscherhinweise ✓ | **0 / 0** (siehe F9) |
| Charyn/Şarın | 17 s | 10,1 km | 5,3 m/km | keiner | Hinweis ✓ |
| Nahe Kirn–Monzingen | 16 s | 11,6 km | 2,9 m/km | keiner gefunden | Hinweis ✓; Linie 100 % auf OSM, nicht auf Straße/Bahn ✓ |
| Oulankajoki (SYKE) | 36 s | 5,91 km | 3,8 m/km | SYKE 28 m³/s (veraltet markiert ✓), Aufnahmetage 17/18/20 m³/s ✓ | Hinweis ✓ |
| Piteälven (SMHI) | 33 s | 7,42 km | 0,1 m/km | **keiner** (siehe F5) | Hinweis ✓ |
| Ubaye (FR, Hub'Eau) | 23 s | 4,70 km | 22,8 m/km | Lauzet-Ubaye 26 m³/s ✓, Aufnahmetag 9,6 m³/s ✓ | Hinweis ✓ |
| Arkansas Royal Gorge (USA, NAIP) | **120 s** | 15,7 km | 8,0 m/km | keiner (USGS nicht angebunden) | **0 / 0** (siehe F9) |

---

## Fehler

### F1 · hoch · Abfluss/Wetter – GloFAS-Reihe seit 1984 frisst das Open-Meteo-Tageslimit
- **Beobachtung:** Eine einzige Analyse (Sanna) erzeugt 4 Open-Meteo-Anfragen, die Open-Meteo als **≈ 1 153 Aufrufe** zählt
  (Zeiträume > 2 Wochen und viele Orte zählen mehrfach). **1 120 davon** stammen von *einer* Anfrage
  `flood-api…&start_date=1984-01-01&end_date=…` (≈ 15 300 Tage). Das freie Limit (10 000/Tag, 5 000/Stunde, je IP) ist
  damit nach **~8 Analysen am Tag bzw. ~4 pro Stunde** erschöpft. Danach liefert Open-Meteo 429 und die App zeigt bei
  allen Strecken nur noch „Wetterdaten gerade nicht abrufbar – Tendenz nur aus der Jahreszeit“ – genau das ist in
  diesem Prüflauf bei 13 von 14 Strecken passiert.
- **Nachstellen:** `node tests/e2e/pruefung.cjs fail` → `pruefung-fail.json` → `meteo.einzeln`.
- **Erwartet:** wenige Dutzend gewichtete Aufrufe je Analyse. **Tatsächlich:** ~1 150.
- **Beleg:** `tests/e2e/out/pruefung/pruefung-fail.json` (`"gewichtet": 1153`), Konsole:
  `429 api.open-meteo.com https://api.open-meteo.com/v1/forecast?latitude=47.117,…`; im Browser erscheinen die 429 als
  „blocked by CORS policy“, weil die Fehlerantwort keinen CORS-Kopf hat.
- **Ursache:** `src/discharge.ts:89` (`seriesFor` lädt 1984 → heute+7). Gebraucht wird die Reihe nur in
  `matchGauge` (`src/gauges.ts:711–736`) für die **letzten 45 Tage** (`from`/`to`).
- **Handlungsanweisung:** In `seriesFor` statt `start_date=1984-01-01` nur `past_days=46&forecast_days=1` abfragen
  (oder `start_date` = heute − 46 Tage). Zusätzlich das Ergebnis von `riverCell` + `seriesFor` je Zelle in `sessionStorage`
  cachen (Wiederholung derselben Strecke). Gewichteten Zähler (`meteoWeight` aus `tests/e2e/pruefung-fail.cjs`) als
  Unit-Test übernehmen: „eine Analyse < 100 gewichtete Aufrufe“.
- **Aufwand:** S

### F2 · hoch · Flusslinie – Ein-/Ausstieg neben dem Fluss erzeugt Scheingefälle ohne Warnung
- **Beobachtung:** Liegt ein Klick einige hundert Meter neben dem Wasser, zieht die App die Linie den Hang hinunter und
  wertet diesen Hang als Flussabschnitt. Die Kennzahl „Steilster Abschnitt“ (oben auf der Ergebnisseite) zeigt dann den
  Hang:
  - **Salzach** (Koordinaten aus CLAUDE.md, Einstieg im Ort Taxenbach
    [47.2925, 12.9640](https://www.google.com/maps/search/?api=1&query=47.2925,12.9640)): **112,4 m/km auf km 0,0–0,5**,
    Höhe 751 → 633 m, Ø **15,2 m/km**; ohne die ersten 300 m wären es ≈ 7–8 m/km. Zusätzlich wird die ganze Strecke als
    „Schlucht-/Klammstrecke 7,3 km“ gemeldet.
  - **Achensee** (Einstieg am Südhang [47.4300, 11.7050](https://www.google.com/maps/search/?api=1&query=47.4300,11.7050)):
    **457,9 m/km**, Ø 52,6 m/km – ein See wird als Fluss mit Wildwasser-Farben dargestellt.
  - **Klick 500 m neben die Sanna:** 283 m/km auf km 0,0–0,5.
  - Keine dieser Strecken bekommt den Hinweis „Flusslauf unsicher“, weil `shareOsm`/`shareWater` über die ganze Strecke
    gemittelt hoch bleiben.
- **Nachstellen:** Ein-/Ausstieg, Einstieg in den Ort/auf den Hang setzen (`pruefung.cjs ref`, Strecke `salzach-taxenbach`;
  `pruefung-fail.cjs`, Fälle `see-achensee`, `neben-fluss-500m`).
- **Erwartet:** Einstieg wird auf das nächste Gewässer (OSM-Linie/-Fläche, Sentinel-Wasser) gesetzt oder es kommt eine
  deutliche Warnung „Einstieg liegt 250 m neben dem Fluss“. **Tatsächlich:** Hangprofil als Flussgefälle.
- **Beleg:** [01-salzach-einstieg-neben-fluss.jpg](pruefbericht-2026-11-26/01-salzach-einstieg-neben-fluss.jpg),
  [02-achensee-see-als-fluss.jpg](pruefbericht-2026-11-26/02-achensee-see-als-fluss.jpg),
  [25-salzach-ergebnis.jpg](pruefbericht-2026-11-26/25-salzach-ergebnis.jpg).
- **Ursache:** `src/main.ts:410–435` (`traceSection`/Hinweis nur aus Mittelwerten), `src/route.ts` (kein Snap der
  Endpunkte).
- **Handlungsanweisung:** (1) In `traceRiver` die Endpunkte vor der Suche auf die nächste Wasserzelle (OSM-Gewässer,
  sonst NDWI > 0) innerhalb von 300 m setzen; Abstand merken. (2) Ist der Abstand > 60 m oder liegt das erste/letzte
  Stück (je 300 m) nicht auf Wasser/OSM, Status-Warnung „Einstieg liegt ~X m neben dem Fluss – bitte direkt auf das
  Wasser klicken“ und diese Endstücke **aus „Steilster Abschnitt“ und Ø Gefälle herausnehmen** (oder abschneiden).
  (3) Liegt die ganze Linie in einer OSM-Wasserfläche `natural=water` (See), Hinweis „See – kein Fließgewässer“.
  Unit-Test in `tests/route.test.ts`: Einstieg 200 m neben der Linie → Endpunkt liegt < 30 m am Wasser.
- **Aufwand:** M

### F3 · mittel · Ergebnis – Meer/See ohne Hinweis, Profil „0 → 0 m“
- **Beobachtung:** Zwei Klicks in die Adria
  ([45.5000, 13.3000](https://www.google.com/maps/search/?api=1&query=45.5000,13.3000)) liefern eine 10,1 km lange
  „Eigene Strecke“ mit Höhe 0 → 0 m, Ø 0,0 m/km, Flusslinie „100 % auf Wasser/Kiesbett“ – ohne Hinweis.
- **Beleg:** [03-adria-meer-als-fluss.jpg](pruefbericht-2026-11-26/03-adria-meer-als-fluss.jpg).
- **Handlungsanweisung:** Wenn Höhe am Ein- und Ausstieg ≤ 1 m und kein OSM-`waterway` getroffen wird, Status
  „Meer/Küste – keine Flussstrecke“ und Analyse abbrechen. Zusammen mit F2 (3) umsetzen.
- **Aufwand:** S

### F4 · hoch · Fehlerfall – Höhenmodell nicht erreichbar: 92 s Warten, dann englische Meldung
- **Beobachtung:** Wird `s3.amazonaws.com` (AWS Terrain Tiles) blockiert, dreht die App **92 s** und zeigt dann nur
  „Laden fehlgeschlagen: Failed to fetch“. Abfluss-Feld bleibt auf „Wird geladen …“. Gleiches Bild bei „Netz weg“ (93 s).
- **Erwartet:** nach ≤ 20 s eine deutsche Meldung „Höhenmodell (AWS Terrain Tiles) nicht erreichbar – Netz prüfen und
  erneut laden“. **Tatsächlich:** s. o.
- **Beleg:** [04-hoehenmodell-blockiert.jpg](pruefbericht-2026-11-26/04-hoehenmodell-blockiert.jpg),
  `pruefung-fail.json` → `blockiert.terrarium`.
- **Ursache:** `src/main.ts:1704` gibt `e.message` des Browsers ungefiltert aus; `src/dem.ts` hat für Terrarium keinen
  Zeitlimit-/Abbruchzähler wie für Kartverket (`kartverketBreaker`).
- **Handlungsanweisung:** Eine Funktion `userMessage(e)` in `main.ts`, die `TypeError: Failed to fetch`/`NetworkError`
  in „Datenquelle nicht erreichbar (Netz?)“ übersetzt und – wo bekannt – die Quelle nennt (Fehlerobjekte in `dem.ts`,
  `route.ts`, `sentinel.ts` mit `source`-Feld werfen). Für Terrarium nach 3 fehlgeschlagenen Kacheln abbrechen.
  Gilt auch für die Ortssuche (`src/main.ts:1728`, zeigt ebenfalls „Failed to fetch“).
- **Aufwand:** S

### F5 · mittel · Pegel – „NVE-Schlüssel eintragen“ erscheint in Schweden und Finnland
- **Beobachtung:** Piteälven (Schweden,
  [65.7740, 20.8246](https://www.google.com/maps/search/?api=1&query=65.7740,20.8246)): „Kein offizieller Pegel an
  der Strecke … **(Norwegen: NVE-Schlüssel unter „Analyse-Parameter“ eintragen)**“. Zusätzlich wurde kein SMHI-Pegel
  gefunden, obwohl SMHI abgefragt wurde (`opendata-download-hydroobs.smhi.se`: 1 Anfrage).
- **Beleg:** [06-piteaelven-nve-hinweis-schweden.jpg](pruefbericht-2026-11-26/06-piteaelven-nve-hinweis-schweden.jpg).
- **Ursache:** `src/main.ts:1313` und `:1327` prüfen nur das Rechteck lat > 57,8 und 4 < lon < 31,5 – das umfasst ganz
  Schweden und Finnland.
- **Handlungsanweisung:** Den Hinweis nur zeigen, wenn der Einstieg in Norwegen liegt (grobes Polygon oder
  Reverse-Lookup über die bereits geladenen OSM-Daten, z. B. `inNorway(p)` in `dem.ts` mit Polygon statt Rechteck –
  gleiche Funktion für F6 verwenden). Für Piteälven prüfen, ob die SMHI-Station „Storforsen“/„Sikfors“ wegen des
  1,5-km-Radius (`gaugesAlong(line, 1.5)`, `src/gauges.ts:701`) verfehlt wird; ggf. für große Flüsse (> 1 000 km²) 5 km
  zulassen.
- **Aufwand:** S

### F6 · mittel · Höhenmodell – Kartverket wird in Schweden/Finnland abgefragt
- **Beobachtung:** Piteälven: **49 Anfragen** an `wcs.geonorge.no`; Oulankajoki (Finnland): „Höhenmodell global –
  **Kartverket nicht erreichbar (Zeitüberschreitung)**“ – irreführend und kostet Zeit (Oulankajoki 36 s).
- **Beleg:** [07-oulankajoki-kartverket-finnland.jpg](pruefbericht-2026-11-26/07-oulankajoki-kartverket-finnland.jpg),
  `pruefung-ref.json` → `piteaelven.log.hosts`.
- **Ursache:** `src/dem.ts:109` `NORWAY_BBOX = [4.0, 57.8, 31.5, 71.4]`, genutzt in `inNorwayBox` (`:129`) und `:296`.
- **Handlungsanweisung:** Norwegen als vereinfachtes Polygon (≈ 30 Punkte, aus Natural Earth) hinterlegen und
  `inNorwayBox`/`inNorway` darauf umstellen; Test in `tests/dem.test.ts`: Punkt in Kiruna/Rovaniemi → kein Kartverket.
- **Aufwand:** S

### F7 · mittel · Pegel-Schätzung – Inn bei Imst schwankt mit dem Schwallbetrieb (29 statt ~61 m³/s)
- **Beobachtung:** Imster Schlucht heute „≈ 29 m³/s am Pegel Imst (geschätzt aus Pegel unterhalb: Innsbruck − Tumpen −
  Nassereith ×0,78)“. Laut CLAUDE.md lag die App-Schätzung am 25.11. bei ~61 (Imst) bzw. ~75 m³/s (Magerbach, RiverApp 74).
  Im Spiegel: Innsbruck **Momentanwert 43,8 m³/s, Tagesmittel 78,3 m³/s** (Stand 12:35 UTC). Die Schätzung verwendet den
  Momentanwert und berücksichtigt die Laufzeit Imst → Innsbruck (~55 km, mehrere Stunden) nicht – bei Schwallbetrieb
  schwankt das Ergebnis so um den Faktor 2.
- **Beleg:** [11-inn-imst-ergebnis.jpg](pruefbericht-2026-11-26/11-inn-imst-ergebnis.jpg); `tirol.json` im Branch
  `pegeldaten`.
- **Ursache:** `src/gauges.ts:415–417` (`applyEstimate` mit `x.q`), `src/estimate.ts:101`.
- **Handlungsanweisung:** Für geschätzte Pegel **das Tagesmittel** (`dayMean`) der Quellpegel verwenden und als Spanne
  aus Tagesmittel und Momentanwert anzeigen („≈ 29–56 m³/s, Schwallbetrieb“). Kennzeichnung „geschätzt“ ist bereits
  vorhanden ✓. Unit-Test in `tests/estimate.test.ts` mit Tagesmittel.
- **Aufwand:** S–M

### F8 · mittel · Karte – 3D + Drehen lässt die Karte leer werden
- **Beobachtung:** 3D einschalten, dann ⟲ (oder Rundflug): die ganze Karte wird weiß/leer, Attribution zeigt nur noch
  „Höhen: AWS Terrain Tiles“. Bleibt auch nach Ausschalten von 3D und Zoomen leer. Ohne Drehen ist 3D in Ordnung;
  Hintergrundwechsel allein ebenfalls. Reproduzierbar mit deviceScaleFactor 1 und 2 (`areTilesLoaded() = true`).
- **Einschränkung:** im Headless-Chromium mit Software-WebGL festgestellt – **bitte auf einem echten Gerät gegenprüfen**.
- **Beleg:** [05-3d-drehen-leere-karte.jpg](pruefbericht-2026-11-26/05-3d-drehen-leere-karte.jpg); Skript
  `tests/e2e/pruefung-karte.cjs` (Fall d ok) und Rundflug-Fall in `pruefung-ui.cjs`.
- **Ursache (Vermutung):** `src/main.ts:176–204` (`setTerrain` + `easeTo({bearing})`) mit MapLibre 5.6.0; Esri-Quelle
  mit `tileSize 128` bei hoher Pixeldichte (`src/main.ts:81`).
- **Handlungsanweisung:** Auf echtem Handy/Desktop prüfen. Tritt es auf: MapLibre auf ≥ 5.7 (bzw. 6.x) aktualisieren und
  testweise `tileSize: 256` für Esri bei aktivem Terrain. e2e-Prüfung ergänzen: nach 3D + Drehen Pixelvarianz der Karte
  > 0 (Screenshot statt `readPixels`).
- **Aufwand:** S (prüfen) bis M

### F9 · mittel · Schwallstellen – Lücken an Gletscherfluss und in den USA
- **Ötztaler Ache** Tumpen–Ötz ([47.1610, 10.9111](https://www.google.com/maps/search/?api=1&query=47.1610,10.9111)):
  Ø 30 m/km, steilster Abschnitt 86,8 m/km (Achstürze bei km 2,0–2,5), basemap.at 07.09.2023 „eher hoch“ – **keine**
  Schwallstelle, **keine** Gefahrenstelle („Keine Stellen über der Schwelle, 4,0 m²/m“). Vermutlich macht das milchige
  Gletscherwasser (wie Salzach) den Kontrast zu klein.
- **Arkansas Royal Gorge** ([38.4867, −105.3733](https://www.google.com/maps/search/?api=1&query=38.4867,-105.3733)):
  NAIP 100 % Abdeckung, **0 Schwallstellen** (bekannte WW III–IV-Strecke); Aufnahmetag „unbekannt“; Analyse dauerte
  **120 s** (265 NAIP-Kacheln).
- **Beleg:** [09-oetz-keine-schwaelle.jpg](pruefbericht-2026-11-26/09-oetz-keine-schwaelle.jpg),
  [10-arkansas-naip-keine-schwaelle.jpg](pruefbericht-2026-11-26/10-arkansas-naip-keine-schwaelle.jpg).
- **Handlungsanweisung:** Beide Strecken mit verorteten Stellen in `tests/fixtures/schwallstellen.json` aufnehmen
  (Ötz: Achstürze/Wellerbrücke; Arkansas: Sunshine Falls, Sledgehammer, Wallace Rapid – Lage bitte vom Nutzer
  bestätigen lassen) und `scripts/whitewater-eval.mts` laufen lassen. Relatives Kriterium (Salzach) auf
  Gletscherfarbe prüfen. NAIP-Aufnahmedatum: das `AcquisitionDate`-Feld des NAIP-ImageServers (`identify`) abfragen.
- **Aufwand:** M

### F10 · gering · Bildabschnitte – Abschnitt mit 0 m Länge
- **Beobachtung:** Ubaye: „B2 Luftbild 03.10.2019 **km 4.7–4.7**“ als eigene Karte mit Pegelwert; Kartenkopf ohne Tendenz.
- **Beleg:** [08-ubaye-bildabschnitt-0m.jpg](pruefbericht-2026-11-26/08-ubaye-bildabschnitt-0m.jpg).
- **Ursache:** `src/imagery.ts:84–99` – die letzte Stichprobe liegt genau am Ende (`d = total`) und bildet einen eigenen
  Abschnitt.
- **Handlungsanweisung:** Abschnitte < 200 m dem Nachbarn zuschlagen (nach Zeile 98 filtern). Test in einer neuen
  `tests/imagery.test.ts`.
- **Aufwand:** S

### F11 · gering · Ausfall einer Quelle wird nicht genannt
- **Beobachtung:** ARSO blockiert → „kein Pegel“ (statt „Pegeldienst ARSO nicht erreichbar“); Esri-Metadaten blockiert →
  der ganze Block „Luftbild B1 …“ fehlt kommentarlos; Sentinel-STAC blockiert → kein Hinweis, Linie trotzdem gut (OSM).
- **Beleg:** [20-pegel-arso-blockiert.jpg](pruefbericht-2026-11-26/20-pegel-arso-blockiert.jpg),
  [21-esri-metadaten-blockiert.jpg](pruefbericht-2026-11-26/21-esri-metadaten-blockiert.jpg).
- **Ursache:** `gaugeErrors` werden gesammelt (`src/main.ts:1144`), aber nicht angezeigt; `imageryAlong(...).catch(() => [])`
  (`src/main.ts:1133`).
- **Handlungsanweisung:** In „Pegel & Quellen“ eine Zeile „Nicht erreichbar: ARSO, Esri-Metadaten“ aus `gaugeErrors`
  und einem `imageryError` anzeigen.
- **Aufwand:** S

### F12 · gering · Island – widersprüchliche Bildquellen-Meldung
- **Beobachtung:** Dettifoss: Schwallstellen-Liste „Offenes Luftbild deckt diese Strecke nicht ab“, gleichzeitig zwei
  Gefahrenstellen „Weißwasser/Gischt setzt schlagartig ein“ aus dem NÁTT-Bild (206 Anfragen an `gis.natt.is`).
- **Beleg:** [17-dettifoss-ergebnis.jpg](pruefbericht-2026-11-26/17-dettifoss-ergebnis.jpg).
- **Ursache:** `src/main.ts:833–834` (Abdeckung der Weißwasser-Streifen) vs. `:763` (Abbruchkanten aus Kandidatenbildern).
- **Handlungsanweisung:** Meldung abhängig von `coverage` formulieren („NÁTT deckt nur Teile ab (x %) – Abbruchkanten
  dort geprüft“).
- **Aufwand:** S

### F13 · gering · Einheitliche Zahlenformate
- Kennzahlen mit Punkt („6.98 km“, „13.4 m/km“, „km 0.74–0.81“), Abfluss/Pegel mit Komma („5,5 m³/s“); im GPX
  „Steil km 0,0–0,5“ aber „Schwall km 4.64“. **Handlungsanweisung:** eine Funktion `fmt(n, digits)` mit
  `toLocaleString("de-DE")` in `src/main.ts`/`src/export.ts` verwenden (`fmtKm`, `kmRange`, Wegpunktnamen). **Aufwand:** S

### F14 · gering · Handy – Ein-/Ausstieg per Tippen im Emulator nicht auslösbar
- Mit Playwright-Touch-Emulation (390×844, `isMobile`) kamen nach Tippen auf „Ein-/Ausstieg“ (Seite springt 397 px
  nach unten) zwei Taps auf die Karte nicht als Kartenklicks an (0 `click`-Ereignisse), während ein Tap ohne vorheriges
  Tippen auf den Knopf funktioniert. **Unklar, ob das auf echten Geräten auftritt** – bitte am Handy prüfen.
  Unabhängig davon: Nach Tippen auf einen Modus scrollt die Seite zum Panel, die Karte ist dann außer Sicht.
  **Handlungsanweisung:** Nach Moduswahl auf dem Handy `#map.scrollIntoView()`; e2e um einen Touch-Durchlauf ergänzen.
  **Aufwand:** S

---

## Risiken

### R1 · mittel · Vorgabe „nur offizielle Schnittstellen“ – Schweizer Pegel über api.existenz.ch
`src/gauges.ts:261` holt BAFU-Daten über **api.existenz.ch** (privater Dienst, der BAFU-Daten spiegelt), nicht über
eine BAFU-Schnittstelle. Das widerspricht der Vorgabe in CLAUDE.md. **Handlungsanweisung:** Entscheidung des Nutzers
einholen; Alternative: BAFU-Daten wie Tirol per GitHub-Action aus dem offiziellen BAFU-Open-Data-Angebot spiegeln. Bis
dahin im Panel „Quelle: api.existenz.ch (Spiegel der BAFU-Daten)“ angeben. **Aufwand:** S (Kennzeichnung) / M (Spiegel).

### R2 · mittel · Ergebnisseite wirkt teils wie eine Schwierigkeitsbewertung
Überschrift „**Schwierigkeit**: Gefälle & Wucht“, im Modus „kombiniert“ heißen die Klassen „**WW I**“, „**WW II**“ …
(Beleg [09-oetz-keine-schwaelle.jpg](pruefbericht-2026-11-26/09-oetz-keine-schwaelle.jpg), links unten). Der Hinweis
„Indikator“ steht nur im Fuß. **Handlungsanweisung:** Überschrift „Gefälle & Wucht (Indikator)“, Klassen als „wie
meist WW I“ / „Gefälle-Klasse 2“ benennen, im Modus „kombiniert“ dieselben Texte wie im Gefälle-Modus („meist WW I“).
**Aufwand:** S

### R3 · mittel · Open-Meteo-Limit wird mit mehr Nutzern geteilt
Auch nach F1 bleibt das Limit je IP (z. B. Hütten-WLAN, Mobilfunk-NAT). **Handlungsanweisung:** Wetterabfragen je
Datum + gerundeter Koordinate in `localStorage` (Archivdaten ändern sich nicht) cachen; auf 429 mit einem klaren Text
„Wetterdienst-Tageslimit erreicht – später erneut“ reagieren statt „gerade nicht abrufbar“. Attribution „Wetterdaten:
Open-Meteo.com (CC BY 4.0)“ zusätzlich in den Fuß (Lizenzbedingung). **Aufwand:** S

### R4 · gering · Abhängigkeiten
vite 6.3.5 hat 5 bekannte Lücken (nur Dev-Server, z. B. Datei-Lesen über den Dev-Server) → auf vite 6.4.x
aktualisieren (Patch, gleiche Hauptversion). MapLibre 5.6.0 ist 1,5 Jahre alt (6.x verfügbar) – Aktualisierung zusammen
mit F8 prüfen. **Aufwand:** S

### R5 · gering · Tirol-Spiegel aktualisiert seltener als gedacht
Die Action läuft real nur alle 70–80 min (GitHub drosselt `schedule`). Werte sind damit bis ~1,5 h alt; die
Veraltet-Grenze (26 h) passt. Hinweis im Panel „Stand hh:mm“ ist vorhanden ✓. Nur Doku anpassen
(CLAUDE.md/README „alle 30 min“ → „etwa stündlich“). Erinnerung: nach 60 Tagen ohne Commit pausiert GitHub die Action.

### R6 · gering · Lizenzen/Attributionen
- Esri, Google, Apple werden **nur angezeigt**; ausgewertet werden laut Code und Netzprotokoll nur basemap.at, GURS
  (`gisportal.furs.gov.si`), NÁTT und NAIP ✓.
- Fehlend im Fuß bzw. in der Kartenattribution: **Open-Meteo** (CC BY 4.0, Pflicht), OpenFreeMap/**OpenMapTiles**
  (Vektorkacheln für die Analyse), Hub'Eau/SMHI/SYKE/ARSO/HD Tirol als Pegelquellen (stehen nur im aufgeklappten
  Pegelblock), EOX steht nur in der Kartenattribution (ok).
- **Handlungsanweisung:** Fußzeile `index.html` um „Wetter: Open-Meteo.com · Vektordaten: OpenFreeMap © OpenMapTiles ·
  Pegel: jeweilige Behörde“ ergänzen. **Aufwand:** S

### R7 · gering · Sicherheit (HTML-Injektion, Schlüssel)
- Durchgesehen: 31 `innerHTML`-Stellen. Externe Texte (Pegel-, Fluss-, Gewässernamen, Notizen, Wetterhinweise) werden in
  `renderFlowInfo` mit `esc()` maskiert ✓; Ortssuche und Flusstitel über `textContent` ✓; Markierungs-Notiz im Attribut
  mit `&quot;` ✓ (Test mit `<img onerror>` ohne Ausführung). Nicht maskiert: **Pegel-URLs** in `href="${gm.gauge.url}"`
  (`src/main.ts:1305ff.`) – die IDs (`s.key`, `s.code_station`, `x.id`) kommen aus den Pegel-APIs. Risiko gering, aber
  `encodeURIComponent` für die ID-Teile in `src/gauges.ts:111, 205, 242, 278, 457` setzen. Fehlermeldungen
  (`ww.message`, `err.message`) gehen ungefiltert in `innerHTML` (`src/main.ts:830, 1728`) → `textContent` verwenden.
- Alle externen Links haben `target="_blank" rel="noopener"` ✓.
- Schlüssel: NVE und GitHub liegen nur in `localStorage` (`packraft.nveKey`, `packraft.ghToken`), Felder sind
  `type="password"` ✓; nicht in GPX/Markierungs-JSON enthalten ✓; GitHub-Schlüssel geht nur als
  `Authorization: Bearer` an `api.github.com` ✓, NVE-Schlüssel nur als `X-API-Key` an `hydapi.nve.no` ✓, nie in URLs ✓.
- Keine Modell-Abflusszahl (GloFAS) in UI, GPX, CSV oder GeoJSON gefunden ✓; Schätzungen tragen „≈“ und „geschätzt
  aus …“ ✓.

---

## Optimierungen

### O1 · Handy – Tippziele zu klein (hoch, S–M)
66 von 69 Bedienelementen sind kleiner als 44 px (Knöpfe 31–33 px hoch, Kontrollkästchen 13×13 px, `<summary>` 17–19 px,
◀ ▶ 33×31 px, Links 15 px). Lighthouse bemängelt „target-size“ nur auf der 404-Seite, der Rest ist WCAG-AA-konform
(24 px), aber für Handschuh-/Nassbedienung zu klein. **Handlungsanweisung:** in `src/style.css` unter
`@media (max-width: 760px)`: `button, select, input:not([type=checkbox]):not([type=range]), summary { min-height: 44px }`,
`input[type=checkbox] { width: 22px; height: 22px }`, `.tour button { min-width: 48px }`. Beleg
[23-handy-koritnica-ganz.jpg](pruefbericht-2026-11-26/23-handy-koritnica-ganz.jpg).

### O2 · Handy – Bilddatum im Kartenkopf ausgeblendet (mittel, S)
`.img-date { display:none }` unter 760 px (`src/style.css:151`): Aufnahmedatum und Tendenz – laut
ANFORDERUNGEN-PEGEL.md „gut sichtbar“ – fehlen am Handy auf der Karte. **Handlungsanweisung:** am Handy in eine zweite
Zeile des Kartenkopfs verkürzt anzeigen („21.08.2023 · unauffällig“).

### O3 · Handy – Leistung beim Start (mittel, M)
Lighthouse Handy: TBT 2,9 s, TTI 8,4 s, Hauptthread 6,9 s; ~243 kB ungenutztes JS beim Start. **Handlungsanweisung:**
Analysemodule (`route.ts`, `sentinel.ts` + `geotiff`, `whitewater.ts`, `gauges.ts`, `weather.ts`) per `import()` erst
beim ersten Analysestart laden; MapLibre in eigenen Chunk (`build.rollupOptions.output.manualChunks`). Ziel: Start-JS
< 600 kB.

### O4 · Bundle (gering, S)
Haupt-Chunk 1,24 MB; die Vite-Warnung ist per `chunkSizeWarningLimit: 1500` (`vite.config.ts:6`) abgeschaltet – nach O3
auf ~600 kB senken, damit ein wachsendes Bundle wieder auffällt. `valid-source-maps`: `build.sourcemap: true` hilft bei Fehlermeldungen
von Nutzern.

### O5 · Doppelte/unnötige Netzabrufe (mittel, S)
- Kartverket außerhalb Norwegens (F6), GloFAS-Langreihe (F1).
- `flood-api` wird je Analyse 2–3× aufgerufen (`riverCell`: Linienpunkte + 3×3-Ring); Ergebnis je Strecke cachen.
- NAIP: 265 Kacheln für 15,7 km (Arkansas, 120 s) – Streifen auf ±45 m begrenzen und Kacheln parallel, aber gedrosselt
  laden; Fortschrittsanzeige zeigt bereits „Bildkacheln x/y“ ✓.

### O6 · Bedienung/Texte (gering–mittel, S)
- „Markierungen verwalten & lernen“: Infotext 10 Zeilen – auf 2 Zeilen kürzen, Rest in `title`/„mehr“.
- Fehlermeldungen auf Deutsch (F4).
- Bildabschnitt-Schild „B2 · 22.09.2022 · unauffällig“ wird am rechten Kartenrand abgeschnitten
  ([01-salzach-…](pruefbericht-2026-11-26/01-salzach-einstieg-neben-fluss.jpg)) → `anchor` je nach Lage setzen.
- Nach „Steilster Abschnitt“-Klick springt die Karte auf Zoom 17,5 ✓; am Handy liegt die Karte dann oberhalb –
  `scrollIntoView` (wie F14).

### O7 · Code (mittel, M)
- **Tote Funktionen** (nirgends verwendet): `src/discharge.ts` `summerMean`, `flowOn`, `meanFlow`, `latestDate`,
  `classify` (Reste der GloFAS-Anzeige – entfernen senkt das Risiko, dass wieder eine Modellzahl erscheint),
  `src/vectorWater.ts` `glacierAreaNear`, `src/weather.ts` `samplePoints`; `scripts/q.tmp.mts` (Temporärskript).
- **Lange Funktionen in `src/main.ts` (1 771 Zeilen):** `analyzeOsmSection` 183 Zeilen, `showResults` 118,
  `setShowCatch`-Block 114, `renderFlowInfo` 106, `updateExternalLinks`-Block 92. Vorschlag: `renderFlowInfo` →
  `src/ui/flowInfo.ts` (reine Funktion `flowInfoHtml(flow): string` – dann testbar), Export-/Teilen-Teil →
  `src/ui/export.ts`, Markierungen → `src/ui/labels.ts`.
- **Fehlende Tests:** `imagery.ts` (Abschnittsbildung, F10), `flowInfoHtml` (keine Modellzahl, „≈“ bei Schätzung,
  Escaping), Endpunkt-Snap (F2), Open-Meteo-Gewichtung (F1), `inNorway` (F5/F6), Zahlformat (F13).

---

## Was gut funktioniert

- **Stabilität:** 62/62 e2e-Prüfungen, 119 Unit-Tests, keine einzige JS-Ausnahme (`pageerror`) in rund 50 Analysen,
  auch nicht bei blockierten Quellen, Mehrfachklicks, Fenstergrößenwechsel während der Analyse oder gesperrtem
  `localStorage` (App läuft normal weiter).
- **Abbrechen** funktioniert in früher (Sentinel-Suche) und später Phase (Weißwasser-Kacheln 59/1522) sofort, Meldung
  „Berechnung abgebrochen. Du kannst sofort eine neue Strecke wählen.“ – vorbildlich. Esc, Zurücksetzen, doppeltes Laden ✓.
- **Flusslinie** an allen Referenzflüssen sauber auf dem Wasser (100 % OSM), Nahe nicht auf Straße/Bahn ✓; vertauschte
  Klicks werden erkannt („Fließrichtung anhand der Höhen umgedreht“) ✓; Ausfall von OpenFreeMap fällt sauber auf
  Satellit zurück mit Warnung „Flusslauf unsicher“ ✓.
- **Pegel:** Landeck Bruggen 5,5 m³/s (Referenz ~5 ✓), Kal-Koritnica, Tumpen, SYKE Oulankajoki mit Werten an drei
  Aufnahmetagen und „veraltet“-Kennzeichnung, Hub'Eau Ubaye mit Verhältnis heute/Aufnahmetag (2,7×), ARSO-Schätzung
  zwischen zwei Pegeln klar als „≈ … geschätzt“ ✓. Keine GloFAS-Zahl sichtbar ✓.
- **Weißwasser Sanna:** Schiefes Eck, Pianser Schwall, Wehr Landeck an den erwarteten Stellen ✓; Salzach-Wehr km 3,75 ✓;
  Dettifoss + Hafragilsfoss als Gefahrenstellen ✓; ohne auswertbares Orthofoto klarer Hinweis statt Fantasiestellen ✓.
- **Gletscher:** Ötz mit „Warm im Hochgebirge … starke Gletscherschmelze“ und „Gletscherfluss im Sommer“ ✓.
- **Esri-Vergrößerung:** Charyn bis Zoom 19 ohne graue Kacheln, Kartenkopf „Esri hier nur vergrößert – schärfer evtl. bei
  Google/Apple ↗“ ✓ ([19-charyn-zoom19-vergroessert.jpg](pruefbericht-2026-11-26/19-charyn-zoom19-vergroessert.jpg));
  Koritnica bis 19 scharf ✓. „Schärfer ↗“-Links tragen exakt die Kartenmitte (Google Maps `center=46.349000,13.581500
  &zoom=19&basemap=satellite`, Earth `@46.349,13.5815,…150d`, Apple `ll=…&z=…&t=k`) ✓.
- **Export:** alle 5 GPX-Varianten (Standard, ohne, Teilung, km-Punkte, alle) und Sonderzeichen-Namen („Şarın River“,
  „Soča · …“, „Fluss & Bach <Test> "Zitat"“) **validieren gegen GPX 1.1** ✓; alle Trackpunkte mit Höhe ✓; CSV/GeoJSON ✓;
  „Teilen …“ fällt am Desktop auf Download zurück ✓; Dateinamen ohne Sonderzeichen (`koritnica-kluze-muendung.gpx`) ✓.
- **Wellen messen:** 4 Kämme → „Ø 5,8 m Abstand → ca. 2,1–3,0 m/s“ ✓.
- **Lighthouse Desktop:** 96/100/100; Barrierefreiheit 100 auch am Handy; Tastatur-Reihenfolge logisch
  (Suche → Referenz → Modi → Parameter → Karte → Hintergrund).
- **Schlüsselhygiene** vorbildlich (siehe R7).

---

## Tipps zur Weiterarbeit

1. **Zuerst F1** (eine Zeile in `discharge.ts`) – ohne sie sind alle weiteren Tests der Wetterhinweise durch das
   Tageslimit verfälscht. Danach `pruefung-fail.cjs` erneut laufen lassen: Ziel < 100 gewichtete Aufrufe.
2. **F2 + F3 zusammen** (Endpunkt-Snap, See/Meer-Erkennung) – größter Einfluss auf die Kennzahlen; anschließend die
   Referenzstrecken erneut mit `node tests/e2e/pruefung.cjs ref` messen (Salzach muss auf ≈ 7–8 m/km fallen).
3. **F5 + F6** gemeinsam über eine Polygon-Funktion `inNorway`.
4. **F4/F11/F14 + O6** als „Meldungen“-Paket (eine Übersetzungsfunktion, Quellen-Ausfallzeile).
5. **R2 + R1** mit dem Nutzer klären (Wortwahl „Schwierigkeit“/„WW I“, existenz.ch).
6. **O1/O2** (Handy) – danach am echten Handy F8 und F14 gegenprüfen.
7. **O3/O7** (Code aufteilen, Lazy Loading, tote Funktionen) erst, wenn die Fehler behoben sind; dabei die neuen Tests
   anlegen: `imagery.test.ts`, `flowInfo.test.ts`, Snap-Test in `route.test.ts`, `inNorway` in `dem.test.ts`.
8. Neue Referenzen in die Fixtures: Ötz (Achstürze), Arkansas Royal Gorge, Piteälven (SMHI-Station), Achensee/Adria
   als Negativfälle (müssen eine Warnung erzeugen).
9. Prüfskripte dieses Berichts in den Ablauf aufnehmen: `ref` nach Datenänderungen, `fail` nach Änderungen an
   Netzabrufen. Für Läufe in der Cloud `WEATHER_FILE` (siehe `screenshot.cjs`) nutzen, um das Open-Meteo-Limit zu schonen.

---

## Das Wichtigste nach der 80/20-Regel

1. **GloFAS-Langreihe seit 1984** verbraucht ~1 100 Open-Meteo-Aufrufe je Analyse → in `src/discharge.ts:89` nur die
   letzten 46 Tage abfragen → Wetterhinweise funktionieren wieder (statt Limit nach ~8 Analysen), eine Zeile Code.
2. **Einstieg neben dem Fluss** ergibt Scheingefälle (Salzach 112 m/km, Achensee 458 m/km) → Endpunkte aufs Wasser setzen
   und Warnung bei Abstand > 60 m → die wichtigste Kennzahl „steilster Abschnitt“ wird verlässlich.
3. **NVE-Hinweis und Kartverket-Abfragen in Schweden/Finnland** → Rechteck durch Norwegen-Polygon ersetzen → keine
   Fehlhinweise, 49 unnötige Anfragen und Zeitüberschreitungen weniger.
4. **Englische Fehlermeldung „Failed to fetch“ nach 92 s** → Fehler übersetzen, Quelle nennen, nach 3 Fehlkacheln
   abbrechen → Nutzer weiß sofort, was los ist.
5. **Tippziele am Handy < 44 px** (66 von 69) → Mindestgrößen per CSS-Media-Query → Bedienung im Boot/mit Handschuh.
6. **„Schwierigkeit“ und „WW I/II“ in der Bewertung** → Überschrift „Indikator“, Klassen wie im Gefälle-Modus
   formulieren → Vorgabe „Gefälle ist Indikator“ eingehalten.
7. **Inn-Schätzung aus Momentanwerten** (29 statt ~61 m³/s) → Tagesmittel bzw. Spanne verwenden → Schätzung im
   Schwallbetrieb nicht mehr um Faktor 2 schwankend.
8. **See/Meer werden als Fluss ausgewertet** → Höhe ≈ 0 bzw. OSM-Wasserfläche erkennen und warnen → keine sinnlosen
   Ergebnisse.
9. **Ausgefallene Quellen werden verschwiegen** (ARSO, Esri-Metadaten) → `gaugeErrors` anzeigen → Nutzer unterscheidet
   „kein Pegel“ von „Pegeldienst gestört“.
10. **3D + Drehen → leere Karte** (Headless) → am echten Gerät prüfen, ggf. MapLibre aktualisieren → 3D-Ansicht
    verlässlich.
