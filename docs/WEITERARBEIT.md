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
  Klamm. Messung: scripts/breakline-eval.mts + tests/fixtures/abbruchkanten.json (3/5, 0 Fehlalarme).
- Keine Hotspot-, ▼- oder K-Marker mehr; Klammen erscheinen als Schlucht (S).
- 3D: Karte drehen (⟲ ⟳, Rundflug, Norden). Lern-Modus für eigene Markierungen mit JSON-Export/-Import.

Offene Aufgaben (bitte in dieser Reihenfolge, vorher kurz Machbarkeit/Aufwand nennen):
1. Salzach Taxenbach–Lend: fehlende Schwälle km 3,2 (Brückenschatten), 3,6 (Blockstrecke), 5,6–6,0
   und das Querband km 4,2–4,4 mit der App-Linie (Sentinel-2) erkennen, ohne mehr Fehlalarme auf
   Sanna/Soča/Koritnica/Inn. Ansatz prüfen: Flusslinie für die Weißwasser-Suche auf die Wassermitte
   zentrieren (Wasserfläche aus dem Orthofoto), Weißwasser im Schatten, Kalkblöcke vs. Schaum.
2. Wellenmessung: Tiefenkorrektur v = √(g·λ/2π · tanh(2πh/λ)) – Spanne je nach Wassertiefe statt
   einer Zahl, Hinweis bei λ > 4 m („bei flachem Wasser eher langsamer“) und „quer zu den Kämmen messen“.
3. Abbruchkanten im Schatten bzw. als Kaskade (Krimmler Wasserfälle) und Selfoss bei versetzter Linie.
4. Weitere offene Orthofotos: Finnland (MML, kostenloser Schlüssel), Neuseeland (LINZ, Schlüssel),
   USA (NAIP) – Schlüssel nur nach meiner Freigabe, nie ins Repo.
5. Markarfljót, sobald das NÁTT-Mosaik dort Bilder hat.

Nach jeder Änderung: npm test, npx tsc --noEmit, npm run e2e (Dev-Server vorher starten, während des
Laufs keine Dateien ändern), Referenzmessungen, Screenshots von Sanna, Soča und Salzach schicken,
PR erstellen und fragen „Soll ich mergen?“; nach dem Merge den Pages-Deploy prüfen.
```
