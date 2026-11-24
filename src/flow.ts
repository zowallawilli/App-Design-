// Höhenraster für einen Ausschnitt laden (Kacheln zusammensetzen) und Hilfsstrukturen
// für Wegsuchen (Min-Heap, Pixel ↔ Koordinate).

import type { LngLat } from "./geo";
import { browserTileLoader, lngLatToPixel, type TileLoader } from "./dem";

const TILE = 256;

export class MinHeap {
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

export async function loadGrid(
  bbox: [number, number, number, number],
  loader: TileLoader = browserTileLoader,
  maxCells = 4_000_000,
  maxZoom = 13,
  onTile?: (done: number, total: number) => void,
): Promise<Grid> {
  let z = maxZoom;
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
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  let done = 0;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        loader(z, tx, ty).then((t) => {
          const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
          for (let r = 0; r < TILE; r++) elev.set(t.subarray(r * TILE, (r + 1) * TILE), (oy + r) * w + ox);
          onTile?.(++done, total);
        }),
      );
  await Promise.all(jobs);
  return { z, x0: tx0 * TILE, y0: ty0 * TILE, w, h, elev };
}

export function pixelToLngLat(px: number, py: number, z: number): LngLat {
  const n = TILE * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [lon, lat];
}
