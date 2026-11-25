// Messung der Abbruchkanten-Erkennung (Gefahrenstellen) gegen tests/fixtures/abbruchkanten.json.
// NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx tsx scripts/breakline-eval.mts <out-dir> [fluss-id …]
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeRiver, monotoneDecreasing } from "../src/analysis";
import { traceRiver } from "../src/route";
import { compositeTileLoader, ElevationSampler } from "../src/dem";
import { locateOnLine, type LngLat } from "../src/geo";
import { waterInBbox } from "../src/vectorWater";
import { edgeCandidates, findBreaklines, localProfile, orthoSourceFor, sampleStrip, type TileDecoder } from "../src/whitewater";
// DEMZ = Zoomstufe des Höhenmodells (Standard 13 wie in der App)
import { nodeTileLoader } from "./nodeTileLoader";
import { sentinelWater } from "../src/sentinel";

const OUT = process.argv[2] ?? "bl-out";
const only = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });
const fx = JSON.parse(readFileSync(new URL("../tests/fixtures/abbruchkanten.json", import.meta.url), "utf8"));
const decode: TileDecoder = async (buf) => {
  const u = new Uint8Array(buf);
  if (u[0] === 0x89 && u[1] === 0x50) { const p = PNG.sync.read(Buffer.from(u)); return { data: p.data, width: p.width, height: p.height }; }
  const d = jpeg.decode(u, { useTArray: true, formatAsRGBA: true });
  return { data: d.data, width: d.width, height: d.height };
};
const gm = (p: LngLat) => `https://www.google.com/maps/search/?api=1&query=${p[1].toFixed(5)},${p[0].toFixed(5)}`;
const loader = compositeTileLoader("global", nodeTileLoader);
let pos = 0, hit = 0, neg = 0, negHit = 0, extra = 0;
for (const r of fx.rivers) {
  if (only.length && !only.includes(r.id)) continue;
  const lf = `${OUT}/line-${r.id}${process.env.S2 ? "-s2" : ""}.json`; // S2=1: Linie wie in der App (mit Sentinel-2)
  let line: LngLat[];
  if (existsSync(lf)) line = JSON.parse(readFileSync(lf, "utf8"));
  else { line = (await traceRiver(r.putIn, r.takeOut, { loader, waterways: waterInBbox, ...(process.env.S2 ? { water: sentinelWater } : {}) })).line; writeFileSync(lf, JSON.stringify(line)); }
  const a = await analyzeRiver(line, (p, cb) => new ElevationSampler(loader, Number(process.env.DEMZ ?? 13)).elevations(p, cb), { segmentLength: 250 });
  const pl = a.profile.map((p) => p.p);
  const zm = monotoneDecreasing(a.profile.map((p) => p.floor));
  const zAt = (d: number) => { let b = 0; for (let i = 0; i < a.profile.length; i++) if (Math.abs(a.profile[i].d - d) < Math.abs(a.profile[b].d - d)) b = i; return zm[b]; };
  const src = orthoSourceFor(pl);
  console.log(`\n== ${r.name} (${src?.name ?? "keine Bildquelle"}) · Steilstufen im Höhenmodell: ${a.steps.map((s) => `km ${(s.d0 / 1000).toFixed(2)} ${s.drop.toFixed(0)} m`).join(", ") || "–"}`);
  if (!src) continue;
  const strip = await sampleStrip(pl, src, decode);
  const cands = edgeCandidates(strip);
  const fine = new ElevationSampler(loader, 15);
  const zf = new Map<number, (d: number) => number>();
  for (const c of cands) zf.set(c.i, await localProfile(strip, c, (pts) => fine.elevations(pts)));
  const bl = findBreaklines(strip, zAt, undefined, cands, (c, d) => zf.get(c.i)!(d));
  const refs = (r.spots as { name: string; from: LngLat; to: LngLat; tol: number; expect: string }[]).map((s) => {
    const x = locateOnLine(pl, s.from).d, y = locateOnLine(pl, s.to).d;
    return { ...s, d0: Math.min(x, y) - s.tol, d1: Math.max(x, y) + s.tol, hit: false };
  });
  for (const b of bl) {
    const ref = refs.find((x) => b.d >= x.d0 && b.d <= x.d1);
    if (ref) ref.hit = true; else extra++;
    console.log(`▲ km ${(b.d / 1000).toFixed(2)} · Kante ${Math.round(b.above * 100)} % → ${Math.round(b.below * 100)} % Weiß · Höhenverlust ${b.drop.toFixed(1)} m (davon ${b.excess.toFixed(1)} m über dem örtlichen Gefälle) · ${b.confidence} → ${ref ? `${ref.expect === "kante" ? "Treffer" : ref.expect === "keine" ? "FEHLALARM" : "(neutral)"} ${ref.name}` : "nicht in Referenz"} ${gm(b.center)}`);
  }
  for (const x of refs) {
    if (x.expect === "kante") { pos++; if (x.hit) hit++; console.log(`  Referenz ${x.name}: ${x.hit ? "erkannt" : "NICHT erkannt"}`); }
    if (x.expect === "keine") { neg++; if (x.hit) negHit++; console.log(`  Gegenbeispiel ${x.name}: ${x.hit ? "FÄLSCHLICH als Kante" : "richtig keine Kante"}`); }
  }
}
console.log(`\nGESAMT: ${hit}/${pos} Abbruchkanten erkannt · ${negHit}/${neg} Gegenbeispiele fälschlich markiert · ${extra} weitere Kanten außerhalb der Referenzen`);
