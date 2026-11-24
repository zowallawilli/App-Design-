# Packraft-Planer – Prototyp Phase 1

Webanwendung zur **Gefälleanalyse von Flussabschnitten** für die Packrafting-Tourenplanung.
Ein Abschnitt wird auf Satellitenbildern festgelegt. Die App berechnet aus einem weltweiten
Höhenmodell das Längsprofil, das Gefälle je Abschnitt, die steilsten Stellen (Hotspots) und Talengen.

> ⚠️ Das Gefälle ist ein **Indikator**, keine Wildwasser-Bewertung. Siphons, Holz, Verblockung,
> Wasserstand und Engstellen unterhalb der Auflösung des Höhenmodells (ca. 10–30 m) werden nicht erfasst.

## Online nutzen

**https://zowallawilli.github.io/App-Design-/** – wird bei jeder Änderung auf `main` automatisch neu gebaut (`.github/workflows/deploy.yml`).

## Lokal starten

```bash
npm install
npm run dev        # Entwicklungsserver auf http://localhost:5173
npm test           # Unit-Tests
npm run build      # statische Dateien in dist/ (auf jedem Webspace hostbar)
```

Für das Prüfskript mit echten Höhendaten der Soča:

```bash
npx tsx scripts/soca.mts
```

## Bedienung

| Funktion | Beschreibung |
|---|---|
| **Referenzstrecke** | Soča (Slowenien): Na Logu–Kobarid, Oberlauf, Čezsoča–Kobarid |
| **Fluss aus OSM** | Fluss anklicken → wird aus OpenStreetMap geladen und verkettet. Danach Ein- und Ausstieg anklicken. |
| **Talweg aus DGM** | Ein- und Ausstieg anklicken → Fließweg wird direkt aus dem Höhenmodell abgeleitet (für Gebiete mit lückenhaften OSM-Daten, z. B. Zentralasien) |
| **Zeichnen** | Strecke flussabwärts selbst klicken |
| **Profil** | Längsprofil mit Gefälleklassen; Hover zeigt die Position auf der Karte |
| **Hotspots** | Steilste Stellen, sortiert; Klick zoomt hin |
| **Export** | GPX (Track + Hotspots als Wegpunkte, z. B. für GPS/Offline-Karten), CSV, GeoJSON |
| **Hintergrund** | Esri-Satellitenbild, Sentinel-2 cloudless (EOX), OpenTopoMap, 3D-Gelände |

## Wie die Analyse funktioniert

1. **Abtastung** der Flusslinie alle 25 m.
2. **Talboden-Suche:** An jedem Punkt wird quer zur Fließrichtung (±15 m, ±30 m) der tiefste
   Höhenwert genommen. So wirken sich kleine Lageabweichungen der Linie oder Hangpixel weniger aus.
3. **Hydrologische Glättung:** Eine isotone Regression erzwingt ein monoton fallendes Profil
   (Flüsse fließen nicht bergauf). Das entfernt Ausreißer wie Brücken oder Vegetation. Danach
   verteilt ein gleitendes Mittel über 300 m die Treppenstufen des Höhenmodells.
4. **Abschnitte** (250 m / 500 m / 1 km) bekommen ihr Gefälle in m/km und eine Gefälleklasse.
5. **Hotspots:** Ein 250-m-Fenster gleitet über die Strecke. Stellen mit Gefälle ≥ Schwelle
   (Standard 30 m/km) und ≥ 10 m Höhenverlust werden markiert.
6. **Talenge:** Steigen die Hänge 100 m quer zum Fluss auf beiden Seiten um ≥ 20 m, wird der
   Abschnitt als Talenge markiert. Das deutet auf eine Schlucht hin, in der Umtragen schwierig sein kann.
7. Die **Fließrichtung** wird anhand der Höhen geprüft und bei Bedarf umgedreht.

### Gefälleklassen (Faustregeln)

| m/km | Klasse | Typischer Hinweis |
|---|---|---|
| < 3 | flach | meist zahm (WW I–II) |
| 3–8 | mäßig | häufig WW II |
| 8–15 | deutlich | häufig WW II–III |
| 15–30 | steil | WW III–IV möglich |
| 30–60 | sehr steil | Wildbach-Charakter, Umtragen wahrscheinlich |
| > 60 | extrem | Stufen/Fälle, meist nicht fahrbar |

Die Schwellen stehen in `src/analysis.ts` (`GRADIENT_CLASSES`) und sollen mit eigenen Erfahrungswerten kalibriert werden.

## Datenquellen

| Daten | Quelle | Hinweis |
|---|---|---|
| Höhen | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium) | weltweit; SRTM, EU-DEM, nationale DGMs; Auflösung regional 3–90 m |
| Gewässer | OpenStreetMap über Overpass API | © OSM-Mitwirkende, ODbL |
| Ortssuche | Nominatim | Nutzungsbedingungen beachten (sparsame Nutzung) |
| Satellitenbild | Esri World Imagery | nur Anzeige, keine automatisierte Auswertung |
| Satellitenbild | Sentinel-2 cloudless 2023 (EOX) | CC BY-NC-SA 4.0 |
| Topo | OpenTopoMap | CC-BY-SA |

## Ergebnis Referenzfluss Soča (Talweg aus DGM, Zoom 12/13)

| Strecke | Länge | Höhen | Ø Gefälle |
|---|---|---|---|
| Na Logu – Kobarid | 36,6 km | 607 → 227 m | 10,4 m/km |
| Oberlauf Na Logu – Čezsoča | 18,3 km | 607 → 374 m | 12,7 m/km |
| Čezsoča – Kobarid | 18,4 km | 372 → 225 m | 8,0 m/km |

Die steilsten Stellen liegen im Trenta-Tal, beim Dorf Soča und zwischen Srpenica und Kobarid.
Schmale Klammen wie die Velika Korita sind schmaler als ein Pixel des Höhenmodells und werden deshalb nicht als Talenge erkannt.

## Projektstruktur

```
src/
  geo.ts           Geometrie (Distanzen, Abtastung, Snapping)
  dem.ts           Höhenkacheln laden/dekodieren, bilineare Interpolation
  analysis.ts      Profil, Glättung, Abschnitte, Hotspots, Talenge
  flow.ts          Talweg aus Höhenmodell (Priority-Flood + D8)
  osm.ts           Overpass-Abfragen, Verkettung von Flusswegen, Ortssuche
  profileChart.ts  Längsprofil (SVG)
  export.ts        GPX/CSV/GeoJSON
  presets.ts       Referenzstrecken
  main.ts          Karte und Bedienoberfläche
tests/             Unit-Tests (vitest)
scripts/           Prüfskript mit echten Höhendaten
```

## Nächste Schritte (Roadmap)

- **Phase 2 – Abfluss & Zeitreihen:** Pegel anbinden (NVE Norwegen, SMHI Schweden, SYKE Finnland,
  ARSO Slowenien, BAFU) sowie GloFAS-Modellabfluss für Gebiete ohne Pegel. Sentinel-2-Szenen mit
  dem Abfluss am Aufnahmetag verknüpfen und per Schieberegler vergleichen.
- **Höhenmodelle Skandinavien:** Kartverket DTM 1/10 m (Norwegen) und Lantmäteriet (Schweden) für
  deutlich genauere Profile.
- **Phase 3 – Eigene Notizen & offline:** Stromschnellen markieren, Schwierigkeit, Fotos, Pegel bei
  der Befahrung, Umtragestellen. Offline-Nutzung als PWA.
- **Phase 4 – Modell:** Schwierigkeitsschätzung aus Gefälle, Abfluss, Talenge und Weißwasser-Anteil,
  trainiert mit eigenen Befahrungsdaten.
