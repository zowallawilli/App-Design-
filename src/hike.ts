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
  /** Flüsse (OSM-Klasse river/canal) als Linien – Queren nur über Brücke/Furt-Weg */
  rivers: LngLat[][];
  /** Bäche – queren ist meist möglich */
  streams?: LngLat[][];
  /** Seen und flächige Flüsse (äußere Ringe) */
  water: LngLat[][];
  /** Gletscher (äußere Ringe) */
  glacier: LngLat[][];
}

export const HIKE = {
  /** weglos: Steigung in Gehrichtung höchstens (0,5 ≈ 27°) */
  maxSlope: 0.5,
  /** weglos: Gelände-Steilheit der Zelle (Hangneigung, unabhängig von der Gehrichtung – verhindert Queren und
   *  Serpentinen in Steilhängen): ab `steepFrom` (≈ 20°) teurer, ab `steepMax` (≈ 33°) gesperrt */
  steepFrom: 0.36,
  steepMax: 0.65,
  /** zweiter Versuch, falls es ohne Steilgelände keine Verbindung gibt */
  relaxed: { maxSlope: 0.8, steepMax: 1.0 },
  /** Zeitfaktor weglos gegenüber Weg (Wege deutlich bevorzugen, auch wenn sie etwas länger sind) */
  offTrail: 2.5,
  /** Zeitfaktor für Fluss/See (praktisch nur über Brücken/Furt-Wege) und Gletscher, Bach */
  water: 150,
  glacier: 3,
  stream: 3,
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
  /** nur mit Steilgelände (> ~33°) möglich */
  steep?: boolean;
  /** keine OSM-Wege im Ausschnitt geladen */
  noPaths?: boolean;
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

/** Raster um `r` Zellen verbreitern (Zellen mit Wert `value`) – dünne Linien lassen sich sonst diagonal „durchschlüpfen“ */
export function dilate(g: Grid, m: Uint8Array, value: number, r = 1, onlyInto?: (v: number) => boolean) {
  const src = m.slice();
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      if (src[y * g.w + x] !== value) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h) continue;
          const i = yy * g.w + xx;
          if (!onlyInto || onlyInto(m[i])) m[i] = value;
        }
    }
}

/** Zellen entlang von Linien (Start-/Zielflüsse, verbreitert: Ein-/Ausstieg an beiden Ufern) bzw. am Punkt */
export function cellsOf(g: Grid, lines: LngLat[][]): Int32Array {
  const m = new Uint8Array(g.w * g.h);
  rasterLines(g, lines.map((l) => (l.length === 1 ? [l[0], l[0]] : l)), m);
  if (lines.some((l) => l.length > 1)) dilate(g, m, 1, 1);
  const out: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) out.push(i);
  return Int32Array.from(out);
}

/** Hangneigung je Zelle (Betrag des Gradienten, Horn-Verfahren) */
export function terrainSlope(g: Grid): Float32Array {
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const out = new Float32Array(g.w * g.h);
  const z = (x: number, y: number) => g.elev[Math.min(g.h - 1, Math.max(0, y)) * g.w + Math.min(g.w - 1, Math.max(0, x))];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const dzdx = (z(x + 1, y - 1) + 2 * z(x + 1, y) + z(x + 1, y + 1) - z(x - 1, y - 1) - 2 * z(x - 1, y) - z(x - 1, y + 1)) / (8 * cell);
      const dzdy = (z(x - 1, y + 1) + 2 * z(x, y + 1) + z(x + 1, y + 1) - z(x - 1, y - 1) - 2 * z(x, y - 1) - z(x + 1, y - 1)) / (8 * cell);
      out[y * g.w + x] = Math.hypot(dzdx, dzdy);
    }
  return out;
}

/** Zeitfaktor weglos nach Hangneigung (Infinity = gesperrt) */
export function steepFactor(t: number, steepMax = HIKE.steepMax): number {
  if (t > steepMax) return Infinity;
  if (t <= HIKE.steepFrom) return 1;
  return 1 + 8 * ((t - HIKE.steepFrom) / (steepMax - HIKE.steepFrom)) ** 2;
}

/**
 * Wegsuche im Raster: von allen Startzellen zur nächstgelegenen Zielzelle (Gehzeit in Sekunden).
 * `kind`: 0 weglos, 1 Weg, 2 Wasser, 3 Gletscher, 4 Bach; `penalty`: Faktor je Zelle (Alternativen).
 */
export function hikeOnGrid(g: Grid, kind: Uint8Array, sources: Int32Array, targets: Int32Array, penalty?: Float32Array, relaxed = false, slope?: Float32Array): { path: number[]; seconds: number } | null {
  const tslope = slope ?? terrainSlope(g);
  const maxSlope = relaxed ? HIKE.relaxed.maxSlope : HIKE.maxSlope, steepMax = relaxed ? HIKE.relaxed.steepMax : HIKE.steepMax;
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
  // Zellen direkt neben Wegen: Weg und Höhenmodell sind oft um eine Zelle versetzt (Serpentinen kleiner als das Raster)
  const nearPath = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (kind[i] === 1) nearPath[i] = 1;
  dilate(g, nearPath, 1, 1);
  // gewählte Start-/Zielpunkte bleiben erreichbar: im Umkreis ~150 m Steilgelände nur verteuert, nicht gesperrt
  const zone = endZone(g, sources, targets);
  const factor = (i: number) =>
    isSource[i] || isTarget[i] || kind[i] === 1 ? 1
      : kind[i] === 2 ? HIKE.water
      : (kind[i] === 3 ? HIKE.glacier : kind[i] === 4 ? HIKE.stream : HIKE.offTrail) *
        (nearPath[i] || zone[i] ? Math.min(8, steepFactor(tslope[i], steepMax)) : steepFactor(tslope[i], steepMax));
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
      const onPath = nearPath[ni] === 1 && nearPath[c] === 1;
      if (Math.abs(s) > maxSlope && !onPath && !zone[ni] && !zone[c]) continue; // Felsen/Steilhang – auf Wegen trotzdem erlaubt
      const f = (factor(c) + factor(ni)) * 0.5;
      if (!Number.isFinite(f)) continue;
      const sec = (d / ((tobler(s) * 1000) / 3600)) * f * (penalty ? (penalty[c] + penalty[ni]) * 0.5 : 1);
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
  const slope = terrainSlope(g);
  let relaxed = false;
  let best = hikeOnGrid(g, kind, sources, targets, undefined, false, slope);
  if (!best) { relaxed = true; best = hikeOnGrid(g, kind, sources, targets, undefined, true, slope); }
  if (!best) return [];
  const first = describePath(g, kind, best.path, best.seconds);
  const zone = endZone(g, sources, targets);
  first.steep = relaxed && steepShare(g, kind, slope, best.path, zone) > 0;
  const out = [first];
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
    const alt = hikeOnGrid(g, kind, sources, targets, penalty, relaxed, slope);
    if (!alt) break;
    const res = describePath(g, kind, alt.path, alt.seconds);
    res.steep = relaxed && steepShare(g, kind, slope, alt.path, zone) > 0;
    // echte Gehzeit (ohne Strafe) vergleichen; zu lange oder fast gleiche Wege verwerfen
    const plain = hikeCost(g, kind, alt.path, slope, relaxed ? HIKE.relaxed.steepMax : HIKE.steepMax);
    res.costHours = plain / 3600;
    const ownCells = new Set(alt.path);
    const overlap = out.some((o) => o.line.length && sharedShare(o, res) > 0.6);
    if (res.costHours <= out[0].costHours * HIKE.altMaxRatio && !overlap && ownCells.size > 2) out.push(res);
    last = alt.path;
  }
  return out;
}

/** Umkreis ~150 m um Start-/Zielzellen */
function endZone(g: Grid, sources: Int32Array, targets: Int32Array): Uint8Array {
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const zone = new Uint8Array(g.w * g.h);
  // nur bei wenigen Zellen (Punkte); Flüsse sind schon verbreitert
  for (const set of [sources, targets]) if (set.length <= 4) for (const i of set) zone[i] = 1;
  dilate(g, zone, 1, Math.max(1, Math.round(150 / cell)));
  for (const set of [sources, targets]) for (const i of set) zone[i] = 1;
  return zone;
}

/** Anzahl wegloser Zellen des Weges, die steiler als das normale Limit sind (nicht neben einem Weg, nicht am Start/Ziel) */
function steepShare(g: Grid, kind: Uint8Array, slope: Float32Array, path: number[], zone: Uint8Array): number {
  let n = 0;
  for (const i of path) {
    if (kind[i] === 1 || zone[i] || slope[i] <= HIKE.steepMax) continue;
    const x = i % g.w, y = Math.floor(i / g.w);
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) { const j = (y + dy) * g.w + x + dx; if (j >= 0 && j < kind.length && kind[j] === 1) near = true; }
    if (!near) n++;
  }
  return n;
}

/** Gehzeit (s) eines gegebenen Rasterweges ohne Strafe */
function hikeCost(g: Grid, kind: Uint8Array, path: number[], slope: Float32Array, steepMax: number): number {
  const mid = pixelToLngLat(g.x0 + g.w / 2, g.y0 + g.h / 2, g.z);
  const cell = (156543.03 * Math.cos((mid[1] * Math.PI) / 180)) / 2 ** g.z;
  const f = (i: number) => (kind[i] === 1 ? 1 : kind[i] === 2 ? HIKE.water : (kind[i] === 3 ? HIKE.glacier : kind[i] === 4 ? HIKE.stream : HIKE.offTrail) * Math.min(20, steepFactor(slope[i], steepMax)));
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
  let pathCount = 0;
  if (inp.layers) {
    inp.onProgress?.("Verbindungsweg: Wege, Gewässer und Gletscher aus OSM …");
    const L = await inp.layers(bb).catch(() => null);
    if (L) {
      rasterPolygons(g, L.glacier, kind, 3);
      rasterLines(g, L.streams ?? [], kind, 4);
      rasterPolygons(g, L.water, kind, 2);
      rasterLines(g, L.rivers, kind, 2);
      dilate(g, kind, 2, 1, (v) => v !== 1); // Flüsse 3 Zellen breit: nicht diagonal durchschlüpfen
      rasterLines(g, L.paths, kind, 1); // Brücken/Furten: Weg schlägt Wasser
      pathCount = L.paths.length;
    }
  }
  const sources = cellsOf(g, clip(inp.from, bb));
  const targets = cellsOf(g, clip(inp.to, bb));
  if (!sources.length || !targets.length) throw new Error("Start oder Ziel liegt außerhalb des Ausschnitts.");
  inp.onProgress?.("Verbindungsweg: beste Route suchen …");
  await new Promise((r) => setTimeout(r, 0));
  const res = hikeRoutes(g, kind, sources, targets, inp.alternatives ?? 2);
  if (!res.length) throw new Error("Keine begehbare Verbindung gefunden (zu steil oder außerhalb des Ausschnitts).");
  res.forEach((r) => (r.noPaths = pathCount === 0));
  return res;
}
