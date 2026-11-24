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

// ---------------------------------------------------------------------------
// Norwegen: Nasjonal høydemodell (Kartverket), DTM aus Laserscanning (1 m),
// über WCS direkt in Web-Mercator-Kacheln (EPSG:3857) abgefragt. Lizenz: CC BY 4.0.
// Hinweis: Der Dienst antwortet mit HTTP 503 auf den Parameter INTERPOLATION und auf
// Koordinaten mit vielen Nachkommastellen – daher weggelassen bzw. auf cm gerundet.
// ---------------------------------------------------------------------------

export const KARTVERKET_WCS = "https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833";
/** grobe Hülle Norwegens (inkl. Grenzgebiete); außerhalb wird gar nicht erst angefragt */
export const NORWAY_BBOX: [number, number, number, number] = [4.0, 57.8, 31.5, 71.4];

const EARTH = 6378137;
const ORIGIN = Math.PI * EARTH;

/** Kachelgrenzen in EPSG:3857-Metern [minx, miny, maxx, maxy]. */
export function tileBounds3857(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * ORIGIN) / 2 ** z;
  const minx = -ORIGIN + x * size;
  const maxy = ORIGIN - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

export function tileLngLatBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (xx: number) => (xx / n) * 360 - 180;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

export function inNorwayBox(b: [number, number, number, number]): boolean {
  return b[2] > NORWAY_BBOX[0] && b[0] < NORWAY_BBOX[2] && b[3] > NORWAY_BBOX[1] && b[1] < NORWAY_BBOX[3];
}

export function kartverketUrl(z: number, x: number, y: number): string {
  const [a, b, c, d] = tileBounds3857(z, x, y);
  return (
    `${KARTVERKET_WCS}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=nhm_dtm_topo_25833` +
    `&FORMAT=GeoTIFF&WIDTH=${TILE}&HEIGHT=${TILE}&CRS=EPSG:3857&RESPONSE_CRS=EPSG:3857` +
    `&BBOX=${[a, b, c, d].map((v) => v.toFixed(2)).join(",")}`
  );
}

/** Kein Wert (Meer, Ausland, Lücke). */
const isNoData = (v: number) => !Number.isFinite(v) || v < -500 || v > 9000;

/** Höchstens so viele gleichzeitige Anfragen an Kartverket (der Dienst drosselt sonst mit HTTP 503). */
export const KARTVERKET_CONCURRENCY = 3;
/** Zeitlimit je Kachel (ms) */
export const KARTVERKET_TIMEOUT = 8000;

let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= KARTVERKET_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Schutzschalter: Nach mehreren Fehlern in Folge wird Kartverket für eine Minute
 * übersprungen und das globale Modell genutzt (statt bei jeder Kachel zu warten).
 */
export const kartverketBreaker = { failures: 0, openUntil: 0, lastError: "" };

/** Lädt eine Kartverket-Kachel; null, wenn die Kachel außerhalb der Abdeckung liegt. */
export async function loadKartverketTile(z: number, x: number, y: number, fetchFn: typeof fetch = fetch): Promise<Float32Array | null> {
  return limited(async () => {
    // inzwischen als gestört erkannt → nicht mehr anfragen
    if (Date.now() < kartverketBreaker.openUntil) throw new Error(kartverketBreaker.lastError || "Dienst gestört");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), KARTVERKET_TIMEOUT);
    try {
      return await fetchKartverket(z, x, y, fetchFn, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}

async function fetchKartverket(z: number, x: number, y: number, fetchFn: typeof fetch, signal: AbortSignal): Promise<Float32Array | null> {
  let res = await fetchFn(kartverketUrl(z, x, y), { signal });
  if (res.status === 503) {
    // Dienst kurz überlastet: einmal nach Pause wiederholen
    await new Promise((r) => setTimeout(r, 1200));
    res = await fetchFn(kartverketUrl(z, x, y), { signal });
  }
  if (!res.ok) throw new Error(`Kartverket HTTP ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").includes("tiff")) return null; // Service-Exception = keine Abdeckung
  const { fromArrayBuffer } = await import("geotiff");
  try {
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [band] = (await img.readRasters()) as unknown as [ArrayLike<number>];
    const out = Float32Array.from(band);
    return out.length === TILE * TILE ? out : null;
  } catch {
    return null; // leere TIFF-Antwort außerhalb Norwegens
  }
}

export type DemSource = "auto" | "global";

/** Statistik, welche Quelle tatsächlich genutzt wurde (für die Anzeige). */
export const demStats = { kartverket: 0, global: 0, kartverketErrors: 0 };

/**
 * Terrarium nur bis Zoom 15 verfügbar; höhere Zoomstufen werden aus der
 * Elternkachel hochgerechnet (bilinear).
 */
export function terrariumAnyZoom(base: TileLoader): TileLoader {
  return async (z, x, y) => {
    if (z <= 15) return base(z, x, y);
    const dz = z - 15;
    const f = 2 ** dz;
    const parent = await base(15, Math.floor(x / f), Math.floor(y / f));
    const ox = (x % f) * (TILE / f), oy = (y % f) * (TILE / f);
    const out = new Float32Array(TILE * TILE);
    for (let r = 0; r < TILE; r++)
      for (let c = 0; c < TILE; c++) {
        const px = Math.min(TILE - 1.001, ox + (c + 0.5) / f - 0.5), py = Math.min(TILE - 1.001, oy + (r + 0.5) / f - 0.5);
        const x0 = Math.max(0, Math.floor(px)), y0 = Math.max(0, Math.floor(py));
        const tx = Math.max(0, px - x0), ty = Math.max(0, py - y0);
        const g = (yy: number, xx: number) => parent[Math.min(TILE - 1, yy) * TILE + Math.min(TILE - 1, xx)];
        out[r * TILE + c] = g(y0, x0) * (1 - tx) * (1 - ty) + g(y0, x0 + 1) * tx * (1 - ty) + g(y0 + 1, x0) * (1 - tx) * ty + g(y0 + 1, x0 + 1) * tx * ty;
      }
    return out;
  };
}

/**
 * Kombinierter Loader: in Norwegen Kartverket (Lücken aus dem globalen Modell
 * aufgefüllt), sonst AWS Terrain Tiles.
 */
/** Zwischenspeicher für fertige Kacheln (Analyse und Flusslauf nutzen dieselben). */
const tileCache = new Map<string, Promise<Float32Array>>();
const TILE_CACHE_MAX = 300; // ≈ 80 MB

export function compositeTileLoader(source: DemSource = "auto", globalLoader: TileLoader = browserTileLoader, fetchFn?: typeof fetch): TileLoader {
  const load = compositeUncached(source, globalLoader, fetchFn);
  const cacheable = globalLoader === browserTileLoader && !fetchFn;
  return (z, x, y) => {
    if (!cacheable) return load(z, x, y);
    const key = `${source}/${z}/${x}/${y}`;
    let t = tileCache.get(key);
    if (t) {
      tileCache.delete(key); // als zuletzt benutzt markieren
      tileCache.set(key, t);
      return t;
    }
    t = load(z, x, y);
    t.catch(() => tileCache.delete(key));
    tileCache.set(key, t);
    if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
    return t;
  };
}

function compositeUncached(source: DemSource, globalLoader: TileLoader, fetchFn?: typeof fetch): TileLoader {
  const global = terrariumAnyZoom(globalLoader);
  return async (z, x, y) => {
    if (source === "auto" && inNorwayBox(tileLngLatBounds(z, x, y)) && Date.now() >= kartverketBreaker.openUntil) {
      let kv: Float32Array | null = null;
      try {
        kv = await loadKartverketTile(z, x, y, fetchFn);
        kartverketBreaker.failures = 0;
      } catch (e) {
        kv = null; // Dienst gestört → global
        if (Date.now() >= kartverketBreaker.openUntil)
          kartverketBreaker.lastError = (e as Error).name === "AbortError" ? "Zeitüberschreitung" : (e as Error).message;
        if (++kartverketBreaker.failures >= 3) kartverketBreaker.openUntil = Date.now() + 60_000;
        demStats.kartverketErrors++;
      }
      if (kv) {
        let gaps = 0;
        for (const v of kv) if (isNoData(v)) gaps++;
        if (gaps < kv.length) {
          demStats.kartverket++;
          if (gaps > 0) {
            const g = await global(z, x, y);
            for (let i = 0; i < kv.length; i++) if (isNoData(kv[i])) kv[i] = g[i];
          }
          return kv;
        }
      }
    }
    demStats.global++;
    return global(z, x, y);
  };
}

/** Liegt ein Punkt (grob) im Abdeckungsgebiet des norwegischen Modells? */
export function nearNorway(p: LngLat): boolean {
  return p[0] > NORWAY_BBOX[0] && p[0] < NORWAY_BBOX[2] && p[1] > NORWAY_BBOX[1] && p[1] < NORWAY_BBOX[3];
}
