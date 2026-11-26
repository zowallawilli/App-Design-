# Arbeitsauftrag: Pegel, Wasserstand und Hinweise (Stand 25.11.2026, geändert 26.11.2026)

> **Änderung 26.11.2026 (Nutzer):** keine konkreten Wetterdaten mehr – Wetterabfrage eingefroren. Hinweise nur aus
> Jahreszeit, Aufnahmedatum und Abflussregime (Gletscher- oder Schneeschmelze oder Regen, aus Gletschern und Höhe des
> Einzugsgebiets). Einzugsgebiet im Oberlauf auf der Karte markieren. Pegel nur, wenn gemessen und am selben Fluss –
> keine Schätzungen aus Nachbarpegeln mehr anzeigen. Abschnitt 2 (Wetterhinweise) gilt deshalb nicht mehr.

Gesammelte Anforderungen des Nutzers. Gilt zusätzlich zu `CLAUDE.md`.

## Ziel
Für jede Strecke soll erkennbar sein, wie viel Wasser **heute** und **am Aufnahmetag des Luftbilds**
fließt – so, dass sich die Angabe als Referenz nutzen lässt. Falsche oder scheinbar genaue Zahlen sind
gefährlicher als eine fehlende Angabe.

## 1. Nur belastbare Pegelangaben
- Angezeigt werden nur **gemessene Werte offizieller Pegel** (Abfluss m³/s).
- Gibt ein Pegel **keinen Abfluss, aber einen Wasserstand (cm)** heraus, den Wasserstand anzeigen.
- Schätzungen aus Nachbarpegeln (z. B. Inn bei Imst/Magerbach) nur **klar gekennzeichnet** („≈ …,
  geschätzt aus …“).
- Liegen **mehrere Pegel an der Strecke**, alle mit ihren Werten zeigen (Vergleich mit RiverApp &
  Co. muss möglich sein; z. B. Imster Schlucht: Imst und Magerbach).
- Veraltete Werte als veraltet kennzeichnen.
- **Keine Modell-Abflusszahlen** (GloFAS) anzeigen – Abgleich an 223 Pegeln: meist mehrfach daneben.

## 2. Ohne Pegelwert: kurze Hinweise statt Zahl
- **Aufnahmedatum** des Luftbilds gut sichtbar. Eine Uhrzeit ist nicht nötig (Wetter wirkt verzögert).
- Hinweise aus dem Wetter im **Einzugsgebiet oberhalb des Einstiegs** (Fluss + Zubringer flussaufwärts;
  Rückfall: Umkreis ~15 km um den Einstieg), Regen nach Fläche gewertet (verbreitet/örtlich), Zeitfenster
  nach Gebietsgröße, Hinweis bei Speichern/Kraftwerken (zwei Wochen davor): Regen,
  Starkregen auch einige Tage vorher, Trockenheit, Schneefall, Schneeschmelze.
- Übliche **Jahreszeit** der Region.
- Daraus eine **Tendenz** (eher niedrig / unauffällig / eher erhöht / eher hoch), ausdrücklich keine Messung.
- **Texte möglichst kurz**, die Information soll auf einen Blick erkennbar sein.

- **Bildabschnitte eindeutig zuordnen:** Abschnitte B1, B2 … mit Datum und Tendenz auf der Karte, gleiche
  Nummer/Farbe im Panel, Klick verknüpft beides; Kartenkopf zeigt die Tendenz zum Bild.

## 3. Gletscherflüsse
- Flüsse mit Gletschern im Einzugsgebiet (z. B. **Ötztaler Ache**) verhalten sich anders: im Sommer
  hohe Wasserstände durch Schmelzwasser, Tagesgang, an warmen Tagen deutlich mehr Wasser.
- Gletschereinfluss erkennen (z. B. Vergletscherung des Einzugsgebiets laut Pegel-Stammdaten, Gletscher
  im Umkreis) und in den Hinweisen berücksichtigen (Hitze im Gebirge → eher hoch, Kälteeinbruch → eher
  weniger).

## 4. Prüfen
- Pegelabruf und Wetterhinweise auf **Fehler, Risiken und Falschinformationen** prüfen.
- Referenzen: Sanna (Landeck Bruggen stimmt), Imster Schlucht (RiverApp am 25.11.: ~74 m³/s, 190 cm –
  vermutlich Pegel Magerbach), Soča, Sjoa, Ötz (Gletscher).
- Klären, woher **RiverApp** ihre Pegeldaten und die mehrjährige Historie bezieht.

## Vorgaben (unverändert)
Keine Kosten, nur offizielle/dokumentierte Schnittstellen, keine Schlüssel ins Repo oder in die Umgebung,
neue Hosts nur wenn nötig. Ablauf laut `CLAUDE.md` (Tests → Screenshots → PR → mergen).
