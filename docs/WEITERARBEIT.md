# Prompt zur Weiterarbeit (neuer Chat)

```text
Arbeite am Packraft-Planer im Repo zowallawilli/App-Design- weiter. Lies zuerst CLAUDE.md, README.md
und docs/ANFORDERUNGEN-PEGEL.md – dort stehen meine Vorgaben (keine Kosten, nur offene/dokumentierte
Quellen, keine Modell-Abflusszahlen, Indikator statt Bewertung, Koordinaten als Google-Maps-Links,
Arbeitsweise mit Tests, Screenshots, PR und „Soll ich mergen?“).

Stand (11/2026):
- Schwallstellen (blaue Welle, ohne Nummer) aus offenen Orthofotos: basemap.at (AT), GURS DOF 2023 (SI),
  NÁTT (Island, Teilabdeckung). Streifen ±45 m + innerer ±30 m, Textur- und Relativ-Kriterium.
  Messung: scripts/whitewater-eval.mts + tests/fixtures/schwallstellen.json
  (Sanna 3/3, Salzach Taxenbach–Lend 3/6 bzw. in der App 2/6).
- Gefahrenstellen (rote Welle, einziges Gefahrensymbol): Abbruchkante im Bild + Höhenverlust
  (findBreaklines, feines Höhenmodell an Kandidaten), Stufe nur im Höhenmodell, nicht einsehbare steile
  Klamm. Messung: scripts/breakline-eval.mts + tests/fixtures/abbruchkanten.json (3/5, 1 Fehlalarm:
  Koritnica km 1,2 – Schattenrand vor sonniger Kiesbank).
- Keine Hotspot-, ▼- oder K-Marker mehr; Klammen erscheinen als Schlucht (S).
- 3D: Karte drehen (⟲ ⟳, Rundflug, Norden). Lern-Modus für eigene Markierungen mit JSON-Export/-Import.

Erledigt 11/2026: Salzach-Querband per Schaum-Kriterium (App-Linie 2/6 → 3/6, Wehr km 3,75 gefunden);
Wellenmessung mit Tiefenkorrektur (Spanne 0,5–2 m); Koritnica-Kiesbank kein Fehlalarm mehr (Gischt muss glatt
sein). Geprüft und verworfen: Schaum im Schatten, Linie auf Wassermitte zentrieren, Kaskaden-Kriterium (README).

Offene Aufgaben (bitte in dieser Reihenfolge, vorher kurz Machbarkeit/Aufwand nennen):
1. Salzach: schwache Schwälle km 3,2 / 3,6 / 5,6–6,0 (Dichte 2–5 m²/m, Anteil 10–20 %) – bräuchte z. B. eine
   eigene Schwelle je Flusstyp oder gelernte Schwelle aus Nutzer-Markierungen; Wehr km 3,75 vom Nutzer bestätigen.
2. Abbruchkanten: Krimmler Wasserfälle (Kaskade im Schatten), Selfoss bei versetzter App-Linie – braucht mehr
   Beispiele (weitere Wasserfälle im NÁTT-Mosaik/basemap.at als Fixture).
3. Weitere offene Orthofotos: Finnland (MML, kostenloser Schlüssel), Neuseeland (LINZ, Schlüssel),
   USA (NAIP, ohne Schlüssel – Hosts imagery.nationalmap.gov in der Cloud-Umgebung noch gesperrt) –
   Schlüssel nur nach meiner Freigabe, nie ins Repo.
4. Markarfljót, sobald das NÁTT-Mosaik dort Bilder hat.

Nach jeder Änderung: npm test, npx tsc --noEmit, npm run e2e (Dev-Server vorher starten, während des
Laufs keine Dateien ändern), Referenzmessungen, Screenshots von Sanna, Soča und Salzach schicken,
PR erstellen und fragen „Soll ich mergen?“; nach dem Merge den Pages-Deploy prüfen.
```
