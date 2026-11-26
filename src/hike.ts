// Verbindungswege zu Fuß zwischen zwei Flusstälern (bzw. zwei Punkten): Weg mit der kürzesten
// Gehzeit über das Höhenmodell. Gehgeschwindigkeit nach Tobler (abhängig von der Steigung),
// weglos langsamer als auf OSM-Wegen; sehr steiles Gelände (> ~37°) gesperrt, Seen/Flüsse queren
// und Gletscher teuer. „Fluss → Fluss“: Start an jeder Stelle von Fluss A, Ziel an jeder Stelle von
// Fluss B – die Suche findet selbst die günstigsten Aus-/Einstiege und meist den niedrigsten Sattel.
// Ein Indikator, keine geprüfte Route (Felsstufen < 30 m, Wald/Gebüsch, Sumpf fehlen im Modell).

import { lngLatToPixel, type TileLoader } from "./dem";
import { MinHeap, loadGrid, pixelToLngLat, type Grid } from "./flow";
import { haversine, type LngLat } from "./geo";

/** Wege, Gewässer und Gletscher (aus OSM-Vektorkacheln) */
export interface HikeLayers {
  /** Wege, Pfade, Fahrwege, Straßen */
  paths: LngLat[][];
  /** Flüsse/Bäche als Linien */
  rivers: LngLat[][];
  /** Seen und flächige Flüsse (äußere Ringe) */
  water: LngLat[][];
  /** Gletscher (äußere Ringe) */
  glacier: LngLat[][];
}

export const HIKE = {
  /** Steigung, ab der Gelände als nicht begehbar gilt (0,75 ≈ 37°) */
  maxSlope: 0.75,
  /** Zeitfaktor weglos gegenüber Weg */
  offTrail: 1.6,
  /** Zeitfaktor für Wasser (Fluss/See queren) und Gletscher */
  water: 12,
  glacier: 3,
  /** Alternativen: Strafe für Zellen nahe bisheriger Wege, max. Mehrzeit gegenüber der besten Route */
  altPenalty: 5,
  altRadiusM: 500,
  altMaxRatio: 1.6,
};

export interface HikeResult {
  line: LngLat[];
  /** Höhen entlang der Linie (m) und Abstand ab Start (m) */
  elev: number[];
  dist: number[];
  lengthM: number;
  ascent: number;
  descent: number;
  maxElev: number;
  /** höchster Punkt (meist der Pass) */
  pass: LngLat;
  /** Gehzeit nach DIN 33466 (h, ohne Pausen) */
  hours: number;
  /** Anteil weglos (0–1) */
  offTrail: number;
  /** Modell-Gehzeit (h) inkl. Wegloszuschlag – Grundlage für den Vergleich der Alternativen */
  costHours: number;
}

/** Gehzeit nach DIN 33466: 4 km/h waagrecht, 300 Hm/h bergauf, 500 Hm/h bergab; größerer + halber kleinerer Wert */
export function dinHours(lengthM: number, ascent: number, descent: number): number {
  const h = lengthM / 4000, v = ascent / 300 + descent / 500;
  return Math.max(h, v) + Math.min(h, v) / 2;
}

/** Gehgeschwindigkeit nach Tobler (km/h) für die Steigung s (Δh/Δx) */
export const tobler = (s: number) => 6 * Math.exp(-3.5 * Math.abs(s + 0.05));

/** Auf- und Abstieg mit Rauschschwelle (Höhenmodell-Zacken < `thr` m zählen nicht) */
export function climb(elev: number[], thr = 5): { ascent: number; descent: number } {
  let ascent = 0, descent = 0, ref = elev[0];
  for (const z of elev) {
    if (z - ref >= thr) { ascent += z - ref; ref = z; }
    else if (ref - z >= thr) { descent += ref - z; ref = z; }
  }
  return { ascent, descent };
}

// ---------- Raster der Hindernisse/Wege ----------
function toCell(g: Grid, p: LngLat): [number, number] {
  const [px, py] = lngLatToPixel(p, g.z);
  return [Math.floor(px - g.x0), Math.floor(py - g.y0)];
}
/** Linien ins Raster (Bresenham) */
export function rasterLines(g: Grid, lines: LngLat[][], out: Uint8Array, value = 1) {
  for (const l of lines)
    for (let i = 0; i + 1 < l.length; i++) {
      let [x0, y0] = toCell(g, l[i]);
      const [x1, y1] = toCell(g, l[i + 1]);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let n = 0; n < 100000; n++) {
        if (x0 >= 0 && y0 >= 0 && x0 < g.w && y0 < g.h) out[y0 * g.w + x0] = value;
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
}
/** Flächen ins Raster (Zeilenweise, gerade-ungerade-Regel) */
export function rasterPolygons(g: Grid, rings: LngLat[][], out: Uint8Array, value = 1) {
  for (const ring of rings) {
    const pts = ring.map((p) => { const [px, py] = lngLatToPixel(p, g.z); return [px - g.x0, py - g.y0]; });
    const ys = pts.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(g.h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5, xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > yc) !== (yj > yc)) xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(g.w - 1, Math.floor(xs[k + 1] - 0.5)); x++) out[y * g.w + x] = value;
    }
  }
}

/** Zellen entlang von Linien (Start-/Zielflüsse) bzw. am Punkt */
export function cellsOf(g: Grid, lines: LngLat[][]): Int32Array {
  const m = new Uint8Array(g.w * g.h);
  rasterLines(g, lines.map((l) => (l.length === 1 ? [l[0], l[0]] : l)), m);
  const out: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) out.push(i);
  return Int32Array.from(out);
}

/**
 * Wegsuche im Raster: von allen Startzellen zur nächstgelegenen Zielzelle (Gehzeit in Sekunden).
 * `kind`: 0 weglos, 1 Weg, 2 Wasser, 3 Gletscher; `penalty`: Faktor je Zelle (Alternativen).
 */
export function hikeOnGrid(g: Grid, kind: Uint8Array, sources: Int32Array, targets: Int32Array, penalty?: Float32Array): { path: number[]; seconds: number } | null {
  const n = g.w * g.h;
  const isTarget = new Uint8Array(n);
  for (const t of targets) isTarget[t] = 1;
  const isSource = new Uint8Array(n);
  for (const s of sources) isSource[s] = 1;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(1 << 16);
  for (const s of sources) { dist[s] = 0; heap.push(0, s); }
  // Zellgröße (m) in der Mitte des Ausschnitts
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1], dy = [-1, -1, -1, 0, 0, 1, 1, 1];
  const len = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
  const factor = (i: number) => (isSource[i] || isTarget[i] ? 1 : kind[i] === 1 ? 1 : kind[i] === 2 ? HIKE.water : kind[i] === 3 ? HIKE.glacier : HIKE.offTrail);
  let hit = -1;
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (isTarget[c]) { hit = c; break; }
    const cx = c % g.w, cy = (c - cx) / g.w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + dx[k], ny = cy + dy[k];
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const ni = ny * g.w + nx;
      if (done[ni]) continue;
      const d = len[k] * cell;
      const s = (g.elev[ni] - g.elev[c]) / d;
      if (Math.abs(s) > HIKE.maxSlope && kind[ni] !== 1) continue; // Felsen/Steilhang – auf Wegen trotzdem erlaubt
      const sec = (d / ((tobler(s) * 1000) / 3600)) * (factor(c) + factor(ni)) * 0.5 * (penalty ? (penalty[c] + penalty[ni]) * 0.5 : 1);
      const nd = dist[c] + sec;
      if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = c; heap.push(nd, ni); }
    }
  }
  if (hit < 0) return null;
  const path: number[] = [];
  for (let c = hit; c >= 0; c = prev[c]) path.push(c);
  return { path: path.reverse(), seconds: dist[hit] };
}

/** Rasterweg → Ergebnis (Linie, Höhen, Kennwerte) */
export function describePath(g: Grid, kind: Uint8Array, path: number[], seconds: number): HikeResult {
  const line: LngLat[] = path.map((i) => pixelToLngLat(g.x0 + (i % g.w) + 0.5, g.y0 + Math.floor(i / g.w) + 0.5, g.z));
  const elev = path.map((i) => g.elev[i]);
  const dist = [0];
  for (let i = 1; i < line.length; i++) dist.push(dist[i - 1] + haversine(line[i - 1], line[i]));
  const lengthM = dist[dist.length - 1];
  const { ascent, descent } = climb(elev);
  let mi = 0;
  elev.forEach((z, i) => { if (z > elev[mi]) mi = i; });
  let off = 0;
  for (let i = 1; i < path.length; i++) if (kind[path[i]] !== 1) off += dist[i] - dist[i - 1];
  return {
    line, elev, dist, lengthM, ascent, descent, maxElev: elev[mi], pass: line[mi],
    hours: dinHours(lengthM, ascent, descent), offTrail: lengthM ? off / lengthM : 0, costHours: seconds / 3600,
  };
}

/** Bis zu `alternatives` weitere, deutlich andere Routen (Strafe nahe den bisherigen Wegen). */
export function hikeRoutes(g: Grid, kind: Uint8Array, sources: Int32Array, targets: Int32Array, alternatives = 2): HikeResult[] {
  const best = hikeOnGrid(g, kind, sources, targets);
  if (!best) return [];
  const out = [describePath(g, kind, best.path, best.seconds)];
  const penalty = new Float32Array(g.w * g.h).fill(1);
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const r = Math.max(1, Math.round(HIKE.altRadiusM / cell));
  let last = best.path;
  for (let k = 0; k < alternatives; k++) {
    // Umgebung des letzten Weges verteuern (nicht an Start/Ziel, sonst gäbe es keinen Ausweg)
    for (let j = Math.floor(last.length * 0.1); j < Math.ceil(last.length * 0.9); j += Math.max(1, Math.floor(r / 2))) {
      const cx = last[j] % g.w, cy = Math.floor(last[j] / g.w);
      for (let y = Math.max(0, cy - r); y <= Math.min(g.h - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(g.w - 1, cx + r); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) penalty[y * g.w + x] = HIKE.altPenalty;
    }
    const alt = hikeOnGrid(g, kind, sources, targets, penalty);
    if (!alt) break;
    const res = describePath(g, kind, alt.path, alt.seconds);
    // echte Gehzeit (ohne Strafe) vergleichen; zu lange oder fast gleiche Wege verwerfen
    const plain = hikeCost(g, kind, alt.path);
    res.costHours = plain / 3600;
    const ownCells = new Set(alt.path);
    const overlap = out.some((o) => o.line.length && sharedShare(o, res) > 0.6);
    if (res.costHours <= out[0].costHours * HIKE.altMaxRatio && !overlap && ownCells.size > 2) out.push(res);
    last = alt.path;
  }
  return out;
}

/** Gehzeit (s) eines gegebenen Rasterweges ohne Strafe */
function hikeCost(g: Grid, kind: Uint8Array, path: number[]): number {
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const f = (i: number) => (kind[i] === 1 ? 1 : kind[i] === 2 ? HIKE.water : kind[i] === 3 ? HIKE.glacier : HIKE.offTrail);
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const diag = a % g.w !== b % g.w && Math.floor(a / g.w) !== Math.floor(b / g.w);
    const d = (diag ? Math.SQRT2 : 1) * cell;
    s += (d / ((tobler((g.elev[b] - g.elev[a]) / d) * 1000) / 3600)) * (f(a) + f(b)) * 0.5;
  }
  return s;
}

/** Anteil der Punkte von b, die näher als 150 m an a liegen */
function sharedShare(a: HikeResult, b: HikeResult): number {
  const step = Math.max(1, Math.floor(b.line.length / 60)), stepA = Math.max(1, Math.floor(a.line.length / 300));
  let n = 0, near = 0;
  for (let i = 0; i < b.line.length; i += step) {
    n++;
    for (let j = 0; j < a.line.length; j += stepA) if (haversine(a.line[j], b.line[i]) < 150) { near++; break; }
  }
  return n ? near / n : 0;
}

export interface HikeInput {
  /** Start: Flusslinien (Fluss A) oder ein Punkt ([[p]]) */
  from: LngLat[][];
  to: LngLat[][];
  loader: TileLoader;
  layers?: (bbox: [number, number, number, number]) => Promise<HikeLayers>;
  alternatives?: number;
  maxCells?: number;
  onProgress?: (msg: string) => void;
}

/** Ausschnitt um beide Klickpunkte (mind. 3 km bzw. 40 % des Abstands Rand) */
export function hikeBbox(a: LngLat, b: LngLat): [number, number, number, number] {
  const dKm = haversine(a, b) / 1000;
  const padKm = Math.max(3, dKm * 0.4);
  const lat = (a[1] + b[1]) / 2;
  const dLat = padKm / 111.2, dLon = padKm / (111.2 * Math.cos((lat * Math.PI) / 180));
  return [Math.min(a[0], b[0]) - dLon, Math.min(a[1], b[1]) - dLat, Math.max(a[0], b[0]) + dLon, Math.max(a[1], b[1]) + dLat];
}

const clip = (lines: LngLat[][], bb: [number, number, number, number]) =>
  lines.map((l) => l.filter((p) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3])).filter((l) => l.length);

export async function findHike(inp: HikeInput, a: LngLat, b: LngLat): Promise<HikeResult[]> {
  const bb = hikeBbox(a, b);
  inp.onProgress?.("Verbindungsweg: Höhenmodell laden …");
  const g = await loadGrid(bb, inp.loader, inp.maxCells ?? 1_200_000, 13);
  const kind = new Uint8Array(g.w * g.h);
  if (inp.layers) {
    inp.onProgress?.("Verbindungsweg: Wege, Gewässer und Gletscher aus OSM …");
    const L = await inp.layers(bb).catch(() => null);
    if (L) {
      rasterPolygons(g, L.glacier, kind, 3);
      rasterPolygons(g, L.water, kind, 2);
      rasterLines(g, L.rivers, kind, 2);
      rasterLines(g, L.paths, kind, 1); // Brücken/Furten: Weg schlägt Wasser
    }
  }
  const sources = cellsOf(g, clip(inp.from, bb));
  const targets = cellsOf(g, clip(inp.to, bb));
  if (!sources.length || !targets.length) throw new Error("Start oder Ziel liegt außerhalb des Ausschnitts.");
  inp.onProgress?.("Verbindungsweg: beste Route suchen …");
  await new Promise((r) => setTimeout(r, 0));
  const res = hikeRoutes(g, kind, sources, targets, inp.alternatives ?? 2);
  if (!res.length) throw new Error("Keine begehbare Verbindung gefunden (zu steil oder außerhalb des Ausschnitts).");
  return res;
}
