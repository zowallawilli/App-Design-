// Spiegel der Tiroler Pegel (Hydrographischer Dienst Tirol, hydro.tirol.gv.at).
// Die Quelle sendet keinen CORS-Header, der Browser darf sie also nicht direkt abrufen.
// Eine GitHub Action ruft die Daten alle 30 min ab, kürzt sie auf Abfluss-Pegel und legt sie
// als tirol.json in den Branch "pegeldaten"; die App liest sie von raw.githubusercontent.com.
//
// Zusätzlich baut die Action ein Archiv der Tagesmittel auf (tirol-archiv/<station>.json),
// weil hydro.tirol.gv.at keine Tageswerte der Vergangenheit anbietet:
//   - "dm": offizielles Tagesmittel (Q "Day.Mean"); sein Zeitstempel ist der Tagesbeginn
//           (Ortszeit), am 25.11. wird also das Mittel des 24.11. veröffentlicht
//   - "s":  eigenes Mittel aus den abgerufenen 15-min-Werten [Mittel, Anzahl] – für Pegel ohne
//           veröffentlichtes Tagesmittel (z. B. Landeck Perjen)
// Es werden höchstens KEEP_DAYS Tage behalten (~10 kB je Pegel). Der Branch besteht immer aus
// genau einem Commit (Force-Push), wächst also nicht.
//
//   node scripts/tirol-mirror.mjs <eingabe.json> [archivordner] > tirol.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "https://hydro.tirol.gv.at/stationdata/data.json?parameter=Wasserstand";
export const KEEP_DAYS = 400;

/** Datum (YYYY-MM-DD) in Tiroler Ortszeit */
export const viennaDate = (ms) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
const round = (v) => (v === null || v === undefined ? null : Number(v.toPrecision(4)));

export function reduceTirol(raw) {
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  const stations = list
    .filter((s) => s?.values?.Q && Array.isArray(s.latlng))
    .map((s) => {
      const q = s.values.Q;
      const now = typeof q["15m.Cmd.HD"]?.v === "number" ? q["15m.Cmd.HD"] : null;
      const dm = typeof q["Day.Mean"]?.v === "number" ? q["Day.Mean"] : null;
      const w = s.values.W?.Cmd;
      return {
        id: String(s.number),
        name: s.name,
        river: s.WTO_OBJECT ?? null,
        lat: Number(s.latlng[0].toFixed(5)),
        lon: Number(s.latlng[1].toFixed(5)),
        // Einzugsgebiet (km²), Flusskilometer, Pegelhöhe – für Schätzungen aus Nachbarpegeln
        area: typeof s.CATCHMENT_NATURAL_SIZE === "number" ? s.CATCHMENT_NATURAL_SIZE : null,
        km: typeof s.Flusskilometer === "number" ? s.Flusskilometer : null,
        alt: typeof s.altitude === "number" ? s.altitude : null,
        q: now ? now.v : null,
        time: now ? iso(now.dt) : null,
        dayMean: dm ? dm.v : null,
        dayMeanDate: dm ? viennaDate(dm.dt) : null,
        nnq: q["Cmd.Statistik.NNQ"]?.v ?? null,
        nqt: q["Cmd.Statistik.NQT"]?.v ?? null,
        hhq: q["Cmd.Statistik.HHQ"]?.v ?? null,
        level: w?.classification ?? null,
      };
    });
  return { source: SRC, fetched: new Date().toISOString(), stations };
}

/**
 * Archiv eines Pegels um den aktuellen Abruf ergänzen (rein, ohne Dateizugriff).
 * Format: { id, name, last, dm: {Tag: m³/s}, s: {Tag: [Mittel, Anzahl]} }
 */
export function updateArchive(prev, st, today = viennaDate(Date.now())) {
  const a = prev && typeof prev === "object" ? { ...prev, dm: { ...(prev.dm ?? {}) }, s: { ...(prev.s ?? {}) } } : { dm: {}, s: {} };
  a.id = st.id;
  a.name = st.name;
  if (st.dayMean !== null && st.dayMeanDate) a.dm[st.dayMeanDate] = round(st.dayMean);
  // jeden 15-min-Wert nur einmal zählen (die Quelle aktualisiert nicht bei jedem Abruf)
  if (st.q !== null && st.time && st.time !== a.last) {
    const d = viennaDate(Date.parse(st.time));
    const [m, n] = a.s[d] ?? [0, 0];
    a.s[d] = [round((m * n + st.q) / (n + 1)), n + 1];
    a.last = st.time;
  }
  const cutoff = viennaDate(Date.parse(today + "T12:00:00Z") - KEEP_DAYS * 864e5);
  for (const k of ["dm", "s"]) for (const d of Object.keys(a[k])) if (d < cutoff) delete a[k][d];
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  const dir = process.argv[3];
  const raw = input ? JSON.parse(readFileSync(input, "utf8")) : await (await fetch(SRC)).json();
  const out = reduceTirol(raw);
  if (!out.stations.length) throw new Error("keine Pegel mit Abfluss gefunden");
  if (dir) {
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const st of out.stations) {
      if (st.q === null && st.dayMean === null) continue;
      const file = join(dir, `${st.id}.json`);
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      writeFileSync(file, JSON.stringify(updateArchive(prev, st)));
      n++;
    }
    process.stderr.write(`Archiv: ${n} Pegel aktualisiert\n`);
  }
  process.stdout.write(JSON.stringify(out));
}
