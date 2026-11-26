// Reichere Bildmerkmale an den hochgeladenen Markierungen (daten/markierungen/) – offline, zum Prüfen von Lern-Ansätzen.
// NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx tsx scripts/markierungen-features.mts <cache-dir> daten/markierungen/<datei>.json > features.json
// Flussabschnitte unten anpassen, wenn Markierungen an neuen Flüssen dazukommen. Auswertung: python3 scripts/markierungen-cv.py features.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const R = process.cwd();
const jpeg = (await import(R + "/node_modules/jpeg-js/index.js")).default; const { PNG } = await import(R + "/node_modules/pngjs/lib/png.js");
const { traceRiver } = await import(R + "/src/route.ts");
const { compositeTileLoader } = await import(R + "/src/dem.ts");
const { locateOnLine } = await import(R + "/src/geo.ts");
const { waterInBbox } = await import(R + "/src/vectorWater.ts");
const { sentinelWater } = await import(R + "/src/sentinel.ts");
const W = await import(R + "/src/whitewater.ts");
const { nodeTileLoader } = await import(R + "/scripts/nodeTileLoader.ts");
const [C, F] = process.argv.slice(2);
const decode = async (buf: ArrayBuffer) => { const u = new Uint8Array(buf);
  if (u[0] === 0x89) { const p = PNG.sync.read(Buffer.from(u)); return { data: p.data, width: p.width, height: p.height }; }
  const d = jpeg.decode(u, { useTArray: true, formatAsRGBA: true }); return { data: d.data, width: d.width, height: d.height }; };
const labels = JSON.parse(readFileSync(F, "utf8")).labels.filter((l: { kind?: string }) => !["holz", "umtragen", "zugang", "lager", "notiz"].includes(l.kind ?? "")); // Planungs-Stellen zählen nicht
const rivers = [
  { id: "soca", putIn: [13.61913, 46.33766], takeOut: [13.48598, 46.31161] },
  { id: "soca2", putIn: [13.48598, 46.31161], takeOut: [13.58657, 46.24755] },
  { id: "inn", putIn: [10.71739, 47.21592], takeOut: [10.86228, 47.25129] },
];
const out: any[] = [];
for (const r of rivers) {
  const lf = `${C}/line-${r.id}.json`;
  let line;
  if (existsSync(lf)) line = JSON.parse(readFileSync(lf, "utf8"));
  else { line = (await traceRiver(r.putIn, r.takeOut, { loader: compositeTileLoader("global", nodeTileLoader), waterways: waterInBbox, water: sentinelWater })).line; writeFileSync(lf, JSON.stringify(line)); }
  const src = W.orthoSourceFor(line);
  const sf = `${C}/strip-${r.id}.bin`; let strip;
  if (existsSync(sf)) { const j = JSON.parse(readFileSync(sf + ".json", "utf8")); const b = readFileSync(sf); const n = j.rows * j.cols;
    strip = { rows: j.rows, cols: j.cols, rgb: new Uint8Array(b.buffer, b.byteOffset, n * 3), valid: new Uint8Array(b.buffer, b.byteOffset + n * 3, n), d: Float64Array.from(j.d), p: j.p }; }
  else { strip = await W.sampleStrip(line, src, decode, { onProgress: (a: number, b: number) => process.stderr.write(`${r.id} ${a}/${b}\r`) }); writeFileSync(sf, Buffer.concat([Buffer.from(strip.rgb), Buffer.from(strip.valid)])); writeFileSync(sf + ".json", JSON.stringify({ rows: strip.rows, cols: strip.cols, d: [...strip.d], p: strip.p })); }
  const prof = W.whitewaterProfile(strip);
  const { rows, cols, rgb, valid } = strip, { wet, white } = prof;
  const V = (k: number) => Math.min(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]);
  const SAT = (k: number) => { const mx = Math.max(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]); return mx ? (mx - V(k)) / mx : 0; };
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : NaN);
  const std = (i: number, c: number) => { let s = 0, q = 0, n = 0; for (let di = -1; di <= 1; di++) for (let dc = -3; dc <= 3; dc++) { const ii = i + di, cc = c + dc; if (ii < 0 || ii >= rows || cc < 0 || cc >= cols) continue; const k = ii * cols + cc; if (!valid[k]) continue; const v = V(k); s += v; q += v * v; n++; } return n > 4 ? Math.sqrt(Math.max(0, q / n - (s / n) ** 2)) : 0; };
  let n = 0;
  for (const l of labels) {
    const at = locateOnLine(line, l.p);
    if (at.offset > 60) continue;
    n++;
    const i0 = Math.max(0, Math.round(at.d - 30)), i1 = Math.min(rows - 1, Math.round(at.d + 30));
    const tex: number[] = [], wv: number[] = [], ws: number[] = [], waterV: number[] = [], wtex: number[] = [], warm: number[] = [];
    let wN = 0, wetN = 0, edge = 0, bandRows = 0, rowsW = 0, longest = 0, run = 0;
    for (let i = i0; i <= i1; i++) {
      let rw = 0, rwet = 0;
      for (let c = 0; c < cols; c++) {
        const k = i * cols + c;
        if (!wet[k]) continue;
        rwet++; wetN++;
        if (white[k]) {
          rw++; wN++;
          if ((i & 1) === 0 && (c & 1) === 0) { tex.push(std(i, c)); wv.push(V(k)); ws.push(SAT(k)); warm.push(rgb[k * 3] - rgb[k * 3 + 2]); }
          let nearLand = false;
          for (let dc = -4; dc <= 4 && !nearLand; dc++) { const cc = c + dc; if (cc < 0 || cc >= cols) continue; const kk = i * cols + cc; if (valid[kk] && !wet[kk]) nearLand = true; }
          if (nearLand) edge++;
        } else if ((i & 1) === 0 && (c & 1) === 0) { waterV.push(V(k)); wtex.push(std(i, c) / Math.max(20, V(k)) * 100); }
      }
      if (rwet > 10) { rowsW++; if (rw / rwet >= 0.25) bandRows++; }
      if (rw > 4) { run++; longest = Math.max(longest, run); } else run = 0;
    }
    const bf = W.binFeat(prof.bins, at.d);
    const wmed = med(waterV);
    out.push({
      river: r.id, schwall: l.schwall, kind: l.kind ?? null, d: Math.round(at.d), off: Math.round(at.offset),
      density: bf?.density ?? 0, smooth: bf?.smooth ?? 0, width: bf?.width ?? null,
      whiteFrac: wetN ? wN / wetN : 0, tex: med(tex), contrast: med(wv) - wmed, whiteSat: med(ws), waterV: wmed,
      waterTex: med(wtex), whiteWarm: med(warm), edgeFrac: wN ? edge / wN : 0, bandFrac: rowsW ? bandRows / rowsW : 0, longest, whiteArea: wN * W.ALONG * W.ACROSS,
    });
  }
  process.stderr.write(`\n${r.id}: ${n} Markierungen auf der Linie\n`);
}
console.log(JSON.stringify(out));
