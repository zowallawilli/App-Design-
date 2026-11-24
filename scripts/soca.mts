// Prüfskript: Talweg der Soča aus dem Höhenmodell ableiten und Gefälle auswerten.
// Aufruf: npx tsx scripts/soca.mts
import { analyzeRiver } from "../src/analysis";
import { ElevationSampler } from "../src/dem";
import { deriveThalweg } from "../src/flow";
import { PRESETS } from "../src/presets";
import { nodeTileLoader } from "./nodeTileLoader";

for (const pr of PRESETS) {
  const t = Date.now();
  const line = await deriveThalweg(pr.putIn, pr.takeOut, nodeTileLoader);
  const sampler = new ElevationSampler(nodeTileLoader, 13);
  const a = await analyzeRiver(line, (p, cb) => sampler.elevations(p, cb), { segmentLength: 1000 });
  console.log(`\n== ${pr.name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  console.log(`Länge ${(a.length / 1000).toFixed(1)} km, ${a.zStart.toFixed(0)} → ${a.zEnd.toFixed(0)} m, Ø ${a.meanGradient.toFixed(1)} m/km, umgedreht: ${a.reversed}, Talenge ${(a.confinedLength / 1000).toFixed(1)} km`);
  const ws = a.profile.map((p) => p.walls).sort((x, y) => x - y);
  console.log("Hangüberhöhung (m) p10/p50/p90:", [0.1, 0.5, 0.9].map((q) => ws[Math.floor(q * (ws.length - 1))].toFixed(0)).join("/"));
  console.log("Abschnitte (km: m/km):", a.segments.map((s) => `${(s.d0 / 1000).toFixed(0)}:${s.gradient.toFixed(0)}${s.confined ? "*" : ""}`).join(" "));
  console.log("Hotspots:", a.hotspots.map((h) => `km ${(h.d0 / 1000).toFixed(1)}–${(h.d1 / 1000).toFixed(1)} max ${h.maxGradient.toFixed(0)}`).join("; "));
}
