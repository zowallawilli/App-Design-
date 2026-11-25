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
| **OpenStreetMap** | Gewässerlinien und Wasserflächen (aus hochauflösenden Luftbildern kartiert) werden ins Raster eingebrannt – der Fluss am Ein-/Ausstieg stark, Nebenbäche schwach. Quelle sind die Vektorkacheln von OpenFreeMap (CDN, kostenlos, ohne Schlüssel), Overpass nur noch als Ersatz. |
| **Höhenmodell** | Zellen weit über dem lokalen Talboden und bergauf fließen kosten extra. Wo Satellit oder OSM eindeutig ein Gewässer zeigen, wird dem Höhenmodell weniger vertraut – in engen Schluchten ist es oft um 20–80 m verschoben. |

Unbewachsene Flächen gelten nur nahe an bekanntem Wasser (≤ 60 m) als Flussbett – sonst würden im
Mittelgebirge Straßen, Bahnschotter, Dächer und abgeerntete Felder angezogen (so geschehen an der
Nahe). Schmale, baumgesäumte Flüsse wie die Nahe sind für Sentinel-2 (10–20 m) praktisch unsichtbar;
dort trägt OSM. Fehlen OSM und ein klares Satellitensignal, warnt die App „Flusslauf unsicher“.
Ohne Satellit/OSM folgt die Linie nur dem Talboden und kann Mäander abschneiden.

Geprüft (Luftbild-Detailansichten): Nahe Kirn–Monzingen, Isar Lenggries–Bad Tölz (verzweigtes
Kiesbett), Lahn Weilburg–Runkel (enge Mäander), Koritnica, Soča, Sjoa. Lange Strecken
werden erst grob gesucht und dann in 6-km-Stücken fein nachgezogen. Verlässt der Fluss den
Ausschnitt (großer Bogen), wird der Ausschnitt vergrößert.

## Hochauflösendes Luftbild, Aufnahmedatum und Abfluss am Aufnahmetag

Der Hintergrund „Luftbild“ (Esri World Imagery) ist je nach Region **0,25–1 m** aufgelöst – in
Slowenien das GURS-Orthofoto 2023 (25 cm), an der Sjoa Vantor/Maxar „Vivid“ (50 cm). Die App fragt
dazu den Esri-Metadatendienst ab und zeigt **Quelle, Aufnahmedatum und Auflösung** an (oben in der
Karte für die Kartenmitte, im Ergebnis je Streckenabschnitt).

Für jedes Aufnahmedatum wird der **Abfluss an diesem Tag** aus dem Copernicus-Hochwassermodell
GloFAS (Open-Meteo Flood API, Tageswerte seit 1984, Raster ~5 km) ermittelt und mit allen Jahren zur
gleichen Jahreszeit verglichen (sehr niedrig … sehr hoch). Daneben steht der heutige Modellabfluss:
„Heute fließt etwa 1,2× so viel wie am Aufnahmetag“. So lässt sich einschätzen, wie die im Luftbild
sichtbaren Stufen und Blöcke beim aktuellen Pegel vor Ort aussehen. Links führen zu den offiziellen
Pegeln (NVE, ARSO, SMHI, BAFU, eHYD).

**Stellen im Luftbild ansehen:** Mit ◀ ▶ springt die Karte nacheinander zu allen markierten Stellen
(Hotspots, Schluchten) und zoomt so weit ins Luftbild, dass Blöcke und Stufen erkennbar sind.

Grenzen: GloFAS ist ein Modell; für kleine Flüsse (< ~500 km² Einzugsgebiet) und nahe Mündungen
kann der gewählte Rasterpunkt am falschen Fluss liegen (er wird auf der Karte blau angezeigt).

## Wucht: Gefälle × Abfluss

Gefälle allein unterschätzt wasserreiche Flüsse (Wuchtwasser) und überschätzt wasserarme Bäche.
Deshalb wird je Abschnitt die **Strömungsleistung** Ω = ρ·g·Q·S (W/m) berechnet:

| Ω (W/m) | < 300 | 300–1 000 | 1 000–2 500 | 2 500–6 000 | 6 000–15 000 | > 15 000 |
|---|---|---|---|---|---|---|
| Einstufung | Zahmwasser | WW I | WW II | WW II–III | WW III–IV | WW IV+ |

Kalibriert an Nahe (WW I, ~360 W/m), Soča Srpenica–Trnovo (WW II–III+, ~1 700 W/m) und Markarfljót
oberhalb der Schlucht (WW II–III, ~2 300 W/m bei Mittelwasser, ~5 300 W/m im Sommer). Standard ist
„Gefälle + Wucht“: es gilt die schwierigere der beiden Einstufungen. Der Abfluss ist wählbar:
heute, gemessener Pegel, Mittel (MQ), Sommer-Mittel oder ein eigener Wert (z. B. vom Pegel vor Ort).

## Steilstufen und Wasserfälle

Die 300-m-Glättung des Profils verteilt einen Wasserfall auf mehrere hundert Meter. Steilstufen werden
deshalb im monoton angepassten, aber ungeglätteten Profil gesucht: **≥ 8 m Höhenverlust auf 100 m**
(Marker ▼). Am Markarfljót wird der Abbruch am Schluchtbeginn (Wasserfall, ~20 m) als 44-m-Stufe
erkannt; in tiefen Schluchten liefert das Höhenmodell teils Werte vom Rand, daher „im Luftbild prüfen“.

## Wellen messen

Werkzeug „Wellen messen“: im Luftbild die Kämme einer Wellenfolge anklicken. Für stehende Wellen gilt
λ = 2π·v²/g, also v = √(g·λ/2π): 2 m Abstand ≈ 1,8 m/s, 4 m ≈ 2,5 m/s, 10 m ≈ 4 m/s. Dazu zeigt die
App den Abfluss am Aufnahmetag des Bildes – so wird die Wellengröße mit dem heutigen Wasserstand vergleichbar.

## Wie verlässlich sind die Abflussdaten?

- **Modell GloFAS** (Copernicus, über Open-Meteo): weltweit, täglich seit 1984, ~5-km-Raster. Geprüft an der
  Lahn gegen die Pegel Leun und Gießen (31 Tage): **Verlauf sehr gut (r = 0,94–0,95)**, absolut aber
  **30–35 % zu niedrig**, bei Niedrigwasser bis Faktor 3–4. Die jahreszeitliche Einordnung (niedrig/mittel/hoch)
  ist deshalb verlässlicher als die m³/s-Zahl. Bei kleinen Flüssen kann die Rasterzelle danebenliegen (blauer Punkt).
- **Gemessene Pegel (offizielle, geeichte Messstellen):** Die App sucht Pegel mit Abfluss, die höchstens
  1,5 km von der Flusslinie entfernt sind. Bei mehreren Kandidaten gewinnt der, dessen Verlauf zum Modell
  passt (gleicher Fluss, kein Seitenbach). Gemessene Werte haben überall Vorrang vor dem Modell; das Modell
  wird am Pegel geeicht, wenn der Verlauf passt.

| Anbieter | Land | Schlüssel | aktuell | Tageswerte der Vergangenheit (Aufnahmetag) |
|---|---|---|---|---|
| SMHI | Schweden | – | ✓ | ✓ (Archiv bis gestern) |
| SYKE | Finnland | – | ✓ | ✓ |
| NVE HydAPI | Norwegen | kostenlos, persönlich ([hydapi.nve.no/Users](https://hydapi.nve.no/Users)), in der App eintragen | ✓ | ✓ |
| PEGELONLINE | Deutschland (Bundeswasserstraßen) | – | ✓ | nur 31 Tage |
| BAFU (über api.existenz.ch) | Schweiz | – | ✓ | – |
| ARSO | Slowenien | – | ✓ (mit Hochwasserstufen) | – |
| Hydrographischer Dienst Tirol | Österreich (Tirol) | – | ✓ (über Spiegel, alle 30 min) | – |
| Veðurstofa Íslands | Island | – | keine offene Schnittstelle gefunden – nur Link | – |

**Tirol:** hydro.tirol.gv.at erlaubt keinen direkten Abruf aus dem Browser (kein CORS). Die GitHub Action
`.github/workflows/pegel-tirol.yml` holt die Daten deshalb alle 30 Minuten, kürzt sie auf die Abflusspegel
(`scripts/tirol-mirror.mjs`) und legt sie als `tirol.json` in den Branch `pegeldaten`; die App liest sie von
raw.githubusercontent.com. Kostenlos, weil das Repository öffentlich ist. Einige Pegel (z. B. Inn bei Imst
und Magerbach, unterhalb der Kraftwerksausleitungen) veröffentlichen nur eine Wasserstandsklasse
(„niedrig“, „< MW“ …), keinen Abfluss. Hinweis: GitHub pausiert zeitgesteuerte Actions nach 60 Tagen ohne
Commit im Repository – dann unter *Actions → Pegel Tirol spiegeln* wieder aktivieren.

Beispiel Sanna (Tirol): Pegel Landeck Bruggen an der Ausstiegsstelle, gemessen 4,9 m³/s; das Modell lag
mit 49 m³/s zehnfach zu hoch (die GloFAS-Zelle erfasst den Inn mit).

Beispiel Oulankajoki (Finnland): Pegel direkt an der Strecke, gemessen am Luftbild-Tag 22.07.2016
17 m³/s, heute 21 m³/s – das Modell lag hier bei 1–7 m³/s und damit um ein Vielfaches daneben.
RiverApp, Rivermap & Co. beziehen ihre Werte von denselben Behörden, bieten aber keine offene Schnittstelle.

## Engstellen, Schluchten und verdeckte Klammen

Nach der Gefälleanalyse werden entlang der Strecke drei Arten von Hinweisen gesucht
(abschaltbar unter „Analyse-Parameter“):

| Zeichen | Hinweis | Verfahren |
|---|---|---|
| **E** (orange) | **Engstelle** (optional, standardmäßig aus) | Querprofil alle 25 m (±150 m, 5-m-Schritte) im Sentinel-2-Bild: Breite des zusammenhängenden Wasser-/Kiesbett-Streifens. Engstelle, wenn ≤ 50 % der typischen Breite (±1 km) und mindestens 15 m schmaler. Nur wo das Flussbett typischerweise 30–100 m breit ist: schmalere Flüsse löst der Satellit (10 m) nicht auf, breite Kiesebenen verengen sich natürlich. |
| **S** (violett) | **Schlucht** | Talquerschnitt alle 50 m aus dem Höhenmodell: Talbreite 5 m und 20 m über dem Wasserspiegel und Tiefe (Anstieg innerhalb 250 m, schwächere Seite). Schlucht, wenn das Tal 20 m über Wasser ≤ 90 m breit und ≥ 30 m tief ist (Kartverket 1 m), bzw. ≤ 140 m / ≥ 60 m mit dem groben globalen Modell. |
| **K** (schwarz) | **Mögliche Klamm** | Der Fluss verschwindet im Satellitenbild über ≥ 75 m (Schatten, Bäume, zu schmal), ist davor und danach sichtbar, und die Hänge steigen beidseitig ≥ 25 m an. |

Schlucht- und Klamm-Hinweise, die weniger als 1 km auseinanderliegen, werden zu einer
**Schluchtstrecke** zusammengefasst – helle Felswände sehen im Satellitenbild wie Flussbett aus,
die Einzelhinweise liegen dann oft am Anfang und Ende der eigentlichen Klamm.

**Geprüft an:** Koritnica (Kluže-Schlucht laut Wikipedia/OpenCanyon bei 46,360–46,362° N liegt in
der gemeldeten Strecke), Soča (Trnovo-Schlucht/„Katarakt“ als Schlucht erkannt), Sjoa
(Åsengjuvet: Fluss im Bild verdeckt, mit Kartverket 25–40 m breit 5 m über Wasser → Schlucht-/Klammstrecke).
Die schmale Velika-Korita-Klamm (wenige Meter breit, 15 m tief) ist zu klein für das globale
Höhenmodell und wird nicht erkannt. Ein Slowenien-Laserscan (1 m) würde das ändern.

Im Längsprofil zeigen farbige Bänder die Hinweise; der Mauszeiger zeigt die gemessene Flussbreite.
GPX- und GeoJSON-Export enthalten die Hinweise als Wegpunkte bzw. Linien.

## Schwallstellen: Weißwasser im offenen Orthofoto

Gefälle und Höhenmodell übersehen Stellen, die durch **Verblockung** entstehen (z. B. Schiefes Eck und
Pianser Schwall an der Sanna). Die App sucht deshalb nach der Gefälleanalyse im hochaufgelösten
**offenen Orthofoto** nach Weißwasser und markiert auffällige Stellen mit einem **Wellensymbol** (bewusst ohne Nummer oder Stufe) auf Karte, Profil,
in der Stellen-Tour (◀ ▶) sowie im GPX/GeoJSON-Export. Das ist ein **Indikator**, keine
Schwierigkeitsbewertung: auch Wehre werden markiert (im Luftbild nicht sicher unterscheidbar).

| Schritt | Verfahren |
|---|---|
| Bild | Offen lizenzierte Orthofotos mit Pixelzugriff im Browser (CORS): **Österreich** basemap.at (CC BY 4.0, Stufe 18 ≈ 0,4 m), **Slowenien** GURS DOF 2023 (CC BY 4.0, 0,26 m, Kachelcache EPSG:3794 auf dem ArcGIS-Portal der Finanzverwaltung FURS). Esri, Google, Apple u. a. sind nur zur Anzeige lizenziert und werden **nie** ausgewertet. |
| Streifenbild | Entlang der Flusslinie alle 1 m ein Querschnitt ±30 m in 0,5-m-Schritten. |
| Wasserfläche | je Querzeile der zusammenhängende Lauf aus wasserähnlichen (bläulich/türkis) und Weißwasser-Pixeln nahe der Linie – auch wenn die Linie etwas neben dem Wasser liegt. |
| Weißwasser | in allen Farbkanälen hell (Minimum ≥ helles ruhiges Wasser + 22, mind. 150), kaum gesättigt (≤ 0,14) und **körnig** (Streuung im 3 × 3,5-m-Fenster ≥ 9). Die Textur trennt Weißwasser (Streuung 12–14) von glattem hellem Wasser über Kalkgrund (Soča) oder milchigem Gletscherwasser (Inn) (5–7). |
| Schwallstelle | Weißwasserfläche je Flussmeter (über 30 m geglättet) ≥ **5 m²/m** und ≥ 18 % der Wasserfläche, zusammen ≥ 150 m²; Lücken bis 50 m werden verbunden. „Viel Weißwasser“ ab 8 m²/m. |
| Merkmale | scharfe Kurve (≥ 60° auf ±50 m), Verengung (≤ 70 % der üblichen Breite ±500 m), lokales Gefälle ≥ 30 m/km. Fällt eine Stelle mit einer **Steilstufe** zusammen → rote **Gefahrenstelle** („mögliche Stufe/Wasserfall“). |
| Wasserstand | Esri meldet für denselben Bildflug das Aufnahmedatum (Tirol: Land Tirol 07.09.2023, Slowenien: GURS 21.08.2023). Damit zeigt die App den Abfluss am Aufnahmetag (Pegel, geeichtes Modell) und ob das Bild bei Niedrig-, Mittel- oder Hochwasser entstand. |

**Lernen aus eigenen Markierungen:** „Stellen markieren“ → im Luftbild klicken → „Schwall“ / „kein
Schwall“. „Aus Markierungen lernen“ passt die Schwelle (m²/m) so an, dass die eigenen Markierungen der
Strecke möglichst gut getroffen werden. Alles bleibt im Browser (localStorage); „Markierungen
exportieren/importieren“ sichert es als JSON-Datei (inkl. gelernter Schwelle).

**Hintergrund „Orthofoto AT“:** das basemap.at-Bild (bis 15–30 cm) direkt als Karte – in Österreich
schärfer als das Esri-Luftbild, gut für die Wellenmessung.

### Messung an den Referenzflüssen

`scripts/whitewater-eval.mts` prüft gegen `tests/fixtures/schwallstellen.json` und erzeugt je Fluss ein
„gerade gezogenes“ Kontrollbild. Stand 11/2026 (Standardschwellen):

| Fluss | Bild | Referenzstellen | gefunden | weitere markierte Stellen |
|---|---|---|---|---|
| Sanna, Einmündung – Landeck | basemap.at 07.09.2023 | Schiefes Eck (WW III), Pianser Schwall (WW III–IV+), Wehr Landeck | **3/3** | 1 (km 1,9, sichtbarer Schwall) + Oberlauf an der Straßengalerie (WW II–III, neutral) |
| Soča, Srpenica – Trnovo | GURS 21.08.2023 | keine verorteten Einzelstellen in offenen Quellen | – | 7 (Stichprobe: Weißwasser im Blockwerk vor Trnovo bestätigt) |
| Koritnica, Kluže – Mündung | GURS 21.08.2023 | dto. | – | 3 (unterer Abschnitt, Blockstrecken) |
| Inn, Imster Schlucht | basemap.at 07.09.2023 | Rohrbrückenschwall, Memminger Walze (Lage nicht belegt) | – | 6 |
| Sjoa | – | – | – | keine offene Bildquelle |

Erkenntnisse: Mit reiner Helligkeit wäre helles ruhiges Wasser (Soča über Kalkgrund, milchiger Inn)
massenhaft als Weißwasser erkannt worden – erst die Textur macht das brauchbar. Helle Kalkblöcke am Ufer
sind farblich ähnlich und können noch Fehlalarme erzeugen; Weißwasser im tiefen Schatten wird übersehen.

### Offene Orthofotos weltweit (Recherche 11/2026)

| Region | Quelle | Auswertung erlaubt? |
|---|---|---|
| Österreich, Slowenien | basemap.at, GURS | ✅ eingebaut |
| Island | NÁTT (ehem. LMÍ), Sommer-Mosaik 2025, CC BY 4.0 | ✅ wahrscheinlich – Dienst/CORS noch prüfen |
| Finnland | Maanmittauslaitos Ortokuva, CC BY 4.0 | ✅ mit kostenlosem persönlichen Schlüssel |
| Neuseeland | LINZ Basemaps 7,5–30 cm, CC BY 4.0 | ✅ mit kostenlosem Schlüssel |
| USA | NAIP 0,6–1 m (USGS), gemeinfrei | ✅ (1 m nur für größere Schwälle) |
| Schweden | Lantmäteriet: historische Bilder CC0, aktuelle unklar | ⚠️ |
| Alaska, Kanada | NAIP nur teilweise, „Alaska Vivid“ (lizenziert), Kanada stückweise (OGL) | ⚠️ |
| Norwegen | Norge i bilder (Norge-digitalt-Lizenz) | ❌ nur Anzeige |
| Mongolei, Kasachstan, Kirgistan | keine offenen hochauflösenden Orthofotos | ❌ |

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
| < 3 | flach | meist Zahmwasser, kein Wildwasser |
| 3–8 | mäßig | meist WW I |
| 8–15 | deutlich | meist WW II |
| 15–30 | steil | WW II–III, einzelne Stellen schwerer |
| 30–60 | sehr steil | WW III–IV, Wildbach – Stellen besichtigen |
| > 60 | extrem | WW IV+, Stufen und Fälle – oft umtragen |

Kalibriert nach Rückmeldung aus der Praxis (u. a. Nahe Kirn–Monzingen: WW I, stellenweise II).
Wasserreiche Flüsse mit Blockstufen (z. B. Soča Srpenica–Trnovo) sind bei gleichem Gefälle schwerer;
dort sind Hotspots und Schluchten aussagekräftiger als das mittlere Gefälle.

Die Schwellen stehen in `src/analysis.ts` (`GRADIENT_CLASSES`) und sollen mit eigenen Erfahrungswerten kalibriert werden.

## Datenquellen

| Daten | Quelle | Hinweis |
|---|---|---|
| Höhen Norwegen | [Kartverket, Nasjonal høydemodell DTM](https://www.geonorge.no/) über WCS | Laserscanning, 1 m; CC BY 4.0; in EPSG:3857-Kacheln abgefragt. Bei Störung automatisch globales Modell |
| Höhen weltweit | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium) | SRTM, EU-DEM, nationale DGMs; Auflösung regional 3–90 m |
| Satellitendaten | [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/) (ESA Copernicus) über den STAC-Katalog von Element 84 | Bänder Grün, Rot, NIR; nur das benötigte Fenster wird gelesen (Cloud-Optimized GeoTIFF) |
| Gewässer | OpenStreetMap über Overpass API (3 Server, gestaffelt) | © OSM-Mitwirkende, ODbL |
| Ortssuche | Nominatim | Nutzungsbedingungen beachten (sparsame Nutzung) |
| Satellitenbild | Esri World Imagery | nur Anzeige, keine automatisierte Auswertung (Metadaten liefern das Aufnahmedatum) |
| Orthofoto Österreich | [basemap.at](https://basemap.at) | CC BY 4.0; Anzeige („Orthofoto AT“) und Weißwasser-Suche |
| Orthofoto Slowenien | GURS DOF 2023 (Kachelcache auf gisportal.furs.gov.si) | CC BY 4.0 („Javne informacije Slovenije, Geodetska uprava RS“); Weißwasser-Suche |
| Satellitenbild | Sentinel-2 cloudless 2023 (EOX) | CC BY-NC-SA 4.0 |
| Topo | OpenTopoMap | CC-BY-SA |

## Abgleich Sjoa (Norwegen): Gefälle und Schluchten vs. Literatur

Ganze Sjoa von Ridderspranget bis zur Mündung nachgezogen (38 km, 58 % auf Wasser/Kies), Abschnitte
nach Rafting-Anbietern, globales Höhenmodell (Kartverket war während des Tests nicht erreichbar):

| Abschnitt | Länge | Ø Gefälle | Schlucht-/Klamm-Hinweise | Literatur |
|---|---|---|---|---|
| Ridderspranget – Åsengjuvet-Einstieg | 7,5 km | 17,5 m/km | Steilstellen am Einstieg (48 m/km), Schluchtstrecke km 1,4–2,9 | WW 5 bei Ridderspranget (drei Fälle) |
| Åsengjuvet | 12,8 km | 11,7 m/km | **Schluchtstrecke über 7,2 km** | WW 3–4 (+), 12 km durchgehend |
| Playrun (Heidal) | 13,9 km | 10,6 m/km | eine Strecke von 1,1 km, ein verdeckter Abschnitt | WW 2–3 |
| Åmot – Mündung | 3,7 km | 11,0 m/km | **Schluchtstrecke 1,8 km** | WW 4, bei Hochwasser fast 5 |

**Erkenntnis:** Åsengjuvet (WW 3–4) und Playrun (WW 2–3) haben fast dasselbe Gefälle – unterscheidbar
werden sie erst durch die Schlucht-Erkennung. Die schmale Klamm von Ridderspranget selbst ist für das
globale Modell zu klein; mit dem Kartverket-Modell (1 m) wird sie besser sichtbar.

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
| Koritnica ab Kluže-Schlucht – Mündung | 5,2 km | 16,2 m/km | 69 m/km am Schluchtausgang | WW III/IV |

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
  sentinel.ts      Sentinel-2-Szenensuche (STAC), NDWI/NDVI je Rasterzelle bzw. Punkt
  narrows.ts       Engstellen (Flussbreite), Schluchten (Talquerschnitt), verdeckte Klammen
  flow.ts          Höhenraster laden, Min-Heap, Pixel ↔ Koordinate
  osm.ts           Overpass-Abfragen (gestaffelt, Cache), Verkettung von Flusswegen, Ortssuche
  profileChart.ts  Längsprofil (SVG)
  export.ts        GPX/CSV/GeoJSON
  whitewater.ts    Weißwasser-Suche im offenen Orthofoto, Schwallstellen, Lernen aus Markierungen
  whitewaterStore.ts  eigene Markierungen/Schwelle (localStorage, Export/Import), Kachel-Dekodierung
  presets.ts       Referenzstrecken
  main.ts          Karte und Bedienoberfläche
tests/             Unit-Tests (vitest)
scripts/           Prüfskripte mit echten Daten (soca.mts, whitewater-eval.mts)
```

## Nächste Schritte (Roadmap)

- **Phase 2 – Abfluss & Zeitreihen:** Pegel anbinden (NVE Norwegen, SMHI Schweden, SYKE Finnland,
  ARSO Slowenien, BAFU) sowie GloFAS-Modellabfluss für Gebiete ohne Pegel. Sentinel-2-Szenen mit
  dem Abfluss am Aufnahmetag verknüpfen und per Schieberegler vergleichen.
- **Höhenmodelle Skandinavien:** Lantmäteriet (Schweden) und Maanmittauslaitos (Finnland) analog zu Kartverket.
- **Weißwasser-Suche erweitern:** weitere offene Orthofotos anbinden (Island, Finnland, Neuseeland, USA);
  Kalkblöcke am Ufer besser von Schaum trennen (Farbe relativ zum Wasser, Schattenkanten); Weißwasser im
  Schatten; mit mehr eigenen Markierungen einen kleinen Klassifikator statt einer Schwelle trainieren.
- **Engstellen verfeinern:** OSM-Wasserflächen für exakte Breiten, Laserscan-Modelle für Slowenien,
  Schweiz, Österreich; Strömungsleistung (Gefälle × Abfluss ÷ Breite) mit Abflussdaten.
- **Phase 3 – Eigene Notizen & offline:** Stromschnellen markieren, Schwierigkeit, Fotos, Pegel bei
  der Befahrung, Umtragestellen. Offline-Nutzung als PWA.
- **Phase 4 – Modell:** Schwierigkeitsschätzung aus Gefälle, Abfluss, Talenge und Weißwasser-Anteil,
  trainiert mit eigenen Befahrungsdaten.
