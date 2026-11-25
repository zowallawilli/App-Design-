// Spiegel der Tiroler Pegel (Hydrographischer Dienst Tirol, hydro.tirol.gv.at).
// Die Quelle sendet keinen CORS-Header, der Browser darf sie also nicht direkt abrufen.
// Eine GitHub Action ruft die Daten regelmäßig ab, kürzt sie auf Abfluss-Pegel und legt sie
// als tirol.json in den Branch "pegeldaten"; die App liest sie von raw.githubusercontent.com.
//
//   node scripts/tirol-mirror.mjs [eingabe.json] > tirol.json
import { readFileSync } from "node:fs";

const SRC = "https://hydro.tirol.gv.at/stationdata/data.json?parameter=Wasserstand";

export function reduceTirol(raw) {
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  const stations = list
    .filter((s) => s?.values?.Q && Array.isArray(s.latlng))
    .map((s) => {
      const q = s.values.Q;
      const now = q["15m.Cmd.HD"];
      const w = s.values.W?.Cmd;
      return {
        id: String(s.number),
        name: s.name,
        river: s.WTO_OBJECT ?? null,
        lat: Number(s.latlng[0].toFixed(5)),
        lon: Number(s.latlng[1].toFixed(5)),
        q: now ? now.v : null,
        time: now ? iso(now.dt) : null,
        dayMean: q["Day.Mean"]?.v ?? null,
        nnq: q["Cmd.Statistik.NNQ"]?.v ?? null,
        nqt: q["Cmd.Statistik.NQT"]?.v ?? null,
        hhq: q["Cmd.Statistik.HHQ"]?.v ?? null,
        level: w?.classification ?? null,
      };
    });
  return { source: SRC, fetched: new Date().toISOString(), stations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  const raw = input ? JSON.parse(readFileSync(input, "utf8")) : await (await fetch(SRC)).json();
  const out = reduceTirol(raw);
  if (!out.stations.length) throw new Error("keine Pegel mit Abfluss gefunden");
  process.stdout.write(JSON.stringify(out));
}
