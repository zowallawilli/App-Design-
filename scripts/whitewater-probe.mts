// Schnelltest: Weißwasser im offenen Orthofoto (basemap.at, CC BY 4.0) entlang einer Strecke.
// NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npx tsx scripts/whitewater-probe.mts <out-dir>
// Umgebungsvariablen: CROPSTEP=<m> schreibt Ausschnitte alle n Meter.
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { waterInBbox } from "../src/vectorWater";
import { traceRiver } from "../src/route";
import { compositeTileLoader } from "../src/dem";
import { resample, type LngLat } from "../src/geo";
import { nodeTileLoader } from "./nodeTileLoader";

const OUT = process.argv[2] ?? "probe-out";
mkdirSync(`${OUT}/tiles`, { recursive: true });
const PUT_IN: LngLat = [10.491, 47.1176], TAKE_OUT: LngLat = [10.563, 47.1436];
const Z = 18, BUF_M = 12;

let line: LngLat[];
const lineFile = `${OUT}/line.json`;
if (existsSync(lineFile)) line = JSON.parse(readFileSync(lineFile, "utf8"));
else {
  const r = await traceRiver(PUT_IN, TAKE_OUT, { loader: compositeTileLoader("global", nodeTileLoader), waterways: waterInBbox });
  line = r.line; writeFileSync(lineFile, JSON.stringify(line));
}
const samples = resample(line, 2);
const len = samples[samples.length - 1].d;
console.log("Länge", (len / 1000).toFixed(2), "km");

const N = 2 ** Z * 256;
const lon2x = (lon: number) => ((lon + 180) / 360) * N;
const lat2y = (lat: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N; };
const x2lon = (x: number) => (x / N) * 360 - 180;
const y2lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
const mPerPx = (156543.03 * Math.cos((samples[0].p[1] * Math.PI) / 180)) / 2 ** Z;
const bufPx = BUF_M / mPerPx;

const tiles = new Set<string>();
for (const s of samples) { const x = lon2x(s.p[0]), y = lat2y(s.p[1]);
  for (const dx of [-bufPx, 0, bufPx]) for (const dy of [-bufPx, 0, bufPx]) tiles.add(`${Math.floor((x + dx) / 256)}/${Math.floor((y + dy) / 256)}`); }
const xs = [...tiles].map((t) => +t.split("/")[0]), ys = [...tiles].map((t) => +t.split("/")[1]);
const tx0 = Math.min(...xs), ty0 = Math.min(...ys), W = (Math.max(...xs) - tx0 + 1) * 256, H = (Math.max(...ys) - ty0 + 1) * 256;
console.log("Kacheln", tiles.size, "Raster", W, "×", H);
const img = new Uint8Array(W * H * 3);
const list = [...tiles];
for (let i = 0; i < list.length; i += 16) await Promise.all(list.slice(i, i + 16).map(async (t) => {
  const [x, y] = t.split("/").map(Number);
  const f = `${OUT}/tiles/${x}_${y}.jpg`;
  let buf: Buffer;
  if (existsSync(f)) buf = readFileSync(f); else {
    const r = await fetch(`https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${Z}/${y}/${x}.jpeg`);
    if (!r.ok) return; buf = Buffer.from(await r.arrayBuffer()); writeFileSync(f, buf);
  }
  const d = jpeg.decode(buf, { useTArray: true });
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    const s = (py * 256 + px) * 4, o = (((y - ty0) * 256 + py) * W + (x - tx0) * 256 + px) * 3;
    img[o] = d.data[s]; img[o + 1] = d.data[s + 1]; img[o + 2] = d.data[s + 2];
  }
}));

// Korridor um die Linie, je Pixel Stationierung (m)
const station = new Float32Array(W * H).fill(-1);
const r = Math.ceil(bufPx);
for (const s of samples) { const cx = lon2x(s.p[0]) - tx0 * 256, cy = lat2y(s.p[1]) - ty0 * 256;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > bufPx * bufPx) continue;
    const X = Math.round(cx + dx), Y = Math.round(cy + dy); if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    if (station[Y * W + X] < 0) station[Y * W + X] = s.d; } }

const white = new Uint8Array(W * H);
const BIN = 25, nb = Math.ceil(len / BIN) + 1, cntW = new Float64Array(nb), cntA = new Float64Array(nb);
for (let i = 0; i < W * H; i++) { if (station[i] < 0) continue;
  const R = img[i * 3], G = img[i * 3 + 1], B = img[i * 3 + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const V = mx / 255, S = mx ? (mx - mn) / mx : 0;
  const isW = V > 0.78 && S < 0.18 && B >= R - 6;
  const bi = Math.floor(station[i] / BIN); cntA[bi]++; if (isW) { white[i] = 1; cntW[bi]++; } }
const prof = [...cntA].map((a, i) => ({ d: i * BIN, frac: a ? cntW[i] / a : 0 }));
writeFileSync(`${OUT}/profile.json`, JSON.stringify(prof));
for (const p of prof) if (p.frac > 0.05) {
  const s = samples[Math.min(samples.length - 1, Math.round(p.d / 2))];
  console.log(`km ${(p.d / 1000).toFixed(3)}  ${(p.frac * 100).toFixed(0)} %  ${s.p[0].toFixed(5)}, ${s.p[1].toFixed(5)}`);
}

const crop = (name: string, lon: number, lat: number, half = 250) => {
  const cx = Math.round(lon2x(lon) - tx0 * 256), cy = Math.round(lat2y(lat) - ty0 * 256);
  const p = new PNG({ width: half * 4, height: half * 2 });
  for (let y = 0; y < half * 2; y++) for (let x = 0; x < half * 2; x++) {
    const X = cx - half + x, Y = cy - half + y; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const i = Y * W + X;
    for (const [off, mark] of [[0, false], [half * 2, true]] as const) {
      const o = (y * half * 4 + x + off) * 4; p.data[o] = img[i * 3]; p.data[o + 1] = img[i * 3 + 1]; p.data[o + 2] = img[i * 3 + 2]; p.data[o + 3] = 255;
      if (mark && white[i]) { p.data[o] = 255; p.data[o + 1] = 0; p.data[o + 2] = 0; }
      else if (mark && station[i] < 0) { p.data[o] >>= 1; p.data[o + 1] >>= 1; p.data[o + 2] >>= 1; } } }
  writeFileSync(`${OUT}/crop-${name}.png`, PNG.sync.write(p));
};
if (process.env.CROPSTEP) for (let d = 0; d < len; d += +process.env.CROPSTEP) {
  const s = samples[Math.round(d / 2)]; crop(`${String(Math.round(d)).padStart(5, "0")}`, s.p[0], s.p[1]);
}
void x2lon; void y2lat;
