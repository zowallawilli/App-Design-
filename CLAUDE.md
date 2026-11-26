# Packraft-Planer – Projektkontext für Claude

Web-App für einen Packrafting-Expeditionsguide: Flussabschnitte auf Befahrbarkeit prüfen
(Gefälle aus Höhenmodellen, Luft-/Satellitenbilder mit Aufnahmedatum, Pegel/Abfluss am
Aufnahmetag und heute, Schluchten/Engstellen/Stufen, Wildwasser-Einschätzung).
Live: https://zowallawilli.github.io/App-Design-/ · Oberfläche und Texte auf **Deutsch**.
Ausführliche Doku (Datenquellen, Verfahren, Referenzvergleiche): `README.md`.

## Arbeitsweise (vom Nutzer so gewünscht)
1. Umsetzen → `npm test` (vitest) + `npx tsc --noEmit` → Browser-Test `npm run e2e` (Dev-Server
   vorher starten: `npx vite --port 5173 &`) → bei Datenänderungen Referenzflüsse prüfen.
2. Commit + Push auf den Entwicklungsbranch, PR gegen `main`, dann **fragen „Soll ich mergen?“**
   und erst nach Freigabe mergen. Nach dem Merge Pages-Deploy (Actions) prüfen.
3. Ergebnisse, die der Nutzer abgleichen will, als Screenshots schicken
   (`tests/e2e/screenshot.cjs`, Kopfkommentar zeigt den Aufruf).
4. Kontingent schonen: Arbeit bündeln, lange Testläufe nur wenn nötig.
5. Koordinaten in Antworten immer als direkt klickbaren Google-Maps-Link ausgeben, z. B.
   [47.13441, 10.51223](https://www.google.com/maps/search/?api=1&query=47.13441,10.51223) (Breite, Länge).

## Feste Vorgaben
- **Keine Modell-Abflusszahlen anzeigen** (Nutzerentscheidung 25.11.2026): nur gemessene Pegelwerte bzw. klar
  gekennzeichnete Schätzungen aus Nachbarpegeln; sonst Hinweise aus Wetter/Jahreszeit ohne Zahl zum Abfluss.
  Begründung: GloFAS-Abgleich an 223 Pegeln – meist um ein Mehrfaches daneben (README).
- **Keine Kosten:** kein eigener Server, keine kostenpflichtigen APIs. Statische App auf GitHub
  Pages; Hilfsjobs nur als GitHub Actions (öffentliches Repo → kostenlos).
- **Schlüssel nie ins Repo oder in die Umgebung:** NVE-HydAPI-Schlüssel ist persönlich und liegt
  nur im Browser (localStorage `packraft.nveKey`).
- **Nur offizielle/dokumentierte Schnittstellen** (z. B. nicht sildre-api.nve.no).
- Gefälle ist ein **Indikator**, keine Schwierigkeitsbewertung – in Texten so formulieren.

Aktueller Arbeitsauftrag mit allen Nutzeranforderungen zu Pegeln/Wetter: `docs/ANFORDERUNGEN-PEGEL.md`.

## Technik
Vite + TypeScript + MapLibre GL, vitest, Playwright (vorinstalliert, `require('playwright')`).
Im Dev-Modus ist die Karte als `window.__map` erreichbar (für e2e-Klicks).

| Datei | Inhalt |
|---|---|
| `src/main.ts` | UI, Modi (OSM / Ein-/Ausstieg / Zeichnen / Wellen), Abbrechen, Ergebnisanzeige, Abfluss-Tabelle |
| `src/route.ts` | Flusslauf zwischen Ein-/Ausstieg: Least-Cost-Pfad aus OSM + Sentinel-2 (NDWI) + Höhenmodell |
| `src/analysis.ts` | Profil (isoton, geglättet), Gefälleklassen, Hotspots, Steilstufen (≥ 8 m / 100 m) |
| `src/narrows.ts` | Schluchten (Talquerschnitt), verdeckte Klammen, optionale Sentinel-Engstellen |
| `src/power.ts` | Wucht = Strömungsleistung Ω = ρ·g·Q·S, kombinierte Bewertung, Wellen → Fließgeschwindigkeit |
| `src/discharge.ts` | GloFAS (Open-Meteo Flood API) – nur noch intern zur Pegelauswahl, nicht anzeigen; Länderlinks zu Pegeln |
| `src/catchment.ts` | Einzugsgebiet oberhalb (Fluss + Zubringer flussaufwärts verfolgen, Bezugspunkte fürs Wetter, Fläche, Speicher) |
| `src/weather.ts` | Hinweise ohne Pegel: Regen (verbreitet/örtlich)/Schnee/Schmelze/Gletscher im Einzugsgebiet + Jahreszeit → Tendenz; Zeitfenster nach Gebietsgröße |
| `src/gauges.ts` | Offizielle Pegel: SMHI, SYKE, NVE, PEGELONLINE, BAFU, ARSO, HD Tirol, Hub'Eau (FR), Südtirol; `matchGauge` (auch Pegel bis 5 km ober-/unterhalb, interpoliert) |
| `src/estimate.ts` | Abfluss für Pegel ohne Q aus Nachbarpegeln (Einzugsgebiet, Flusskilometer, Ausleitungs-Erkennung) |
| `src/dem.ts` | Höhen: AWS Terrarium global, Kartverket 1 m für Norwegen (WCS, ohne INTERPOLATION-Parameter!) |
| `src/vectorWater.ts` | OSM-Gewässer aus OpenFreeMap-Vektorkacheln (Overpass nur Fallback) |
| `src/imagery.ts` | Esri-World-Imagery-Metadaten: Aufnahmedatum/Auflösung/feinste Stufe je Abschnitt |
| `src/esriTiles.ts` | Protokoll `esri://`: fehlende feine Esri-Stufen aus gröberer Kachel vergrößern (Tilemap), statt grauer Platzhalter |
| `src/profileChart.ts` | Höhenprofil (SVG): Klick → Karte springt zur Stelle; Leiste Bildabschnitte B1… (Datum, Tendenz) |
| `src/export.ts` | GPX (Track mit Höhen, Ein-/Ausstieg, Stellen als Wegpunkte), CSV, GeoJSON, Teilen-Menü (Gaia GPS) |
| `src/whitewater.ts` | Schwallstellen: Weißwasser im offenen Orthofoto (basemap.at, GURS DOF 2023, NÁTT Island), Streifenbild, Textur, Lernen; Abbruchkanten (`findBreaklines`) |
| `src/whitewaterStore.ts` | eigene Markierungen + gelernte Schwelle (localStorage, JSON-Export/-Import), Browser-Dekoder |
| `scripts/breakline-eval.mts` | Messung Gefahrenstellen gegen `tests/fixtures/abbruchkanten.json` |
| `scripts/whitewater-eval.mts` | Messung gegen `tests/fixtures/schwallstellen.json`, Kontrollbilder (Fluss gerade gezogen) |
| `scripts/tirol-mirror.mjs` + `.github/workflows/pegel-tirol.yml` | Tirol-Pegel (kein CORS) alle 30 min in Branch `pegeldaten` spiegeln, Archiv der Tagesmittel `tirol-archiv/` (≤ 400 Tage, Branch = 1 Commit) |
| `tests/*.test.ts`, `tests/e2e/` | Unit-Tests, Browser-Test (41 Prüfungen), Screenshot-Skript |

Netzwerk in der Cloud-Umgebung „Packraft-Planer“: erlaubte Hosts sind dort hinterlegt; neue
Datenquellen brauchen ggf. einen weiteren Host. Node-`fetch` braucht dort
`NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` (curl geht direkt).

## Kalibrierung durch den Nutzer
Gefälleklassen: < 3 m/km Zahmwasser · 3–8 WW I · 8–15 WW II · 15–30 WW II–III · 30–60 WW III–IV · > 60 WW IV+.
Wucht-Grenzen (W/m): 300 / 1000 / 2500 / 6000 / 15000. Großvolumige Flüsse (Wuchtwasser) dürfen
nicht zu leicht eingestuft werden – deshalb „kombiniert“ (schwierigere aus Gefälle und Wucht) als Standard.

## Bedienung (Nutzerwünsche 26.11.2026)
- Kein Hintergrund „Orthofoto AT“ (nur Österreich; App dient v. a. Expeditionen) – basemap.at bleibt nur für die Auswertung.
- Kein farbiges Band neben der Strecke für Bildabschnitte; Zuordnung über Profil-Leiste + kleines Schild.
- Höhere Auflösung nur als Anzeige/Link (Google Maps/Earth, Apple); keine kostenpflichtigen Kachel-APIs.
- Ergebnisseite knapp: oben nur Länge, Höhe, Höhenverlust, Ø Gefälle, steilster Abschnitt (Titel = Flussname);
  Herleitung, Pegel-Details, Bildquellen, Erkennungsregeln eingeklappt (`details.more`).
- GPX: Steilstrecken (≥ 15 m/km) als eigene Tracks + Wegpunkt (Standard), Teilung nach Gefälle und km-Punkte optional;
  Gaia liest keine Farben. Teilen-Knopf = allgemeines Teilen-Menü (Gaia erschien dort beim Nutzer nicht → Hinweistext).

## Referenzflüsse und bekannte Ergebnisse
- **Soča (SI)** Srpenica–Trnovo, Soča-Dorf: Hauptreferenz, Literatur WW II–III+.
- **Koritnica (SI)**: Mäander/Schlucht, Einstieg am Ende der Kluže-Schlucht – Testfall fürs Tracking.
- **Sjoa (NO)**: Ridderspranget, Åsengjuvet, Playrun, Åmot – Kartverket 1 m.
- **Nahe Kirn–Monzingen (DE)**: max. WW II, meist WW I; Testfall „Route nicht auf Straße/Bahn“.
- **Markarfljót (IS)**: Wuchtwasser, großer Wasserfall am Schluchtbeginn; Island hat keine offene Pegel-API.
- **Oulankajoki (FI)**: Modell 4–15× zu niedrig, SYKE-Pegel maßgeblich. **Piteälven (SE)**, **Lahn/Isar (DE)**.
- **Sanna (AT)** Einstieg [10.4910, 47.1176] → Landeck [10.5630, 47.1436]: Pegel Landeck Bruggen
  (~5 m³/s im Nov.), GloFAS ~10× zu hoch.
- **Inn, Imster Schlucht (AT)** [10.7450, 47.2164] → [10.8976, 47.2642] (Screenshot-Zoom 12.2):
  Pegel Imst/Magerbach veröffentlichen öffentlich nur die Wasserstandsklasse; RiverApp zeigt Magerbach 25.11. ~74 m³/s,
  190 cm (eigener Datenzugang). App-Schätzung Magerbach 64–75 m³/s (Schwall).
- **Salzach Taxenbach – Lend (AT)** [12.9640, 47.2925] → [13.0480, 47.2990]: breiter, milchiger Fluss; Nutzer meldete
  fehlende Schwallstellen → relatives Weißwasser-Kriterium + ±45-m-Streifen (3/6 sichtbare Schwälle, vorher 0/6).
- **Charyn/Şarın (KZ)** [79.1009, 43.3599] → [79.1631, 43.4215] (Zoom 12.6): Esri 0,34 m, aber nur bis Stufe 17 → Testfall Vergrößerung/„Schärfer ↗“.
- **Ötztaler Ache (AT)** Tumpen [10.9111, 47.1610] → Ötz [10.8930, 47.2050] (Zoom 12.7): Gletscherfluss (9,3 %).

## Schwallstellen (Weißwasser) – Vorgaben des Nutzers
- Nur markieren, nicht einschätzen; Schwallstellen mit Wellensymbol ohne Nummer. Wehre ebenfalls markieren.
- Gefahrenstelle = **rote Welle** (einziges Gefahrensymbol, `hazards()` in main.ts). **Nutzerregel 11/2026:** nur
  (1) deutlicher Höhenverlust **und** im Luftbild Abbruchkante (`findBreaklines`) oder deutliches Weißwasser
  (Steilstufe + starke Schwallstelle), oder (2) Fluss wegen Verengung nicht sichtbar (Klamm, steil; mit Orthofoto
  nur wo auch dieses kein Wasser zeigt). **Keine** Gefahrenstelle aus dem Höhenmodell allein (Brücken, Kiesbänke).
  Referenzbilder des Nutzers: Desktop-Ordner „Gefahrenstellen“ und „Stromschnellen“ (nur über Remote Control erreichbar). Keine ▼- und K-Marker
  mehr (Klammen erscheinen als Schlucht S). Abbruchkanten
  trainiert an Selfoss/Dettifoss/Hafragilsfoss (NÁTT); Messung `scripts/breakline-eval.mts` (3/5, 0 Fehlalarme seit
  „Gischt muss glatt sein“; Krimml im Schatten nicht erkannt). NAIP (USA) seit 11/2026 als Bildquelle. Hotspot-Marker entfernt (Gefälle zeigen die Abschnittsfarben).
- Sanna-Referenz (vom Nutzer bestätigt): Schiefes Eck (WW III, 90°-Rechtskurve bzw. kurz davor),
  Pianser Schwall (stärkster Weißwasseranteil), Wehr Landeck; Oberlauf an der Straßengalerie WW II–III = neutral.
- Empfindlichkeits-Regler 1–9 (`tunedParams`: Regler × Flussbreite, localStorage `packraft.wwSensitivity`).
  Ohne auswertbares Luftbild **keine** Schwallstellen, nur deutlicher Hinweis (Nutzerwunsch).
- Eigene Markierungen (Art + Grad + Notiz, Bildmerkmale) überstimmen die Erkennung (`applyLabels`); Modell
  `trainModel` (logistische Regression, je ≥ 5 Beispiele) ersetzt die festen Schwellen. Teilen mit anderen Nutzern:
  GitHub-Konto als Hürde abgelehnt – später gemeinsam brainstormen.
- Markierungen des Nutzers: Upload aus der App nach `daten/markierungen/*.json` (GitHub-Schlüssel nur im Browser,
  localStorage `packraft.ghToken`) → dort auswerten, Grundmodell daraus bauen.
- Referenzbilder des Nutzers kommen per Upload ins Repo (Ordner „Gefahrenstellen“/„Stromschnellen“) und werden ergänzt.
- Nur offene Orthofotos auswerten (Esri/Google/Apple nur Anzeige). Sentinel-2 ist dafür zu grob.
  Zielregionen für später: Island, Skandinavien, Nordamerika, Zentralasien, Neuseeland (Recherche im README).
- Kostenlose Schlüssel (MML Finnland, LINZ) erst später, wenn der Nutzer es will.

## Offene Punkte / Ideen
- Weißwasser: Kalkblöcke am Ufer vs. Schaum, Weißwasser im Schatten; weitere offene Orthofotos;
  Abbruchkanten im Schatten/als Kaskade (Krimml); Markarfljót, sobald das NÁTT-Mosaik dort Bilder hat.
- Tirol: Archiv der Tagesmittel erst ab 24.11.2026 → Eichung ab ~10 Tagen, Aufnahmetage älterer Luftbilder
  bleiben ohne Messwert (eHYD-Jahrbuch nur bis Vorjahr−1, kein dokumentierter Endpunkt).
- Inn bei Imst/Magerbach: geschätzt aus Innsbruck (unterhalb), weil Landeck Perjen in der Restwasserstrecke liegt
  (Perjen enthält die Sanna – nie zu Bruggen addieren). Imst ~61, Magerbach ~75 m³/s am 25.11.2026.
- Weitere Regionen: Bayern GKD (keine API, blockt Abrufe), Vorarlberg/Salzburg/Aosta (keine offene API), Zentralasien, weltweit.
- Tests mit lokalem Tirol-Spiegel: `TIROL_DIR=<ordner> SHOT=flow node tests/e2e/screenshot.cjs …` (siehe Kopf des Skripts).
- GitHub pausiert die Tirol-Action nach 60 Tagen ohne Commit → in Actions wieder aktivieren.
