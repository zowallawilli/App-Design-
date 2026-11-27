// Prüfhilfe: Punkte auf die nächste benannte OSM-Flusslinie setzen (OpenFreeMap-Vektorkacheln).
// Aufruf: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx tsx scripts/pruefung-snap.mts '<Flussname-Regex>' lon,lat [lon,lat …]
import { riversInBbox } from "../src/vectorWater";
import { haversine, type LngLat } from "../src/geo";

const [re, ...pts] = process.argv.slice(2);
const rx = new RegExp(re, "i");
for (const s of pts) {
  const p = s.split(",").map(Number) as LngLat;
  const d = 0.03;
  const { rivers } = await riversInBbox([p[0] - d, p[1] - d, p[0] + d, p[1] + d]);
  let best: { q: LngLat; dist: number; name: string } | null = null;
  for (const r of rivers) {
    if (!rx.test(r.name)) continue;
    for (const q of r.coords as LngLat[]) {
      const dist = haversine(p, q);
      if (!best || dist < best.dist) best = { q, dist, name: r.name };
    }
  }
  console.log(s, "→", best ? `${best.q[0].toFixed(5)},${best.q[1].toFixed(5)} (${best.name}, ${best.dist.toFixed(0)} m)` : `kein Fluss /${re}/ gefunden; Namen: ${[...new Set(rivers.map((r) => r.name))].slice(0, 12).join(", ")}`);
}
