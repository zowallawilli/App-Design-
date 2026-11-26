# Packraft-Planer – Prototyp Phase 1

Webanwendung zur **Gefälleanalyse von Flussabschnitten** für die Packrafting-Tourenplanung.
Ein- und Ausstieg werden auf der Karte gesetzt, der Flusslauf dazwischen wird automatisch aus
Sentinel-2-Satellitendaten, OpenStreetMap und dem Höhenmodell nachgezogen. Die App berechnet das
Längsprofil, das Gefälle je Abschnitt, Schwall- und Gefahrenstellen im Luftbild und Talengen – in Norwegen
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
| **Profil** | Längsprofil mit Gefälleklassen; Hover zeigt die Position auf der Karte, **Klick springt dorthin** (liegt dort eine markierte Stelle, direkt in die Detailansicht). Die Leiste darunter zeigt die Luftbild-Abschnitte B1, B2 … mit Aufnahmedatum und Wasserstand-Tendenz; Klick zoomt zum Abschnitt und öffnet die Hinweise. |
| **Schwall-/Gefahrenstellen** | Weißwasser und Abbruchkanten im offenen Orthofoto (siehe unten); Klick zoomt hin. Das Gefälle zeigen die Abschnittsfarben – eigene Hotspot-Marker gibt es nicht mehr. |
| **Export** | GPX (Track mit Höhen, Ein-/Ausstieg, Gefahren-, Schwallstellen und Schluchten als Wegpunkte mit Höhe und Beschreibung), CSV, GeoJSON. „GPX an Gaia / GPS-App senden“ öffnet am Handy das Teilen-Menü (siehe unten). |
| **Hintergrund** | Esri-Satellitenbild, Sentinel-2 cloudless (EOX), OpenTopoMap, 3D-Gelände. „Schärfer ↗“ öffnet dieselbe Stelle in Google Maps, Google Earth oder Apple Karten. |
| **3D drehen** | In der 3D-Ansicht: ⟲ ⟳ dreht um 45°, „Rundflug“ kreist langsam um die Kartenmitte (Klick in die Karte stoppt), „N“ stellt Norden nach oben. Außerdem rechte Maustaste bzw. Strg + Ziehen, zwei Finger oder Umschalt + Pfeiltasten. |

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

Für jedes Aufnahmedatum zeigt die App **nur gemessene Pegelwerte** (offizielle Messstellen; „≈“ = aus
Nachbarpegeln geschätzt, siehe unten) und, wo kein Pegelwert vorliegt, **Hinweise aus Wetter und Jahreszeit**:

- **Aufnahmedatum und -art:** Esri veröffentlicht nur das Datum, keine Uhrzeit. Satellitenbilder (Vantor/Maxar,
  Airbus) entstehen meist vormittags (~10–12 Uhr Ortszeit); Orthofotos aus Befliegungen bei hohem Sonnenstand,
  das Datum gilt jeweils für den Bildteil.
- **Regen, Schnee, Schneeschmelze im Einzugsgebiet oberhalb des Einstiegs** (`src/catchment.ts`, `src/weather.ts`):
  Der Abfluss an der Strecke ist die Summe dessen, was oberhalb fällt oder schmilzt – Regen im ganzen Gebiet, Schmelze
  in den hohen Lagen; das Wetter direkt an der Strecke zählt am wenigsten. Die App verfolgt deshalb den Fluss vom
  Einstieg flussaufwärts bis zur Quelle (OSM-Flussnamen aus groben Vektorkacheln, bis 80 km Fließstrecke) samt den
  größten Zubringern (auch Zubringer der Zubringer, z. B. Ötz: Gurgler und Venter Ache) und verteilt bis zu 8
  Bezugspunkte darauf (Karte: Gebiet gestrichelt, Punkte ○). Flüsse, die erst am Ausstieg dazukommen (Inn an der
  Sanna), zählen nicht. Ist kein Fluss verfolgbar, gilt der Umkreis von ~15 km um den Einstieg.
  - Regen wird **nach Fläche** gewertet: „verbreitet“ (≥ Hälfte der Punkte) oder „örtlich“ (Gewitter an einzelnen
    Punkten → schwächer gewichtet).
  - **Zeitfenster nach Gebietsgröße** (Pegel-Stammdaten, sonst aus der Flusslänge geschätzt): < 500 km² Regen der
    letzten 3 Tage, Nachwirkung bis 10 Tage; bis 3 000 km² 4/12 Tage; größer 6/13 Tage.
  - **Speicher/Kraftwerke oberhalb** (OSM-Seenamen wie Stausee, Speicher, Lago; erkannte Ausleitungen): Hinweis
    „Wetter wirkt gedämpft, Schwall möglich“.
- **Bildabschnitte:** Leiste unter dem Höhenprofil „B1 · Datum · Tendenz“ (Ausdehnung des Abschnitts) und ein
  kleines Schild auf der Karte; dieselbe Nummer und Farbe im Panel. Klick auf Leiste, Schild oder Panelkarte zoomt
  zum Abschnitt und markiert die Hinweise. Das frühere farbige Band neben der Strecke ist entfernt (zu unruhig neben
  Strecke und Schluchtlinie). Der Kartenkopf zeigt zum Bild in der Kartenmitte zusätzlich die Tendenz.
- **Übliche Jahreszeit** der Region (Alpen, Norden, Island, Mittelgebirge), z. B. Schneeschmelze April–Juni in den
  Alpen, „vårflom“ Mai/Juni in Skandinavien.
- Daraus eine **Tendenz** (eher niedrig / unauffällig / eher erhöht / eher hoch) – ausdrücklich keine Messung.

Mit Pegel-Historie steht zusätzlich „Heute fließt laut Pegel etwa 1,2× so viel wie am Aufnahmetag“.

**Gletscherflüsse:** Ist das Einzugsgebiet vergletschert (Tirol: Anteil laut Pegel-Stammdaten, z. B. Ötztaler Ache
bei Tumpen 9,3 %; sonst ≥ 5 km² Gletscher im Umkreis von 20 km laut OpenStreetMap), gilt Juli/August als
Hochwasserzeit (Juni/September schwächer). Zusätzlich zählt die Temperatur auf ~3000 m (aus dem Wetterraster mit
−0,65 °C/100 m): warm → starke Gletscherschmelze, Kälteeinbruch → Schmelze gebremst; Trockenheit senkt einen
Gletscherfluss im Sommer nicht.

**Wasserstand statt Abfluss:** Gibt ein Pegel keinen Abfluss, aber einen Wasserstand heraus, zeigt die App die cm.
Für Imst und Magerbach veröffentlicht das öffentliche Tiroler Portal weder Abfluss noch cm (nur die Klasse).

**Mehrere Pegel an der Strecke** werden alle mit aktuellem Wert gezeigt (z. B. Imster Schlucht: Imst und Magerbach),
veraltete Werte (> 26 h) rot markiert. Fehlen die Vergleichsdaten zur Flusszuordnung, weist die App darauf hin.

**RiverApp (geprüft 25.11.2026):** RiverApp importiert die Pegeldaten von den Behörden (für Tirol vom
Hydrographischen Dienst) und speichert sie selbst – daher die mehrjährige Historie (Premium-Funktion). Für
Magerbach zeigt RiverApp Abfluss und Wasserstand, die das öffentliche Portal hydro.tirol.gv.at nicht herausgibt;
RiverApp hat dafür offenbar einen eigenen Datenzugang. Eine offene Schnittstelle bietet RiverApp nicht. Abgleich:
RiverApp Magerbach ~74 m³/s / 190 cm, App-Schätzung Magerbach 64–75 m³/s je nach Tageszeit (Schwallbetrieb).
Für mehr Tiroler Messwerte wäre eine Anfrage beim Hydrographischen Dienst Tirol (Open-Data-Freigabe) der Weg.

**Warum keine Modellzahl mehr?** Früher zeigte die App den Abfluss des Copernicus-Modells GloFAS (5-km-Raster).
Abgleich am 25.11.2026: An 223 Pegeln (Tirol, Südtirol, Slowenien) lag das Modell nur bei 13 % innerhalb ±30 %,
bei 44 % mehr als fünffach daneben (kleine Flüsse < 5 m³/s: 63 %). In Zeitreihen über 1–2 Jahre an 25 Pegeln
(französische Alpen, Südtirol, Piteälven, Oulankajoki) traf die m³/s-Zahl an 15 % der Tage ±30 %, „heute X× so
viel wie am Aufnahmetag“ in 49 % der Fälle ±50 %, die Klasse niedrig/mittel/hoch in 44 % exakt; auch ein am Pegel
geeichtes Modell lag an anderen Tagen nur zu 35 % innerhalb ±30 %. Gründe: Die Rasterzelle trifft oft einen
anderen Fluss oder Hang, Kraftwerksausleitungen und Speicher fehlen. Eine solche Zahl würde mehr in die Irre
führen als helfen. GloFAS wird nur noch intern genutzt, um bei mehreren Pegeln den am richtigen Fluss zu wählen.

**Stellen im Luftbild ansehen:** Mit ◀ ▶ springt die Karte nacheinander zu allen markierten Stellen
(Gefahren- und Schwallstellen, Stufen, Schluchten) und zoomt so weit ins Luftbild, dass Blöcke und Stufen erkennbar sind.

Grenzen: GloFAS ist ein Modell; für kleine Flüsse (< ~500 km² Einzugsgebiet) und nahe Mündungen
kann der gewählte Rasterpunkt am falschen Fluss liegen (er wird auf der Karte blau angezeigt).

## Luftbild schärfer ansehen (Recherche 11/2026)

Angezeigt wird Esri World Imagery; ausgewertet werden nur offene Orthofotos (siehe Schwallstellen). Befund am
**Charyn Canyon (KZ)**: Esri hat dort ein 0,34-m-Bild (Vantor, 07.08./09.10.2025), gibt es aber **nur bis
Kachelstufe 17** heraus (~0,9 m je Bildpunkt). Für feinere Stufen lieferte Esri graue Kacheln „Map data not yet
available“ – auch die Stellen-Tour (Zoom 17,5) landete dort im Grau. Auch alle älteren Stände im Esri-Archiv
(Wayback, 199 Stände seit 2014) enden dort bei Stufe 17.

| Möglichkeit | weltweit | Kosten/Schlüssel | Stand |
|---|---|---|---|
| Fehlende Esri-Stufen aus der feinsten vorhandenen Kachel vergrößern (dokumentierter Tilemap-Endpunkt, `src/esriTiles.ts`) | ✓ | – | **eingebaut** – kein Grau mehr, Kartenkopf: „Esri hier nur vergrößert“ |
| Hochauflösende Bildschirme: Luftbild eine Stufe feiner laden (128-px-Kacheln) | ✓ | – | **eingebaut** – schärfer, wo Esri feinere Stufen hat (Alpen, Skandinavien …) |
| Link „Schärfer ↗“: dieselbe Stelle in **Google Maps (Satellit), Google Earth, Apple Karten** | ✓ | – | **eingebaut** – oft feinere Stufen bzw. andere Aufnahmedaten; Google Earth (Desktop) hat zusätzlich historische Bilder |
| Google-Satellitenbild direkt als Ebene | ✓ | Map Tiles API: Schlüssel + Abrechnungskonto | nicht eingebaut (Kosten, Schlüssel); Kacheln ohne API sind laut Nutzungsbedingungen verboten |
| Bing Aerial | ✓ | Bing Maps for Enterprise wird abgekündigt, neue Basis-Schlüssel gibt es nicht mehr | nicht eingebaut |
| Mapbox Satellite | ✓ | persönlicher Token (kostenloses Kontingent) | möglich wie der NVE-Schlüssel (nur im Browser) – meist dieselben Vantor/Maxar-Bilder wie Esri, daher bisher nicht |
| Esri Wayback (älterer Bildstand) | ✓ | – | geprüft: am Charyn kein feinerer Stand; Kachelhost in der Cloud-Testumgebung gesperrt |

Die Auswertung (Weißwasser) bleibt bei offenen Orthofotos: Google, Apple, Bing und Esri dürfen nur angezeigt werden.

## GPX für Gaia GPS und andere GPS-Apps

Der GPX-Export (GPX 1.1) enthält die Strecke als **Track mit Höhen je Punkt** (alle 25 m, geglättetes Profil),
Einstieg/Ausstieg und alle markierten Stellen als **Wegpunkte mit Höhe, Name, Beschreibung und Typ**; die
Track-Beschreibung nennt Länge, Höhenverlust und die steilen Abschnitte (≥ 15 m/km). Gaia GPS liest GPX (Tracks und
Wegpunkte mit Namen/Notizen) und zeigt zum Track ein eigenes Höhenprofil. Nicht übertragbar: die Farben der
Gefälleabschnitte (GPX kennt keine Linienfarben je Abschnitt) – deshalb steht das Gefälle im Text.

**Direkt zu Gaia:** Gaia GPS hat keine öffentliche Schnittstelle zum Hochladen. Der Weg ohne Umweg: Knopf
„GPX an Gaia / GPS-App senden“ (iPhone/iPad/Android, Browser mit Teilen-Funktion) → im Teilen-Menü **Gaia GPS**
wählen. Sonst die GPX-Datei herunterladen und in Gaia über *Import* (App: Dateien → Teilen → Gaia GPS; Web:
gaiagps.com → Import) öffnen. Ebenso für OsmAnd, Locus, Garmin Explore, Komoot (nur Track).

## Wucht: Gefälle × Abfluss

Gefälle allein unterschätzt wasserreiche Flüsse (Wuchtwasser) und überschätzt wasserarme Bäche.
Deshalb wird je Abschnitt die **Strömungsleistung** Ω = ρ·g·Q·S (W/m) berechnet:

| Ω (W/m) | < 300 | 300–1 000 | 1 000–2 500 | 2 500–6 000 | 6 000–15 000 | > 15 000 |
|---|---|---|---|---|---|---|
| Einstufung | Zahmwasser | WW I | WW II | WW II–III | WW III–IV | WW IV+ |

Kalibriert an Nahe (WW I, ~360 W/m), Soča Srpenica–Trnovo (WW II–III+, ~1 700 W/m) und Markarfljót
oberhalb der Schlucht (WW II–III, ~2 300 W/m bei Mittelwasser, ~5 300 W/m im Sommer). Standard ist
„Gefälle + Wucht“: es gilt die schwierigere der beiden Einstufungen. Der Abfluss ist wählbar: heute am Pegel,
am Aufnahmetag (wenn der Pegel Historie hat) oder ein eigener Wert. Ohne Pegel bewertet die App nur nach Gefälle,
bis ein eigener Abfluss eingetragen ist.

## Steilstufen und Wasserfälle

Die 300-m-Glättung des Profils verteilt einen Wasserfall auf mehrere hundert Meter. Steilstufen werden
deshalb im monoton angepassten, aber ungeglätteten Profil gesucht: **≥ 8 m Höhenverlust auf 100 m**
(im Höhenprofil; **Gefahrenstelle** nur, wenn das Luftbild an der Stufe deutliches Weißwasser oder eine Abbruchkante zeigt – siehe unten). Am Markarfljót wird der Abbruch am Schluchtbeginn (Wasserfall, ~20 m) als 44-m-Stufe
erkannt; in tiefen Schluchten liefert das Höhenmodell teils Werte vom Rand, daher „im Luftbild prüfen“.

## Wellen messen

Werkzeug „Wellen messen“: im Luftbild die Kämme einer Wellenfolge anklicken. Für stehende Wellen gilt
λ = 2π·v²/g, also v = √(g·λ/2π): 2 m Abstand ≈ 1,8 m/s, 4 m ≈ 2,5 m/s, 10 m ≈ 4 m/s. Das gilt für tiefes
Wasser; allgemein v = √(g·λ/2π · tanh(2πh/λ)). Weil die Tiefe h im Luftbild unbekannt ist, zeigt die App eine
**Spanne für 0,5–2 m Tiefe** (z. B. 4 m → 2,0–2,5 m/s, 10 m → 2,2–3,6 m/s) und ab λ > 4 m den Hinweis „bei
flachem Wasser eher langsamer“. Die Kämme quer zu ihrer Ausrichtung (in Fließrichtung) anklicken. Dazu zeigt die
App den Abfluss am Aufnahmetag des Bildes – so wird die Wellengröße mit dem heutigen Wasserstand vergleichbar.

## Wie verlässlich sind die Abflussdaten?

- **Gemessene Pegel (offizielle, geeichte Messstellen):** Die App sucht Pegel mit Abfluss, die höchstens
  1,5 km von der Flusslinie entfernt sind. Bei mehreren Kandidaten gewinnt der, dessen Verlauf zum Modell
  passt (gleicher Fluss, kein Seitenbach; das Modell dient nur dieser Auswahl und wird nicht angezeigt).
- **Pegel knapp neben der Strecke:** Liegt keiner innerhalb von 1,5 km, sucht die App bis 5 km oberhalb des
  Einstiegs und unterhalb des Ausstiegs. Je ein Pegel ober- und unterhalb am selben Fluss → Wert nach Lage
  interpoliert („geschätzt aus Pegeln ober- und unterhalb“, z. B. Soča Srpenica–Trnovo zwischen Log Čezsoški und
  Kobarid). Ein einzelner Pegel wird nur genommen, wenn seine Wassermenge zum Modell passt (Faktor 0,2–5).
- **Geschätzt aus Nachbarpegeln (Tirol):** Pegel ohne veröffentlichten Abfluss (Inn bei Imst und Magerbach)
  bekommen einen Schätzwert aus Einzugsgebiet und Flusskilometer der Nachbarpegel (`src/estimate.ts`):
  Hauptfluss-Pegel oberhalb + Zubringer, die dazwischen münden, Rest nach Fläche; Gegenprobe mit dem Pegel
  unterhalb (abzüglich gemessener Zubringer). Ist die Abflussspende oberhalb weniger als halb so groß, liegt
  dort eine Restwasserstrecke (Kraftwerksausleitung) – dann gilt der Wert von unterhalb. In der Tabelle steht
  immer „≈ … geschätzt aus Pegeln oberhalb / Pegel unterhalb“.
  Beispiel Inn bei Imst (25.11.2026): *Landeck Perjen* liegt **unterhalb** der Sanna-Mündung (3 503 km², enthält
  die 727 km² der Sanna) und in der Restwasserstrecke des Kraftwerks Imst – Perjen + Landeck Bruggen würde die
  Sanna doppelt zählen und die ausgeleitete Wassermenge übersehen (~13 m³/s). Geschätzt aus Innsbruck − Ötztaler
  Ache (Tumpen) − Gurglbach (Nassereith), nach Fläche: **~61 m³/s**. Magerbach: ~75 m³/s.

| Anbieter | Land | Schlüssel | aktuell | Tageswerte der Vergangenheit (Aufnahmetag) |
|---|---|---|---|---|
| SMHI | Schweden | – | ✓ | ✓ (Archiv bis gestern) |
| SYKE | Finnland | – | ✓ | ✓ |
| NVE HydAPI | Norwegen | kostenlos, persönlich ([hydapi.nve.no/Users](https://hydapi.nve.no/Users)), in der App eintragen | ✓ | ✓ |
| PEGELONLINE | Deutschland (Bundeswasserstraßen) | – | ✓ | nur 31 Tage |
| BAFU (über api.existenz.ch) | Schweiz | – | ✓ | – |
| ARSO | Slowenien | – | ✓ (mit Hochwasserstufen) | – |
| Hydrographischer Dienst Tirol | Österreich (Tirol) | – | ✓ (über Spiegel, alle 30 min) | eigenes Archiv ab 24.11.2026 (bis 400 Tage) |
| Hub'Eau Hydrométrie | Frankreich | – | ✓ (observations_tr) | ✓ Tagesmittel QmnJ, Jahrzehnte |
| Amt für Hydrologie Südtirol | Italien (Prov. Bozen) | – | ✓ | ✓ 10-min-Werte über Jahre (Tagesmittel daraus) |
| Veðurstofa Íslands | Island | – | keine offene Schnittstelle gefunden – nur Link | – |

**Geprüfte Quellen (Stand 25.11.2026):**

| Quelle | Abdeckung | aktuell / Historie | CORS | Nutzungsbedingungen | Stand in der App |
|---|---|---|---|---|---|
| [Hub'Eau Hydrométrie](https://hubeau.eaufrance.fr/page/api-hydrometrie) (`hubeau.eaufrance.fr`) | Frankreich, ~4 200 Stationen in Betrieb | Echtzeit ~1 Monat, Tagesmittel seit Jahrzehnten; Werte in l/s | ✓ `*` | Licence Ouverte Etalab 2.0, ohne Schlüssel | eingebunden |
| [Open Data Südtirol, Meteo/Hydro-Webservice](https://data.civis.bz.it/de/dataset/misure-meteo-e-idrografiche) (`geoservices.buergernetz.bz.it/services/meteo/v1`) | Südtirol, 27 Abflusspegel | aktuell (`sensors`), 10-min-Zeitreihen über Jahre (`timeseries`) | ✓ `*` | offenes Datenportal der Provinz Bozen; alter Host `daten.buergernetz.bz.it` ist abgeschaltet | eingebunden |
| Hydrographischer Dienst Tirol (`hydro.tirol.gv.at`) | Tirol, 44 Pegel mit aktuellem Q | nur aktueller Stand + Tagesmittel von gestern | ✗ | öffentlich, keine dokumentierte API | Spiegel + Archiv per Action |
| [GKD Bayern](https://www.gkd.bayern.de/) | Bayern | Downloads je Station (CSV/ZIP), CC BY 4.0 | ✗, automatisierte Abrufe werden abgewiesen („Request Rejected“) | keine dokumentierte Schnittstelle | nur Link; Bundeswasserstraßen über PEGELONLINE |
| Vorarlberg (vowis) / Salzburg | Landespegel | nur Webseiten/PDF | – | keine offene Schnittstelle gefunden | – |
| ARPA Piemonte (WebGIS-REST) | Piemont | nur Monats-/Jahresmittel ausgewählter Stationen | ✓ | – | nicht nutzbar für aktuelle Werte |
| Valle d'Aosta (Centro Funzionale) | Aostatal | Bulletins als PDF | – | keine offene Schnittstelle | – |
| Veðurstofa Íslands (`api.vedur.is`) | Island | API nur für Wetter, Gletscher, Beben, Vulkane – **kein Abfluss** | – | – | weiter nur Link |

**Skandinavien geprüft (25.11.2026):** SMHI (Piteälven, z. B. Stenudden, Sikfors) und SYKE (Oulankajoki, Paikka
1426) liefern weiter Daten mit CORS `*`. NVE HydAPI antwortet ohne Schlüssel mit 401 und erlaubt den Header
`X-API-Key` per CORS – mit dem eigenen Schlüssel im Browser funktioniert die Sjoa also; ohne ihn zeigt die App
nur die Hinweise aus Wetter/Jahreszeit und den Hinweis auf den Schlüssel.

**Tirol:** hydro.tirol.gv.at erlaubt keinen direkten Abruf aus dem Browser (kein CORS). Die GitHub Action
`.github/workflows/pegel-tirol.yml` holt die Daten deshalb alle 30 Minuten, kürzt sie auf die Abflusspegel
(`scripts/tirol-mirror.mjs`) und legt sie als `tirol.json` in den Branch `pegeldaten`; die App liest sie von
raw.githubusercontent.com. Kostenlos, weil das Repository öffentlich ist. Seit 24.11.2026 legt die Action
außerdem je Pegel ein **Archiv der Tagesmittel** an (`tirol-archiv/<nummer>.json`): das offizielle Tagesmittel
(Q „Day.Mean“, am Folgetag veröffentlicht) und – für Pegel ohne Tagesmittel wie Landeck Perjen – ein eigenes
Mittel aus den Halbstunden-Abrufen. Gespeichert werden höchstens 400 Tage (~10 kB je Pegel, gesamt < 1 MB);
der Branch wird bei jedem Lauf als einzelner Commit neu geschrieben und wächst nicht. Nach etwa 10 Tagen
liefert das Archiv gemessene Werte am Aufnahmetag neuer Luftbilder. Kann das bestehende Archiv nicht geladen werden, bricht die Action ab, statt es zu überschreiben. Einige Pegel (z. B. Inn bei Imst
und Magerbach, unterhalb der Kraftwerksausleitungen) veröffentlichen nur eine Wasserstandsklasse
(„niedrig“, „< MW“ …), keinen Abfluss. Hinweis: GitHub pausiert zeitgesteuerte Actions nach 60 Tagen ohne
Commit im Repository – dann unter *Actions → Pegel Tirol spiegeln* wieder aktivieren.

Beispiel Sanna (Tirol): Pegel Landeck Bruggen an der Ausstiegsstelle, gemessen 4,9 m³/s; das frühere Modell
lag mit 49 m³/s zehnfach zu hoch (die GloFAS-Zelle erfasst den Inn mit).

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
| **S** (violett) | **Fluss verdeckt** (früher eigenes „K“) – wird als Schlucht gezeigt; ist der Abschnitt zusätzlich steil (≥ 30 m/km oder Stufe), erscheint er als **Gefahrenstelle „nicht einsehbar“** (rote Welle). Gibt es ein offenes Orthofoto, zählt nur der Teil, in dem auch das hochaufgelöste Bild kein Wasser zeigt (Sentinel-2 übersieht schmale Flüsse) | Der Fluss verschwindet im Satellitenbild über ≥ 75 m (Schatten, Bäume, zu schmal), ist davor und danach sichtbar, und die Hänge steigen beidseitig ≥ 25 m an. |

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
| Bild | Offen lizenzierte Orthofotos mit Pixelzugriff im Browser (CORS): **Österreich** basemap.at (CC BY 4.0, Stufe 18 ≈ 0,4 m), **USA** NAIP (gemeinfrei, 0,3–1 m, USGS-ImageServer), **Slowenien** GURS DOF 2023 (CC BY 4.0, 0,26 m, Kachelcache EPSG:3794 auf dem ArcGIS-Portal der Finanzverwaltung FURS), **Island** NÁTT „Grunnkort – Loftmynd“ (CC BY 4.0, ≥ 25 cm, WMS gis.natt.is; deckt 11/2026 erst Teile ab, v. a. den Nordosten). Esri, Google, Apple u. a. sind nur zur Anzeige lizenziert und werden **nie** ausgewertet. |
| Streifenbild | Entlang der Flusslinie alle 1 m ein Querschnitt ±45 m in 0,5-m-Schritten. Ausgewertet werden der volle Streifen (breite Flüsse wie die Salzach, 40–70 m) und der innere Streifen ±30 m (schmale Flüsse); je 10 m zählt das Ergebnis, das die Kriterien besser erfüllt. |
| Wasserfläche | je Querzeile der zusammenhängende Lauf aus wasserähnlichen (bläulich/türkis) und Weißwasser-Pixeln nahe der Linie – auch wenn die Linie etwas neben dem Wasser liegt. |
| Weißwasser | in allen Farbkanälen hell (Minimum ≥ helles ruhiges Wasser + 22, mind. 150), kaum gesättigt (≤ 0,14) und **körnig** (Streuung im 3 × 3,5-m-Fenster ≥ 9). Die Textur trennt Weißwasser (Streuung 12–14) von glattem hellem Wasser über Kalkgrund (Soča) oder milchigem Gletscherwasser (Inn) (5–7). **Dichter Schaum** (Querband/Walze unter Wehr oder Stufe) ist dagegen glatt und sehr hell: Minimum-Kanal ≥ 215, Sättigung ≤ 0,10, ohne Textur-Kriterium – aber nur, wenn in derselben Spalte flussauf- **und** flussabwärts innerhalb von 15 m Wasser liegt (lange helle Kalkkiesbänke grenzen an Land und fallen so heraus). **Zusätzlich relativ** (trübe, helle Flüsse wie die Salzach, deren Schaum kaum heller als das Wasser ist): Sättigung ≥ 0,07 unter und Minimum-Kanal ≥ 20 über dem Median des Wassers daneben – nur bei nicht beschattetem Wasser (Median ≥ 100), sonst wirkt helles Ufer wie Schaum. |
| Schwallstelle | Weißwasserfläche je Flussmeter (über 30 m geglättet) ≥ **5 m²/m** und ≥ 18 % der Wasserfläche, zusammen ≥ 150 m²; Lücken bis 50 m werden verbunden. „Viel Weißwasser“ ab 8 m²/m. |
| Merkmale | scharfe Kurve (≥ 60° auf ±50 m), Verengung (≤ 70 % der üblichen Breite ±500 m), lokales Gefälle ≥ 30 m/km. |
| Wasserstand | Esri meldet für denselben Bildflug das Aufnahmedatum (Tirol: Land Tirol 07.09.2023, Slowenien: GURS 21.08.2023). Damit zeigt die App den Abfluss am Aufnahmetag (Pegel, geeichtes Modell) und ob das Bild bei Niedrig-, Mittel- oder Hochwasser entstand. |

### Gefahrenstellen: mögliche Abbruchkanten (Wasserfall, Stufe, Wehr)

Steilstufen allein aus dem Höhenmodell sind unscharf (Schluchtränder, 30-m-Raster). Eine **Gefahrenstelle**
(rote Welle) vom Typ „mögliche Abbruchkante“ wird deshalb nur markiert, wenn **beides** zutrifft:

1. **Kante im Luftbild:** In der Flussmitte (±8 m) setzt Weißwasser/Gischt entlang des Flusses
   schlagartig ein – Anteil heller, ungesättigter Pixel (Minimum-Kanal ≥ 165) auf den 15 m unterhalb
   ≥ 50 % und mindestens 40 Prozentpunkte höher als auf den 15 m oberhalb. Gischt ist glatt, deshalb hier ohne
   Wasserfarben-Kriterium (Gletscherwasser ist grau) – und umgekehrt muss die helle Fläche auf den 30 m unterhalb
   **glatt** sein (Median der Streuung < 8; Island 2–6): helle, sonnige Kiesbänke sind körnig (Koritnica 9–11)
   und täuschten am Schattenrand sonst eine Kante vor.
2. **Höhenverlust:** Nur an diesen Kandidaten wird das feinere Höhenmodell (Zoomstufe 15, Talboden aus
   Linie ±10 m, monoton fallend) nachgeladen. Gefordert: ≥ 8 m zwischen 80 m oberhalb und 100 m
   unterhalb der Kante, davon ≥ 4,8 m mehr als das örtliche Gefälle (±500 m) erwarten lässt.

„Deutlich“ bei einem Sprung ≥ 60 Prozentpunkte und ≥ 10 m Höhenverlust, sonst „möglich“.

**Regel des Nutzers (11/2026):** Gefahrenstelle nur bei (1) deutlichem Höhenverlust **in Kombination** mit deutlicher
Abbruchkante oder deutlichem Weißwasser im Luftbild – Steilstufe ≥ 8 m/100 m im Höhenmodell plus „viel Weißwasser“
(≥ 8 m²/m) heißt „Stufe mit Weißwasser“ – oder (2) wenn der Fluss wegen starker Verengung im Bild nicht mehr sichtbar
ist (mögliche Klamm, steil). Stufen **nur** im Höhenmodell (Brückenfahrbahnen, Talränder, Kiesbänke) sind keine
Gefahrenstelle mehr. Folge: Ohne offenes Orthofoto (Norwegen, Island außerhalb des NÁTT-Mosaiks, Zentralasien) gibt
es nur noch Gefahrenstellen vom Typ „nicht einsehbar“. Wehre und Stufen unter ~8 m erscheinen
als Schwallstelle: Mit 5 m ließen sich auch kleine Stufen fassen, dann markierten aber helle Kalkkiesbänke
an der Soča (5,5 und 7 m im Höhenmodell) fälschlich Gefahrenstellen – unter 8 m ist das Höhenmodell zu ungenau.

**Training und Messung** (`scripts/breakline-eval.mts`, `tests/fixtures/abbruchkanten.json`), Stand 11/2026:

| Stelle | Bild | erwartet | Ergebnis |
|---|---|---|---|
| Selfoss (Jökulsá á Fjöllum) | NÁTT | Kante | ✅ erkannt (13 m, „möglich“) |
| Dettifoss | NÁTT | Kante | ✅ erkannt (50 m, „deutlich“) |
| Hafragilsfoss | NÁTT | Kante | ✅ erkannt (96 m inkl. Schlucht darunter, „deutlich“) |
| Stromschnellen zwischen Selfoss und Dettifoss (Höhenmodell meldet 35 m) | NÁTT | keine | ✅ keine Kante |
| Krimmler Wasserfälle, obere und untere Stufe | basemap.at | Kante | ❌ nicht erkannt – Kaskaden im tiefen Morgenschatten (Schaum dort bläulich, Minimum-Kanal ~95, Sättigung ~0,3), keine einzelne Kante, Fälle pendeln bis 20 m um die Linie (bleibt als Gefahrenstelle „Stufe im Höhenmodell“). Geprüft 11/2026: „Stufe im Höhenmodell + durchgehend weiß“ und Schaum-im-Schatten-Kriterium – mit zwei Beispielen nicht belastbar, verworfen |
| Sanna: Schiefes Eck, Pianser Schwall, Oberlauf | basemap.at | keine | ✅ keine Kante |
| Soča: Blockwerk vor Trnovo, Kalkkiesbänke | GURS | keine | ✅ keine Kante |
| Koritnica: Kiesbank am Schattenrand (km 1,2) | GURS | keine | ✅ keine Kante (seit 11/2026: körnige Kiesbank ≠ glatte Gischt; vorher Fehlalarm) |

**3/5 Abbruchkanten erkannt, 0/6 Gegenbeispiele fälschlich markiert**, keine weiteren Kanten (Messskript mit OSM-Linie).
In der App (Linie zusätzlich aus Sentinel-2) wird Selfoss nicht markiert: Die Linie liegt dort 36 m neben der
Fallkante im über 100 m breiten Fluss. Breitere Suchbänder fanden Selfoss trotzdem nicht, markierten aber
Kiesbänke an der Soča – deshalb nur die Flussmitte. Markarfljót,
Gullfoss und Goðafoss liegen (noch) außerhalb des NÁTT-Mosaiks; Sjoa/Norwegen hat keine offene Bildquelle.
Der Datensatz ist klein – Schwellen mit weiteren Fällen (eigene Markierungen, neue Mosaik-Gebiete) nachprüfen.

**Empfindlichkeit (Regler 1–9, Standard 5):** Je Stufe ändern sich die Schwellen für Weißwasserdichte und -fläche um
den Faktor 2^¼ (Stufe 1 = doppelt so streng, „nur große Schwälle“; Stufe 9 = halb so streng), der Mindestanteil mit
der Wurzel davon. Zusätzlich passt sich die Schwelle der **Flussbreite** an (Median der erkennbaren Wasserbreite):
Faktor √(Breite/25 m), begrenzt auf 0,8–1,6 – breite Flüsse (Inn, Soča ~45 m) werden strenger bewertet, schmale (Sanna)
milder. Die Schwelle für „viel Weißwasser“, die zusammen mit einer Steilstufe eine Gefahrenstelle ergibt, hängt nur
von der Breite ab, nicht vom Regler. Messung bei Stufe 5 (App-Linie): Treffer unverändert (Sanna 2/3, Salzach 3/6),
weitere Stellen Soča 10 → 8, Koritnica 3 → 2. Stufe 3: Soča 4, Salzach 0/6; Stufe 7: Sanna 3/3, Soča 9, Salzach 11 Stellen.
Der Regler wird im Browser gespeichert; „Aus Markierungen lernen“ passt die Grundschwelle so an, dass bei der
aktuellen Stufe und Breite die eigenen Markierungen getroffen werden.

**Ohne auswertbares Luftbild** (Norwegen, Kasachstan, Island außerhalb des NÁTT-Mosaiks …) markiert die App bewusst
**keine** Stromschnellen, sondern zeigt nur einen deutlichen Hinweis. Liefert die Bildquelle an der Strecke keine
Bilddaten (in < 30 % der Abschnitte Wasser erkennbar, z. B. leere Kacheln außerhalb des Mosaiks), gilt dasselbe.

**Eigene Markierungen und lernendes Modell:** „Stellen markieren“ → im Luftbild klicken → Schnellauswahl:
Grad (WW I–VI, bleibt für die nächste Markierung vorausgewählt) und Art – Schwall: *Stromschnelle, Walze/Loch, Wehr,
Gefahrenstelle*; kein Schwall: *Kiesbank/Blöcke, Brücke/Schatten, ruhiges Wasser, sonstiges*; optional eine Notiz.
Ein Klick auf eine vorhandene Markierung öffnet sie zum Ändern oder Löschen (keine Doppelten). Markierungen bleiben
bei neuen Analysen erhalten und **überstimmen die Erkennung**: „kein Schwall“ blendet eine erkannte Stelle aus, eigene
Schwälle erscheinen auch ohne Erkennung (grün), erkannte Stellen mit eigener Markierung tragen ein ✓, „Gefahrenstelle“
erscheint immer als rote Welle. Beim Markieren speichert die App die Bildmerkmale der Stelle (Weißwasserdichte,
-anteil, Flussbreite, Bildquelle) – so lernt „Aus Markierungen lernen“ ein Modell (logistische Regression) über
**alle** markierten Flüsse, sobald je mindestens 5 Markierungen „Schwall“ und „kein Schwall“ mit Luftbild vorliegen.
Das Modell ersetzt dann die festen Schwellen; der Regler verschiebt die Wahrscheinlichkeitsschwelle (Stufe 5 = 50 %,
1 = 88 %, 9 = 12 %). Die Trefferquote wird ehrlich an zurückgehaltenen Markierungen geprüft (5-fache
Kreuzvalidierung). Alles bleibt im Browser (localStorage); Export/Import als JSON enthält Markierungen und Modell. Eigene
Markierungen sind nur im Modus „Stellen markieren“ als Punkte sichtbar; ältere Markierungen ohne Bildmerkmale bekommen
sie bei jeder Analyse der Strecke automatisch. „Aus Markierungen lernen“ zeigt eine bleibende Rückmeldung, wie viele
Markierungen genutzt wurden (je Art) und wie viele noch Merkmale brauchen.

**Direkt ins Repo hochladen (Repo-Inhaber):** Mit einem persönlichen fein eingeschränkten GitHub-Schlüssel (nur dieses
Repo, „Contents: Read and write“, unter „Analyse-Parameter“ eintragen, bleibt nur im Browser) lädt „Markierungen
exportieren“ die Datei direkt nach `daten/markierungen/markierungen-<Datum>-<Uhrzeit>.json` (GitHub-Contents-API, Commit
auf `main`, löst keinen Pages-Deploy aus). Ohne Schlüssel oder bei Fehler wird wie bisher eine Datei gespeichert.


### Messung an den Referenzflüssen

`scripts/whitewater-eval.mts` prüft gegen `tests/fixtures/schwallstellen.json` und erzeugt je Fluss ein
„gerade gezogenes“ Kontrollbild. Stand 11/2026 (Standardschwellen):

| Fluss | Bild | Referenzstellen | gefunden | weitere markierte Stellen |
|---|---|---|---|---|
| Sanna, Einmündung – Landeck | basemap.at 07.09.2023 | Schiefes Eck (WW III), Pianser Schwall (WW III–IV+), Wehr Landeck | **3/3** (App-Linie 2/3: Schiefes Eck knapp unter der Mindestfläche, 143 statt 150 m²) | 1 (km 1,9, sichtbarer Schwall) + Oberlauf an der Straßengalerie (WW II–III, neutral) |
| Soča, Srpenica – Trnovo | GURS 21.08.2023 | keine verorteten Einzelstellen in offenen Quellen | – | 7 (Stichprobe: Weißwasser im Blockwerk vor Trnovo bestätigt) |
| Koritnica, Kluže – Mündung | GURS 21.08.2023 | dto. | – | 3 (unterer Abschnitt, Blockstrecken) |
| Inn, Imster Schlucht | basemap.at 07.09.2023 | Rohrbrückenschwall, Memminger Walze (Lage nicht belegt) | – | 6 |
| Salzach, Taxenbach – Lend | basemap.at 2025 | 6 im Luftbild sichtbare Schwälle | **3/6** mit OSM- **und** App-Linie (Querband km 4,2–4,4, km 6,8, km 7,6). App-Linie vorher 2/6 – das Querband (glatter, dichter Schaum) kommt jetzt über das Schaum-Kriterium | 1 (km 0,1) + Wehr/Sohlstufe km 3,75 (neutral, im Bild klar sichtbar) – nicht erkannt: km 3,2 (Schatten), 3,6 (Blockstrecke mit wenig Schaum), 5,6–6,0 (schwächer): Dichte 2–5 m²/m bei 10–20 % Anteil, knapp unter den Schwellen |
| Sjoa | – | – | – | keine offene Bildquelle |

Erkenntnisse: Mit reiner Helligkeit wäre helles ruhiges Wasser (Soča über Kalkgrund, milchiger Inn)
massenhaft als Weißwasser erkannt worden – erst die Textur macht das brauchbar. Helle Kalkblöcke am Ufer
sind farblich ähnlich und können noch Fehlalarme erzeugen; Weißwasser im tiefen Schatten wird übersehen.

Geprüft und verworfen (11/2026, Messung mit App-Linie): **Schaum im Schatten** (relativ zum beschatteten Wasser
heller, neutral, körnig) brachte an der Salzach keinen Treffer, aber bis zu 8 neue Stellen an Koritnica/Inn;
**Linie auf die Wassermitte zentrieren** (aus der erkannten Wasserfläche) verschob die Linie in beschattete
Uferbereiche (Schatten wirkt wasserähnlich) – Sanna 1/3 statt 2/3, Inn +3 bis +7 Stellen.

### Offene Orthofotos weltweit (Recherche 11/2026)

| Region | Quelle | Auswertung erlaubt? |
|---|---|---|
| Österreich, Slowenien | basemap.at, GURS | ✅ eingebaut |
| Island | NÁTT (ehem. LMÍ) „Grunnkort – Loftmynd“, CC BY 4.0, WMS mit CORS | ✅ eingebaut (Abdeckung 11/2026 v. a. Nordosten) |
| Finnland | Maanmittauslaitos Ortokuva, CC BY 4.0 | ✅ mit kostenlosem persönlichen Schlüssel (Server antwortet ohne Schlüssel 401, CORS für die App-Adresse freigegeben) – Schlüssel muss der Nutzer selbst beantragen |
| Neuseeland | LINZ Basemaps 7,5–30 cm, CC BY 4.0 | ✅ mit kostenlosem Schlüssel (ohne Schlüssel 400, CORS offen) – Schlüssel muss der Nutzer selbst beantragen |
| USA | NAIP 0,3–1 m (USDA/USGS), gemeinfrei, ImageServer `imagery.nationalmap.gov` mit CORS | ✅ eingebaut 11/2026 (ohne Alaska/Hawaii). Probe Lower New River (WV): 21 Stellen, gehäuft in der Schlucht km 12–21 (große Schwälle), ruhige Strecke ohne Marker. Aufnahmetag nur, wenn Esri denselben NAIP-Flug meldet |
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
5. **Hotspots** (intern, nicht mehr angezeigt): Ein 250-m-Fenster gleitet über die Strecke; Stellen mit
   ≥ 30 m/km und ≥ 10 m Höhenverlust. Für die Anzeige genügen die Gefälle-Farben der Abschnitte.
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
| Wetter (Hinweise ohne Pegel) | [Open-Meteo Historical Weather](https://open-meteo.com/en/docs/historical-weather-api) (ERA5) und Forecast-API für die letzten Tage | frei, ohne Schlüssel, CC BY 4.0; 10 000 Abfragen/Tag je IP |
| Satellitendaten | [Sentinel-2 L2A](https://registry.opendata.aws/sentinel-2-l2a-cogs/) (ESA Copernicus) über den STAC-Katalog von Element 84 | Bänder Grün, Rot, NIR; nur das benötigte Fenster wird gelesen (Cloud-Optimized GeoTIFF) |
| Gewässer | OpenStreetMap über Overpass API (3 Server, gestaffelt) | © OSM-Mitwirkende, ODbL |
| Ortssuche | Nominatim | Nutzungsbedingungen beachten (sparsame Nutzung) |
| Satellitenbild | Esri World Imagery | nur Anzeige, keine automatisierte Auswertung (Metadaten liefern das Aufnahmedatum) |
| Orthofoto Österreich | [basemap.at](https://basemap.at) | CC BY 4.0; Weißwasser-Suche (als Hintergrund entfernt 11/2026 – gilt nur für Österreich) |
| Orthofoto Island | NÁTT „Grunnkort – Loftmynd“ (gis.natt.is, WMS) | CC BY 4.0 („Náttúrufræðistofnun, Grunnkort – Loftmynd“); Weißwasser- und Abbruchkanten-Suche |
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
  ARSO Slowenien, BAFU); ohne Pegel Hinweise aus Wetter und Jahreszeit (kein Modellabfluss). Sentinel-2-Szenen mit
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
