// Talweg aus dem Höhenmodell ableiten (für Gebiete, in denen OSM-Gewässer fehlen oder ungenau sind).
// Verfahren: Priority-Flood (Barnes et al. 2014) füllt Senken und liefert zugleich D8-Fließrichtungen.

import type { LngLat } from "./geo";
import { browserTileLoader, lngLatToPixel, type TileLoader } from "./dem";

const TILE = 256;

class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2); nk.set(this.keys); this.keys = nk;
      const nv = new Int32Array(this.size * 2); nv.set(this.vals); this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]; i = p;
    }
    this.keys[i] = k; this.vals[i] = v;
  }
  pop(): number {
    const top = this.vals[0];
    const k = this.keys[--this.size], v = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c]; i = c;
    }
    this.keys[i] = k; this.vals[i] = v;
    return top;
  }
}

export interface Grid {
  z: number; // Zoomstufe
  x0: number; // globale Pixel-Offsets
  y0: number;
  w: number;
  h: number;
  elev: Float32Array;
}

export async function loadGrid(bbox: [number, number, number, number], loader: TileLoader = browserTileLoader, maxCells = 4_000_000): Promise<Grid> {
  let z = 13;
  let a: [number, number], b: [number, number];
  for (;;) {
    a = lngLatToPixel([bbox[0], bbox[3]], z);
    b = lngLatToPixel([bbox[2], bbox[1]], z);
    if ((b[0] - a[0]) * (b[1] - a[1]) <= maxCells || z <= 8) break;
    z--;
  }
  const tx0 = Math.floor(a[0] / TILE), ty0 = Math.floor(a[1] / TILE);
  const tx1 = Math.floor(b[0] / TILE), ty1 = Math.floor(b[1] / TILE);
  const w = (tx1 - tx0 + 1) * TILE, h = (ty1 - ty0 + 1) * TILE;
  const elev = new Float32Array(w * h);
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        loader(z, tx, ty).then((t) => {
          const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
          for (let r = 0; r < TILE; r++) elev.set(t.subarray(r * TILE, (r + 1) * TILE), (oy + r) * w + ox);
        }),
      );
  await Promise.all(jobs);
  return { z, x0: tx0 * TILE, y0: ty0 * TILE, w, h, elev };
}

/** Liefert für jede Zelle den Index der Abflusszelle (-1 = Rand/Auslass). */
export function flowDirections(g: Grid): Int32Array {
  const { w, h } = g;
  const n = w * h;
  const z = Float64Array.from(g.elev);
  const dir = new Int32Array(n).fill(-2); // -2 = unbesucht
  const heap = new MinHeap(4 * (w + h));
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (dir[i] === -2) { dir[i] = -1; heap.push(z[i], i); } }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (dir[i] === -2) { dir[i] = -1; heap.push(z[i], i); } }
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy = [-1, -1, -1, 0, 0, 1, 1, 1];
  while (heap.size > 0) {
    const c = heap.pop();
    const cx = c % w, cy = (c - cx) / w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + dx[k], ny = cy + dy[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dir[ni] !== -2) continue;
      dir[ni] = c;
      if (z[ni] <= z[c]) z[ni] = z[c] + 1e-4; // Senke auffüllen, Gefälle zum Auslass erzwingen
      heap.push(z[ni], ni);
    }
  }
  return dir;
}

function pixelToLngLat(px: number, py: number, z: number): LngLat {
  const n = TILE * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Folgt dem Abfluss von `from` bis in die Nähe von `to` (oder bis zum Rasterrand).
 * Rückgabe: geglättete Linie in Fließrichtung.
 */
export function traceDownstream(g: Grid, dir: Int32Array, from: LngLat, to?: LngLat): { line: LngLat[]; missM: number } {
  const [fx, fy] = lngLatToPixel(from, g.z);
  // Startpunkt auf die tiefste Zelle im Umkreis (~60 m) setzen – Klicks liegen oft am Hang
  const mpp0 = (156543.03392 * Math.cos((from[1] * Math.PI) / 180)) / 2 ** g.z;
  const r = Math.max(1, Math.round(60 / mpp0));
  const sx = Math.floor(fx - g.x0), sy = Math.floor(fy - g.y0);
  let i = sy * g.w + sx;
  for (let yy = Math.max(0, sy - r); yy <= Math.min(g.h - 1, sy + r); yy++)
    for (let xx = Math.max(0, sx - r); xx <= Math.min(g.w - 1, sx + r); xx++) {
      if ((xx - sx) ** 2 + (yy - sy) ** 2 > r * r) continue;
      const j = yy * g.w + xx;
      if (g.elev[j] < g.elev[i]) i = j;
    }
  const target = to ? lngLatToPixel(to, g.z) : null;
  const pts: [number, number][] = [];
  let best = Infinity, bestIdx = 0;
  const seen = new Set<number>();
  while (i >= 0 && !seen.has(i)) {
    seen.add(i);
    const cx = i % g.w, cy = (i - cx) / g.w;
    const px = g.x0 + cx + 0.5, py = g.y0 + cy + 0.5;
    pts.push([px, py]);
    if (target) {
      const dd = Math.hypot(px - target[0], py - target[1]);
      if (dd < best) { best = dd; bestIdx = pts.length - 1; }
    }
    i = dir[i];
  }
  const cut = target ? pts.slice(0, bestIdx + 1) : pts;
  // D8-Treppen glätten (gleitendes Mittel über 5 Zellen)
  const sm = cut.map((_, k) => {
    const a = Math.max(0, k - 2), b = Math.min(cut.length - 1, k + 2);
    let sx = 0, sy = 0;
    for (let j = a; j <= b; j++) { sx += cut[j][0]; sy += cut[j][1]; }
    return pixelToLngLat(sx / (b - a + 1), sy / (b - a + 1), g.z);
  });
  return { line: sm, missM: target ? best * mpp0 : 0 };
}

/**
 * Komplett: Raster um beide Punkte laden und Talweg ableiten. Verlässt der Abfluss
 * den Ausschnitt, bevor er das Ziel erreicht, wird der Ausschnitt vergrößert.
 */
export async function deriveThalweg(from: LngLat, to: LngLat, loader?: TileLoader, onProgress?: (msg: string) => void): Promise<LngLat[]> {
  const span = Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1]));
  let margin = Math.max(0.1, span * 0.75);
  let last: { line: LngLat[]; missM: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress?.(`Höhenmodell für Talweg laden (Versuch ${attempt + 1}) …`);
    const bbox: [number, number, number, number] = [
      Math.min(from[0], to[0]) - margin, Math.min(from[1], to[1]) - margin,
      Math.max(from[0], to[0]) + margin, Math.max(from[1], to[1]) + margin,
    ];
    const g = await loadGrid(bbox, loader);
    onProgress?.("Fließwege berechnen …");
    last = traceDownstream(g, flowDirections(g), from, to);
    if (last.missM < 400) break;
    margin *= 1.8;
  }
  if (!last) throw new Error("Talweg konnte nicht abgeleitet werden.");
  if (last.missM >= 400 || last.line.length < 2)
    throw new Error(`Der Abfluss vom Einstieg erreicht den Ausstieg nicht (nächster Abstand ${(last.missM / 1000).toFixed(1)} km). Liegt der Ausstieg flussabwärts und am selben Fluss?`);
  return last.line;
}
