# Prüfauftrag: Funktionstest, Fehler, Risiken, Optimierungen (neuer Chat)

Diesen Text als erste Nachricht in einem neuen Claude-Code-Chat (Cloud-Umgebung „Packraft-Planer“) einfügen.

```text
Prüfe den aktuellen Stand des Packraft-Planers (Repo zowallawilli/App-Design-, Live: https://zowallawilli.github.io/App-Design-/)
gründlich auf Funktionsfehler, Risiken und Optimierungsmöglichkeiten. Lies zuerst CLAUDE.md, README.md,
docs/ANFORDERUNGEN-PEGEL.md und docs/WEITERARBEIT.md – dort stehen meine festen Vorgaben (keine Kosten, nur
offene/dokumentierte Schnittstellen, keine Modell-Abflusszahlen, Gefälle nur als Indikator, Schlüssel nie ins Repo,
Koordinaten als Google-Maps-Links, Texte auf Deutsch).

ZIEL: ein Prüfbericht mit belegten Fehlern (Screenshots), konkreten Handlungsanweisungen und Tipps zur
Weiterarbeit. In diesem Chat NICHTS am App-Code ändern – nur testen, messen, dokumentieren. Ausnahme: kleine
Test-Hilfsskripte unter tests/e2e/ bzw. scripts/ sind erlaubt.

VORBEREITUNG
- npm install, npm test, npx tsc --noEmit, npm run build (Warnungen/Bundle-Größe notieren).
- Dev-Server: npx vite --port 5173 &, dann npm run e2e (bestehender Browser-Test, ~60 Prüfungen) – Ergebnis notieren.
- Eigene Prüfskripte mit Playwright (require('playwright'), Proxy wie in tests/e2e/e2e.cjs). Screenshots nach
  tests/e2e/out/pruefung/<nr>-<kurzname>.png, deviceScaleFactor 2, sprechende Namen. Konsolenfehler, fehlgeschlagene
  Netzanfragen (Host, Status) und Dauer jeder Analyse protokollieren.

1. GRUNDFUNKTIONEN (jede einzeln, Desktop 1440×900 UND Handy 390×844)
   a) Ortssuche, Referenzstrecken laden (alle Einträge im Auswahlfeld durchgehen), Fluss aus OSM, Ein-/Ausstieg,
      Zeichnen, Abbrechen, Zurücksetzen, Esc, doppeltes Laden.
   b) Ergebnisseite: Kennzahlen (Länge, Höhe, Höhenverlust, Ø Gefälle, steilster Abschnitt – Klick springt hin),
      Bewertung Gefälle/Wucht/kombiniert, Abfluss-Auswahl (heute / Aufnahmetag / eigener Wert), eingeklappte Bereiche
      (Berechnungsgrundlage, Pegel & Quellen, „Einzugsgebiet zeigen“, Bildquelle, „Wie erkannt?“, Markierungen).
   c) Höhenprofil: Hover, Klick → Karte springt, Leiste Bildabschnitte B1… (Klick, Tooltip), Größenänderung.
   d) Stellen-Tour ◀ ▶, Gefahren-, Schwall-, Schluchtliste (Klick zoomt), Empfindlichkeits-Regler, Stellen markieren,
      Lernen, Markierungen exportieren/importieren/löschen.
   e) Karte: Luftbild/Sentinel-2/Topo, 3D + Drehen/Rundflug, Kartenkopf (Bilddatum, Tendenz, „Esri hier nur
      vergrößert“), Links „Schärfer ↗“ (Google Maps/Earth/Apple – zeigen sie wirklich dieselbe Stelle?), keine grauen
      „Map data not yet available“-Kacheln beim Hineinzoomen bis Stufe 19.
   f) Wellen messen.
   g) Export: GPX (alle drei Optionen einzeln und kombiniert), CSV, GeoJSON, „Teilen …“ (Fallback-Download).
      GPX gegen das GPX-1.1-Schema prüfen (xmllint, falls verfügbar), Wegpunkt-/Tracknamen, Höhen, Sonderzeichen
      im Flussnamen (z. B. „Şarın“, „Soča“, „&“).
   h) Analyse-Parameter: Abschnittslänge, Höhenmodell, Auflösung, Talenge, Schluchten, Engstellen, Weißwasser,
      NVE-Schlüssel-Feld (nur Verhalten ohne Schlüssel prüfen), GitHub-Schlüssel-Feld (nur Anzeige, nichts hochladen).

2. REFERENZSTRECKEN (Ergebnisse gegen CLAUDE.md/README abgleichen, Abweichungen mit Zahlen belegen)
   Soča Srpenica–Trnovo, Koritnica, Sjoa (Norwegen, Kartverket), Nahe Kirn–Monzingen (Linie nicht auf Straße/Bahn?),
   Sanna Einstieg [10.4910, 47.1176] → Landeck [10.5630, 47.1436] (Pegel Landeck Bruggen, Schiefes Eck, Pianser
   Schwall, Wehr Landeck), Inn Imster Schlucht [10.7450, 47.2164] → [10.8976, 47.2642], Salzach Taxenbach–Lend
   [12.9640, 47.2925] → [13.0480, 47.2990], Ötztaler Ache [10.9111, 47.1610] → [10.8930, 47.2050] (Gletscher),
   Charyn/Şarın Kasachstan [79.1009, 43.3599] → [79.1631, 43.4215] (ohne Orthofoto, Esri nur bis Stufe 17),
   Island Jökulsá á Fjöllum (Dettifoss), Oulankajoki (SYKE), Piteälven (SMHI), eine Strecke in Frankreich (Hub'Eau)
   und in den USA (NAIP). Je Strecke: Dauer, Status-/Fehlermeldungen, Pegel gefunden?, Schwall-/Gefahrenstellen
   plausibel?, Screenshot Karte + Ergebnisseite.

3. FEHLERFÄLLE UND GRENZEN
   - Netz weg / einzelne Quellen blockiert (Playwright route.abort für Overpass, OpenFreeMap, Sentinel-STAC,
     Open-Meteo, Pegel-Anbieter, Esri-Metadaten, Terrarium): bleibt die App bedienbar, sind die Meldungen verständlich?
   - Sehr kurze (< 300 m) und sehr lange Strecken (> 40 km), Strecke über Kachel-/Landesgrenzen, Ein-/Ausstieg
     vertauscht, Klick neben den Fluss, See statt Fluss, Meer.
   - Schnelles Mehrfachklicken, Abbrechen mitten in jeder Phase, Fenstergröße ändern während der Analyse.
   - Speicher: localStorage gesperrt (privates Fenster) – App muss trotzdem funktionieren.
   - Open-Meteo-Tageslimit (10 000/Tag): Wie viele Anfragen erzeugt eine Analyse?

4. RISIKEN UND VORGABEN
   - Erscheint irgendwo eine Modell-Abflusszahl (GloFAS)? Werden Schätzungen klar als „≈ … geschätzt“ markiert?
   - Wirkt ein Text wie eine Schwierigkeitsbewertung statt Indikator? Fehlalarme/Lücken bei Gefahrenstellen?
   - Lizenzen/Nutzungsbedingungen: werden Esri/Google/Apple nur angezeigt, nie ausgewertet? Attributionen vollständig?
   - Schlüssel: liegen NVE-/GitHub-Schlüssel nur im localStorage, tauchen sie in Logs, URLs oder Exporten auf?
   - Sicherheit: HTML-Injektion über Fluss-/Pegelnamen aus OSM bzw. Pegel-APIs (innerHTML-Stellen in src/main.ts
     durchsehen), externe Links mit rel="noopener".
   - Abhängigkeiten: npm audit, veraltete Pakete; GitHub Actions (Deploy, Tirol-Spiegel) laufen?

5. OPTIMIERUNGEN
   - Ladezeit: Lighthouse (Chromium unter /opt/pw-browsers/chromium, headless) für Desktop und Handy – Performance,
     Barrierefreiheit, Best Practices; Bundle-Größe; Dauer der einzelnen Analyse-Phasen; doppelte Netzabrufe; Caching.
   - Bedienung: Wo stockt der Ablauf, wo ist Text zu lang/unklar, was ist am Handy schwer zu treffen
     (Mindestgröße 44 px), Kontraste, Tastaturbedienung, Fokus-Reihenfolge, Ladeanzeigen.
   - Code: tote Funktionen, sehr lange Funktionen in src/main.ts, fehlende Tests für zentrale Rechenwege.

BERICHT (docs/PRUEFBERICHT-<JJJJ-MM-TT>.md, auf Deutsch)
- Je Befund: Nr., Schwere (kritisch / hoch / mittel / gering), Bereich, Beobachtung, Schritte zum Nachstellen,
  erwartet vs. tatsächlich, Beleg (Screenshot-Pfad, Konsolen-/Netzausschnitt), Ursache (Datei:Zeile, falls gefunden),
  konkrete Handlungsanweisung (was genau ändern), geschätzter Aufwand (S/M/L).
- Getrennte Abschnitte: Fehler · Risiken · Optimierungen · Was gut funktioniert · Tipps zur Weiterarbeit
  (Reihenfolge, Abhängigkeiten, welche Tests ergänzt werden sollten).
- Koordinaten als Google-Maps-Links, z. B. [47.1176, 10.4910](https://www.google.com/maps/search/?api=1&query=47.1176,10.4910).
- AM ENDE: „Das Wichtigste nach der 80/20-Regel“ – höchstens 10 Punkte: die ~20 % der Maßnahmen, die ~80 % der
  Wirkung bringen (je ein Satz: Problem → Maßnahme → Nutzen), sortiert nach Wirkung pro Aufwand.

ABSCHLUSS
- Bericht und Screenshots committen und auf den Entwicklungsbranch pushen, PR gegen main öffnen, mir die
  wichtigsten Screenshots direkt schicken und die 80/20-Zusammenfassung im Chat wiederholen. Nicht mergen, bevor ich
  zustimme („Soll ich mergen?“).
- Kontingent schonen: Analysen bündeln, lange Läufe nur einmal, Zwischenstände kurz melden.
```
