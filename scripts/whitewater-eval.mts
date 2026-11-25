// Messung der Schwallstellen-Erkennung an den Referenzflüssen (tests/fixtures/schwallstellen.json).
// NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx tsx scripts/whitewater-eval.mts <out-dir> [fluss-id …]
// Schreibt je Fluss: Linie (Cache), Kontrollbild „strip-<id>.png“ (Fluss gerade gezogen, Weißwasser rot,
// erkannte Stellen als blaue Balken, Referenzen als grüne/graue Balken) und eine Tabelle auf stdout.
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { traceRiver } from "../src/route";
import { compositeTileLoader } from "../src/dem";
import { locateOnLine, type LngLat } from "../src/geo";
import { waterInBbox } from "../src/vectorWater";
import { ACROSS, DEFAULT_PARAMS, describeSpots, findSpots, ORTHO_SOURCES, orthoSourceFor, sampleStrip, whitewaterProfile, type TileDecoder } from "../src/whitewater";
import { nodeTileLoader } from "./nodeTileLoader";

const OUT = process.argv[2] ?? "ww-out";
const only = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });
const fx = JSON.parse(readFileSync(new URL("../tests/fixtures/schwallstellen.json", import.meta.url), "utf8"));
const decode: TileDecoder = async (buf) => {
  const d = jpeg.decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true });
  return { data: d.data, width: d.width, height: d.height };
};
const gm = (p: LngLat) => `https://www.google.com/maps/search/?api=1&query=${p[1].toFixed(5)},${p[0].toFixed(5)}`;

let totalRef = 0, totalHit = 0, totalFalse = 0;
for (const r of fx.rivers) {
  if (only.length && !only.includes(r.id)) continue;
  const lf = `${OUT}/line-${r.id}.json`;
  let line: LngLat[];
  if (existsSync(lf)) line = JSON.parse(readFileSync(lf, "utf8"));
  else {
    line = (await traceRiver(r.putIn, r.takeOut, { loader: compositeTileLoader("global", nodeTileLoader), waterways: waterInBbox })).line;
    writeFileSync(lf, JSON.stringify(line));
  }
  const src = orthoSourceFor(line);
  console.log(`\n== ${r.name}  (${src ? src.name : "keine offene Bildquelle"})`);
  if (!src) continue;
  const t0 = Date.now();
  const strip = await sampleStrip(line, src, decode, { onProgress: (a, b) => process.stderr.write(`Kacheln ${a}/${b}\r`) });
  const prof = whitewaterProfile(strip);
  const spots = describeSpots(findSpots(prof.bins, DEFAULT_PARAMS), strip, prof.bins);
  console.log(`Länge ${(strip.d[strip.rows - 1] / 1000).toFixed(2)} km · Bilddaten ${(prof.coverage * 100).toFixed(0)} % · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // Referenzen auf die Linie legen
  const refs = (r.spots as { name: string; from: LngLat; to: LngLat; tol: number; expect: string }[]).map((s) => {
    const a = locateOnLine(line, s.from).d, b = locateOnLine(line, s.to).d;
    return { ...s, d0: Math.min(a, b) - s.tol, d1: Math.max(a, b) + s.tol, hit: false };
  });
  for (const s of spots) {
    const ref = refs.find((x) => s.d1 >= x.d0 && s.d0 <= x.d1);
    if (ref) ref.hit = true;
    else totalFalse++;
    console.log(
      `${s.strong ? "■" : "□"} km ${(s.d0 / 1000).toFixed(2)}–${(s.d1 / 1000).toFixed(2)}  Dichte ${s.peakDensity.toFixed(1)} m²/m  Anteil ${(s.peakFrac * 100).toFixed(0)} %  Fläche ${s.area.toFixed(0)} m²  Breite ${s.width?.toFixed(0) ?? "–"} m` +
        `  ${s.notes.join("; ")}  → ${ref ? `${ref.expect === "neutral" ? "(neutral) " : "Treffer "}${ref.name}` : "nicht in Referenz"}  ${gm(s.center)}`,
    );
  }
  for (const x of refs.filter((x) => x.expect === "schwall")) {
    totalRef++;
    if (x.hit) totalHit++;
    console.log(`  Referenz ${x.name}: ${x.hit ? "gefunden" : "NICHT gefunden"}`);
  }
  // Kontrollbild: Fluss gerade gezogen, Fließrichtung nach rechts, 1 px = 1 m längs, 0,5 m quer;
  // in Zeilen à 1500 m umgebrochen
  const W = 1500, band = strip.cols + 16, nRows = Math.ceil(strip.rows / W);
  const png = new PNG({ width: W, height: nRows * band });
  png.data.fill(255);
  for (let i = 0; i < strip.rows; i++) {
    const row = Math.floor(i / W), x = i % W;
    for (let c = 0; c < strip.cols; c++) {
      const k = i * strip.cols + c, y = row * band + 8 + (strip.cols - 1 - c);
      const o = (y * W + x) * 4;
      const wet = prof.wet[k], wh = prof.white[k];
      png.data[o] = wh ? 255 : strip.rgb[k * 3] * (wet ? 1 : 0.55);
      png.data[o + 1] = wh ? 0 : strip.rgb[k * 3 + 1] * (wet ? 1 : 0.55);
      png.data[o + 2] = wh ? 0 : strip.rgb[k * 3 + 2] * (wet ? 1 : 0.55);
      png.data[o + 3] = 255;
    }
  }
  const bar = (d0: number, d1: number, y0: number, col: [number, number, number]) => {
    for (let d = Math.max(0, Math.round(d0)); d < Math.min(strip.rows, Math.round(d1)); d++) {
      const row = Math.floor(d / W), x = d % W;
      for (let y = y0; y < y0 + 4; y++) { const o = ((row * band + y) * W + x) * 4; png.data[o] = col[0]; png.data[o + 1] = col[1]; png.data[o + 2] = col[2]; }
    }
  };
  for (const x of refs) bar(x.d0, x.d1, 0, x.expect === "neutral" ? [150, 150, 150] : [0, 170, 0]);
  for (const s of spots) bar(s.d0, s.d1, band - 6, s.strong ? [0, 60, 220] : [120, 170, 255]);
  // km-Marken
  for (let d = 0; d < strip.rows; d += 100) { const row = Math.floor(d / W), x = d % W; for (let y = 4; y < 8; y++) { const o = ((row * band + y) * W + x) * 4; png.data[o] = png.data[o + 1] = png.data[o + 2] = d % 1000 ? 120 : 0; } }
  writeFileSync(`${OUT}/strip-${r.id}.png`, PNG.sync.write(png));
  void ACROSS; void ORTHO_SOURCES;
}
console.log(`\nGESAMT: ${totalHit}/${totalRef} Referenzstellen gefunden, ${totalFalse} Stellen außerhalb der Referenzen`);
