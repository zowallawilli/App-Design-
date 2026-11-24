// Höhenabfrage aus Terrarium-Kacheln (AWS Open Data "Terrain Tiles", weltweit, frei).
// Kodierung: Höhe = R*256 + G + B/256 - 32768 (Meter).
// Datenquellen der Kacheln: u. a. SRTM, EU-DEM, nationale DGMs – Auflösung je Region 3–90 m.

import type { LngLat } from "./geo";

export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TILE = 256;

/** Lädt eine Kachel als Höhenraster (256×256 Float32). */
export type TileLoader = (z: number, x: number, y: number) => Promise<Float32Array>;

export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Browser-Loader: PNG holen und per Canvas dekodieren. */
export const browserTileLoader: TileLoader = async (z, x, y) => {
  const url = TERRARIUM_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Höhenkachel ${z}/${x}/${y}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas nicht verfügbar");
  ctx.drawImage(bmp, 0, 0);
  return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
};

/** Pixelkoordinate (global, Web-Mercator) eines Punkts bei Zoom z. */
export function lngLatToPixel(p: LngLat, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const x = ((p[0] + 180) / 360) * n;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, p[1])) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

/** Bodenauflösung einer Kachel in m/Pixel bei Breite lat. */
export function metersPerPixel(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

export class ElevationSampler {
  private cache = new Map<string, Promise<Float32Array>>();

  constructor(private loader: TileLoader = browserTileLoader, readonly zoom = 13) {}

  private tile(x: number, y: number): Promise<Float32Array> {
    const key = `${x}/${y}`;
    let t = this.cache.get(key);
    if (!t) {
      t = this.loader(this.zoom, x, y);
      t.catch(() => this.cache.delete(key));
      this.cache.set(key, t);
    }
    return t;
  }

  private async pixel(px: number, py: number): Promise<number> {
    const max = TILE * 2 ** this.zoom;
    px = ((px % max) + max) % max;
    py = Math.max(0, Math.min(max - 1, py));
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const data = await this.tile(tx, ty);
    return data[(Math.floor(py) - ty * TILE) * TILE + (Math.floor(px) - tx * TILE)];
  }

  /** Bilinear interpolierte Höhe in m. */
  async elevation(p: LngLat): Promise<number> {
    const [x, y] = lngLatToPixel(p, this.zoom);
    // Pixelmittelpunkte liegen bei +0.5
    const fx = x - 0.5, fy = y - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const [a, b, c, d] = await Promise.all([
      this.pixel(x0, y0), this.pixel(x0 + 1, y0), this.pixel(x0, y0 + 1), this.pixel(x0 + 1, y0 + 1),
    ]);
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  /** Höhen für viele Punkte (Kacheln werden nur einmal geladen). */
  async elevations(points: LngLat[], onProgress?: (done: number, total: number) => void): Promise<number[]> {
    const out: number[] = new Array(points.length);
    const chunk = 200;
    for (let i = 0; i < points.length; i += chunk) {
      const part = await Promise.all(points.slice(i, i + chunk).map((p) => this.elevation(p)));
      part.forEach((v, j) => (out[i + j] = v));
      onProgress?.(Math.min(points.length, i + chunk), points.length);
    }
    return out;
  }
}
