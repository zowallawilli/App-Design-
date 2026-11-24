# Packraft-Planer – Prototyp Phase 1

Webanwendung zur **Gefälleanalyse von Flussabschnitten** für die Packrafting-Tourenplanung.
Ein- und Ausstieg werden auf der Karte gesetzt, der Flusslauf dazwischen wird automatisch aus
Sentinel-2-Satellitendaten, OpenStreetMap und dem Höhenmodell nachgezogen. Die App berechnet das
Längsprofil, das Gefälle je Abschnitt, die steilsten Stellen (Hotspots) und Talengen – in Norwegen
mit dem 1-m-Laserscanning-Höhenmodell von Kartverket, sonst mit einem weltweiten Höhenmodell.

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

Für das Prüfskript mit echten Daten der Soča (Flusslauf nachziehen und je Paddelabschnitt auswerten):

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/soca.mts
```

## Bedienung

| Funktion | Beschreibung |
|---|---|
| **Referenzstrecke** | Soča-Abschnitte (Trenta, Velika Korita, Čezsoča–Srpenica, Srpenica–Trnovo, Trnovo–Kobarid) und Koritnica, jeweils mit Schwierigkeit laut Literatur |
| **Ein-/Ausstieg** | Zwei Punkte anklicken → der Flusslauf dazwischen wird automatisch nachgezogen (siehe unten) |
| **Fluss aus OSM** | Fluss anklicken → wird aus OpenStreetMap geladen und verkettet. Danach Ein- und Ausstieg anklicken. |
| **Zeichnen** | Strecke flussabwärts selbst klicken |
| **Profil** | Längsprofil mit Gefälleklassen; Hover zeigt die Position auf der Karte |
| **Hotspots** | Steilste Stellen, sortiert; Klick zoomt hin |
| **Export** | GPX (Track + Hotspots als Wegpunkte, z. B. für GPS/Offline-Karten), CSV, GeoJSON |
| **Hintergrund** | Esri-Satellitenbild, Sentinel-2 cloudless (EOX), OpenTopoMap, 3D-Gelände |

## Flusslauf automatisch nachziehen (Modus „Ein-/Ausstieg“)

Zwischen Ein- und Ausstieg wird der **kostengünstigste Weg** (Dijkstra) über ein Raster gesucht.
Die Kosten je Zelle kombinieren drei Quellen:

| Quelle | Wirkung |
|---|---|
| **Sentinel-2** (10 m, wolkenarme Sommerszene der letzten 3 Jahre) | Wasser (NDWI > 0) und unbewachsenes Flussbett – Kies, Fels, Wildwasser (NDVI < 0,4) – sind billig, dichter Wald teurer. Liegt der Ausschnitt über einer Kachelgrenze, werden mehrere Szenen kombiniert. |
| **OpenStreetMap** | Kartierte Gewässerlinien werden ins Raster eingebrannt (der Fluss am Ein-/Ausstieg stark, Nebenbäche schwach). |
| **Höhenmodell** | Zellen weit über dem lokalen Talboden und bergauf fließen kosten extra. Wo Satellit oder OSM eindeutig ein Gewässer zeigen, wird dem Höhenmodell weniger vertraut – in engen Schluchten ist es oft um 20–80 m verschoben. |

Ohne Satellit/OSM folgt die Linie nur dem Talboden und kann Mäander abschneiden. Lange Strecken
werden erst grob gesucht und dann in 6-km-Stücken fein nachgezogen. Verlässt der Fluss den
Ausschnitt (großer Bogen), wird der Ausschnitt vergrößert.

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
| Höhen Norwegen | [Kartverket, Nasjonal høydemodell DTM](https://www.geonorge.no/) über WCS | Laserscanning, 1 m; CC BY 4.0; in EPSG:3857-Kacheln abgefragt. Bei Störung automatisch globales Modell |
| Höhen weltweit | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium) | SRTM, EU-DEM, nationale DGMs; Auflösung regional 3–90 m |
| Satellitendaten | [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/) (ESA Copernicus) über den STAC-Katalog von Element 84 | Bänder Grün, Rot, NIR; nur das benötigte Fenster wird gelesen (Cloud-Optimized GeoTIFF) |
| Gewässer | OpenStreetMap über Overpass API (3 Server, gestaffelt) | © OSM-Mitwirkende, ODbL |
| Ortssuche | Nominatim | Nutzungsbedingungen beachten (sparsame Nutzung) |
| Satellitenbild | Esri World Imagery | nur Anzeige, keine automatisierte Auswertung |
| Satellitenbild | Sentinel-2 cloudless 2023 (EOX) | CC BY-NC-SA 4.0 |
| Topo | OpenTopoMap | CC-BY-SA |

## Abgleich Soča: Gefälle vs. Literatur

Flusslauf mit Sentinel-2 nachgezogen (65 % der Linie auf Wasser/Kiesbett, Raster 6,6 m),
Gefälle aus dem globalen Höhenmodell, 250-m-Abschnitte (`scripts/soca.mts`):

| Abschnitt | Länge | Ø Gefälle | steilste 250 m | Literatur |
|---|---|---|---|---|
| Na Logu – Soča (Dorf) | 9,9 km | 13,0 m/km | 73 m/km | WW I–II, steinig (wenig Wasser) |
| Soča (Dorf) – Čezsoča | 9,6 km | 11,0 m/km | 74 m/km (km 10,3 ≈ Velika Korita) | WW II–IV, Velika Korita nur Experten |
| Čezsoča – Žaga | 7,6 km | 5,8 m/km | 19 m/km | WW I–II (Anfängerstrecke) |
| Žaga – Srpenica | 1,6 km | 1,4 m/km | 4 m/km | WW I–II |
| Srpenica – Trnovo | 5,4 km | 6,9 m/km | 39 m/km | WW II–III+, Hochwasser IV |
| Trnovo – Kobarid | 5,1 km | 13,5 m/km | 54 m/km, Talenge | Katarakt WW IV–V+, Otona–Kobarid III–IV |
| Koritnica Kluže – Mündung | 3,6 km | 16,7 m/km | 36 m/km (2 Hotspots) | WW III/IV |

**Erkenntnisse:** Die Reihenfolge stimmt. Die schwersten Abschnitte (Velika Korita, Trnovo-Schlucht)
haben die steilsten Stellen, die Anfängerstrecke das geringste Gefälle. Das **mittlere Gefälle allein
unterschätzt** wasserreiche Abschnitte mit einzelnen Stufen (Srpenica–Trnovo: 6,9 m/km, aber WW III+);
aussagekräftiger sind die steilsten 250 m und die Talenge. Im Oberlauf (Trenta) überschätzt das
Gefälle die Schwierigkeit, weil dort wenig Wasser fließt – hier fehlt die Abflussinformation (Phase 2).

## Projektstruktur

```
src/
  geo.ts           Geometrie (Distanzen, Abtastung, Snapping)
  dem.ts           Höhenkacheln (global + Kartverket), Zwischenspeicher, Schutzschalter
  analysis.ts      Profil, Glättung, Abschnitte, Hotspots, Talenge
  route.ts         Flusslauf zwischen Ein-/Ausstieg nachziehen (Kostenraster + Dijkstra)
  sentinel.ts      Sentinel-2-Szenensuche (STAC), NDWI/NDVI je Rasterzelle
  flow.ts          Höhenraster laden, Min-Heap, Pixel ↔ Koordinate
  osm.ts           Overpass-Abfragen (gestaffelt, Cache), Verkettung von Flusswegen, Ortssuche
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
- **Höhenmodelle Skandinavien:** Lantmäteriet (Schweden) und Maanmittauslaitos (Finnland) analog zu Kartverket.
- **Engstellen:** Flussbreite aus Sentinel-2 bzw. OSM-Wasserflächen messen, Talquerschnitte aus dem
  1-m-Modell (Schluchtbreite, Tiefe), Kombination mit Gefälle.
- **Phase 3 – Eigene Notizen & offline:** Stromschnellen markieren, Schwierigkeit, Fotos, Pegel bei
  der Befahrung, Umtragestellen. Offline-Nutzung als PWA.
- **Phase 4 – Modell:** Schwierigkeitsschätzung aus Gefälle, Abfluss, Talenge und Weißwasser-Anteil,
  trainiert mit eigenen Befahrungsdaten.
