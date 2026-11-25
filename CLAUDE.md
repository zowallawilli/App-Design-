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
| `src/weather.ts` | Hinweise ohne Pegel: Regen/Schnee/Schneeschmelze vor dem Tag (Open-Meteo ERA5) + Jahreszeit → Tendenz |
| `src/gauges.ts` | Offizielle Pegel: SMHI, SYKE, NVE, PEGELONLINE, BAFU, ARSO, HD Tirol, Hub'Eau (FR), Südtirol; `matchGauge` (auch Pegel bis 5 km ober-/unterhalb, interpoliert) |
| `src/estimate.ts` | Abfluss für Pegel ohne Q aus Nachbarpegeln (Einzugsgebiet, Flusskilometer, Ausleitungs-Erkennung) |
| `src/dem.ts` | Höhen: AWS Terrarium global, Kartverket 1 m für Norwegen (WCS, ohne INTERPOLATION-Parameter!) |
| `src/vectorWater.ts` | OSM-Gewässer aus OpenFreeMap-Vektorkacheln (Overpass nur Fallback) |
| `src/imagery.ts` | Esri-World-Imagery-Metadaten: Aufnahmedatum/Auflösung je Abschnitt |
| `scripts/tirol-mirror.mjs` + `.github/workflows/pegel-tirol.yml` | Tirol-Pegel (kein CORS) alle 30 min in Branch `pegeldaten` spiegeln, Archiv der Tagesmittel `tirol-archiv/` (≤ 400 Tage, Branch = 1 Commit) |
| `tests/*.test.ts`, `tests/e2e/` | Unit-Tests, Browser-Test (41 Prüfungen), Screenshot-Skript |

Netzwerk in der Cloud-Umgebung „Packraft-Planer“: erlaubte Hosts sind dort hinterlegt; neue
Datenquellen brauchen ggf. einen weiteren Host. Node-`fetch` braucht dort
`NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` (curl geht direkt).

## Kalibrierung durch den Nutzer
Gefälleklassen: < 3 m/km Zahmwasser · 3–8 WW I · 8–15 WW II · 15–30 WW II–III · 30–60 WW III–IV · > 60 WW IV+.
Wucht-Grenzen (W/m): 300 / 1000 / 2500 / 6000 / 15000. Großvolumige Flüsse (Wuchtwasser) dürfen
nicht zu leicht eingestuft werden – deshalb „kombiniert“ (schwierigere aus Gefälle und Wucht) als Standard.

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
- **Ötztaler Ache (AT)** Tumpen [10.9111, 47.1610] → Ötz [10.8930, 47.2050] (Zoom 12.7): Gletscherfluss (9,3 %).

## Offene Punkte / Ideen
- Verblockung („Schiefes S“, „Pianser Schwall“ an der Sanna) ist mit Gefälle/Höhenmodell nicht
  erkennbar – bräuchte Bildauswertung (z. B. Weißwasser-Erkennung im hochaufgelösten Luftbild).
- Tirol: Archiv der Tagesmittel erst ab 24.11.2026 → Eichung ab ~10 Tagen, Aufnahmetage älterer Luftbilder
  bleiben ohne Messwert (eHYD-Jahrbuch nur bis Vorjahr−1, kein dokumentierter Endpunkt).
- Inn bei Imst/Magerbach: geschätzt aus Innsbruck (unterhalb), weil Landeck Perjen in der Restwasserstrecke liegt
  (Perjen enthält die Sanna – nie zu Bruggen addieren). Imst ~61, Magerbach ~75 m³/s am 25.11.2026.
- Weitere Regionen: Bayern GKD (keine API, blockt Abrufe), Vorarlberg/Salzburg/Aosta (keine offene API), Zentralasien, weltweit.
- Tests mit lokalem Tirol-Spiegel: `TIROL_DIR=<ordner> SHOT=flow node tests/e2e/screenshot.cjs …` (siehe Kopf des Skripts).
- GitHub pausiert die Tirol-Action nach 60 Tagen ohne Commit → in Actions wieder aktivieren.
