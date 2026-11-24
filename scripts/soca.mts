// Prüfskript: Soča Na Logu – Kobarid nachziehen, analysieren und je Paddelabschnitt auswerten.
// Aufruf (Netz über Proxy):  NODE_USE_ENV_PROXY=1 npx tsx scripts/soca.mts
import { analyzeRiver } from "../src/analysis";
import { compositeTileLoader, ElevationSampler } from "../src/dem";
import { locateOnLine, type LngLat } from "../src/geo";
import { traceRiver } from "../src/route";
import { sentinelWater } from "../src/sentinel";
import { nodeTileLoader } from "./nodeTileLoader";

// Orte entlang der Soča (Koordinaten auf bzw. nahe dem Fluss, Ortsmitten aus Wikipedia)
const PLACES: [string, LngLat][] = [
  ["Na Logu (Trenta)", [13.7502, 46.3815]],
  ["Soča (Dorf)", [13.6545, 46.3358]],
  ["Čezsoča (Bovec)", [13.5583, 46.3238]],
  ["Žaga", [13.4891, 46.3039]],
  ["Srpenica", [13.5024, 46.2956]],
  ["Trnovo ob Soči", [13.5531, 46.2798]],
  ["Kobarid", [13.5863, 46.2477]],
];

const loader = compositeTileLoader("global", nodeTileLoader);
const t = Date.now();
const route = await traceRiver(PLACES[0][1], PLACES[PLACES.length - 1][1], { loader, water: sentinelWater, onProgress: (m) => process.stderr.write(`${m}\r`) });
const sampler = new ElevationSampler(loader, 14);
const a = await analyzeRiver(route.line, (p, cb) => sampler.elevations(p, cb), { segmentLength: 250 });
console.log(`\nSoča Na Logu – Kobarid: ${(a.length / 1000).toFixed(1)} km, ${a.zStart.toFixed(0)} → ${a.zEnd.toFixed(0)} m, Ø ${a.meanGradient.toFixed(1)} m/km`);
console.log(`Quellen: ${route.sources.join(", ")} · ${Math.round(route.shareWater * 100)} % auf Wasser/Kiesbett · ${((Date.now() - t) / 1000).toFixed(0)} s\n`);

const profileLine = a.profile.map((p) => p.p);
const km = PLACES.map(([name, p]) => ({ name, d: locateOnLine(profileLine, p).d, off: locateOnLine(profileLine, p).offset }));
const zAt = (d: number) => a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).z;
console.log("| Abschnitt | km | Länge | Höhen | Ø m/km | steilste 250 m | Hotspots (max. m/km) |");
console.log("|---|---|---|---|---|---|---|");
for (let i = 0; i < km.length - 1; i++) {
  const { name: n0, d: d0 } = km[i], { name: n1, d: d1 } = km[i + 1];
  const segs = a.segments.filter((s) => s.d0 >= d0 - 1 && s.d1 <= d1 + 1);
  const hs = a.hotspots.filter((h) => h.d0 < d1 && h.d1 > d0);
  const z0 = zAt(d0), z1 = zAt(d1);
  console.log(
    `| ${n0} – ${n1} | ${(d0 / 1000).toFixed(1)}–${(d1 / 1000).toFixed(1)} | ${((d1 - d0) / 1000).toFixed(1)} km | ${z0.toFixed(0)} → ${z1.toFixed(0)} m | ` +
      `${(((z0 - z1) / (d1 - d0)) * 1000).toFixed(1)} | ${Math.max(...segs.map((s) => s.gradient)).toFixed(0)} | ` +
      `${hs.length ? hs.map((h) => `km ${(h.d0 / 1000).toFixed(1)} (${h.maxGradient.toFixed(0)}${h.confined ? ", eng" : ""})`).join(", ") : "–"} |`,
  );
}
console.log("\nAbstand Ortspunkt ↔ Linie:", km.map((k) => `${k.name} ${Math.round(k.off)} m`).join(", "));
