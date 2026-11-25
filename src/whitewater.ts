// Weißwasser-Suche im hochaufgelösten, offenen Orthofoto (Indikator für Schwallstellen).
//
// Ablauf: Entlang der Flusslinie wird ein „Streifenbild“ abgetastet (alle 1 m längs, 0,5 m quer,
// ±HALF_WIDTH m). Je Querzeile wird die zusammenhängende Wasserfläche nahe der Linie bestimmt,
// darin gelten helle, kaum farbige Pixel als Weißwasser – die Schwelle richtet sich nach der
// Helligkeit des umgebenden Wassers (Schatten!). Der Weißwasser-Anteil je 10 m ergibt das
// Weißwasserprofil, zusammenhängende Strecken über der Schwelle werden zu Schwallstellen.
//
// Nur Bildquellen mit offener Lizenz, die eine Auswertung erlauben, und mit CORS-Freigabe.
// Esri/Google/Apple u. a. sind nur zur Anzeige lizenziert und werden hier nie ausgewertet.

import proj4 from "proj4";
import type { LngLat } from "./geo";
import { resample } from "./geo";

// ---------------------------------------------------------------------------------------------
// Bildquellen

export interface RGBA {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}
/** Dekodiert ein Kachelbild (JPEG/PNG) zu RGBA. Browser: Canvas, Node: jpeg-js. */
export type TileDecoder = (buf: ArrayBuffer) => Promise<RGBA>;

export interface OrthoSource {
  id: string;
  name: string;
  /** Pflicht-Namensnennung laut Lizenz */
  attribution: string;
  license: string;
  /** Aufnahmejahr(e), soweit bekannt */
  year: string;
  /** ungefähre Bodenauflösung in m */
  resolution: number;
  /** Esri-Metadaten mit diesem Anbieter beschreiben denselben Bildflug → Aufnahmetag übernehmen */
  esriMatch: RegExp;
  covers: (p: LngLat) => boolean;
  /** Pixelkoordinaten (Kachelstufe `level`, 256er-Kacheln) */
  toPixel: (p: LngLat) => [number, number];
  tileUrl: (x: number, y: number) => string;
}

const lonLatTo3857Px = (z: number) => (p: LngLat): [number, number] => {
  const n = 2 ** z * 256;
  const r = (p[1] * Math.PI) / 180;
  return [((p[0] + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
};

/** Grobe Landesgrenzen (Polygon) – vermeidet Abrufe außerhalb der Abdeckung. */
function inPoly(p: LngLat, poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// vereinfachte Umrisse (großzügig, ±5 km); Kacheln ohne Bild liefern ohnehin keine Wasserpixel
const AUSTRIA: LngLat[] = [
  [9.52, 47.27], [9.56, 47.55], [9.97, 47.55], [10.45, 47.58], [11.1, 47.4], [12.2, 47.61], [13.0, 47.47],
  [12.75, 48.12], [13.43, 48.57], [13.84, 48.78], [14.7, 48.59], [15.03, 49.02], [16.1, 48.75], [16.95, 48.62],
  [17.17, 48.0], [16.45, 47.69], [16.65, 47.43], [16.1, 46.85], [15.0, 46.6], [14.55, 46.37], [13.7, 46.52],
  [12.4, 46.65], [12.15, 47.0], [11.15, 46.93], [10.45, 46.83], [10.1, 46.84], [9.6, 47.05],
];
const SLOVENIA: LngLat[] = [
  [13.38, 46.53], [13.73, 46.55], [14.55, 46.4], [15.0, 46.65], [16.0, 46.85], [16.6, 46.48], [15.65, 46.2],
  [15.7, 45.83], [15.3, 45.7], [15.25, 45.45], [14.6, 45.6], [13.9, 45.43], [13.58, 45.47], [13.62, 45.77],
  [13.4, 46.2], [13.65, 46.43],
];

proj4.defs("EPSG:3794", "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const to3794 = proj4("EPSG:4326", "EPSG:3794");

export const ORTHO_SOURCES: OrthoSource[] = [
  {
    id: "basemap-at",
    name: "basemap.at Orthofoto (Österreich)",
    attribution: "Orthofoto: basemap.at",
    license: "CC BY 4.0",
    year: "lt. Bildaufdruck",
    resolution: 0.4,
    esriMatch: /Land |data\.gv\.at|BEV|basemap/i,
    covers: (p) => inPoly(p, AUSTRIA),
    toPixel: lonLatTo3857Px(18),
    tileUrl: (x, y) => `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/18/${y}/${x}.jpeg`,
  },
  {
    // GURS-Orthofoto DOF 2023 (CC BY 4.0), als Kachelcache (EPSG:3794) öffentlich auf dem
    // ArcGIS-Portal der slowenischen Finanzverwaltung (FURS); CORS freigegeben.
    id: "gurs-dof2023",
    name: "GURS DOF 2023 (Slowenien)",
    attribution: "Javne informacije Slovenije, Geodetska uprava RS, DOF 2023",
    license: "CC BY 4.0",
    year: "2023",
    resolution: 0.25,
    esriMatch: /GURS|Slovenia/i,
    covers: (p) => inPoly(p, SLOVENIA),
    toPixel: (p) => {
      const [x, y] = to3794.forward(p);
      const res = 0.26458319045841047; // Stufe 19
      return [(x + 5122600) / res, (5001100 - y) / res];
    },
    tileUrl: (x, y) => `https://gisportal.furs.gov.si/arcgis/rest/services/Hosted/DOF_2023/MapServer/tile/19/${y}/${x}`,
  },
];

const ICELAND: LngLat[] = [[-24.7, 63.2], [-13.3, 63.2], [-13.3, 66.7], [-24.7, 66.7]];
const tileBbox3857 = (x: number, y: number, z: number) => {
  const size = (2 * Math.PI * 6378137) / 2 ** z, o = Math.PI * 6378137;
  return [x * size - o, o - (y + 1) * size, (x + 1) * size - o, o - y * size].map((v) => v.toFixed(2)).join(",");
};
ORTHO_SOURCES.push({
  // Náttúrufræðistofnun (NÁTT, ehem. LMÍ): landesweites Luftbild-Mosaik ≥ 25 cm, CC BY 4.0, WMS (mapcache) mit CORS
  id: "natt-loftmynd",
  name: "NÁTT Grunnkort Loftmynd (Island)",
  attribution: "Náttúrufræðistofnun, Grunnkort – Loftmynd",
  license: "CC BY 4.0",
  year: "je nach Gebiet",
  resolution: 0.4,
  esriMatch: /^$/, // Esri zeigt in Island andere Bilder → Aufnahmetag unbekannt
  covers: (p) => inPoly(p, ICELAND),
  toPixel: lonLatTo3857Px(18),
  tileUrl: (x, y) =>
    `https://gis.natt.is/mapcache/web-mercator/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=grunnkort-loftmynd&STYLES=&SRS=EPSG:3857&BBOX=${tileBbox3857(x, y, 18)}&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg`,
});

export function orthoSourceFor(line: LngLat[]): OrthoSource | null {
  const pts = [line[0], line[Math.floor(line.length / 2)], line[line.length - 1]];
  return ORTHO_SOURCES.find((s) => pts.filter((p) => s.covers(p)).length >= 2) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Parameter

export interface WhitewaterParams {
  /** Weißwasserfläche je Flussmeter (m²/m, über 30 m geglättet), ab der eine Schwallstelle markiert wird */
  spotDensity: number;
  /** ab dieser Spitzendichte gilt die Stelle als „ausgeprägt“ */
  strongDensity: number;
  /** Mindestanteil Weißwasser an der Wasserfläche (über 30 m geglättet) */
  minFrac: number;
  /** Mindestfläche Weißwasser je Stelle in m² */
  minArea: number;
}
export const DEFAULT_PARAMS: WhitewaterParams = { spotDensity: 5, strongDensity: 8, minFrac: 0.18, minArea: 150 };

export const HALF_WIDTH = 30; // m quer zur Linie
export const ALONG = 1; // m
export const ACROSS = 0.5; // m
export const BIN = 10; // m

// ---------------------------------------------------------------------------------------------
// Pixelklassen

/** Wasserähnlich: bläulich/türkis/grünlich-blau, nicht Vegetation, nicht Kies (warm). */
export function isWaterLike(r: number, g: number, b: number): boolean {
  return b - r >= 6 && g - b <= 22;
}
/** Weißwasser: in allen Kanälen hell (Minimum ≥ `minThr`, 0–255), kaum gesättigt, nicht gelblich. */
export function isWhite(r: number, g: number, b: number, minThr: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mn >= minThr && (mx - mn) / Math.max(mx, 1) <= WHITE_MAX_SAT && b >= r - 4;
}
export const WHITE_MAX_SAT = 0.14;
/** Abstand der Weißwasser-Schwelle über dem hellen ruhigen Wasser (Minimum-Kanal) */
export const WHITE_MARGIN = 22;
export const WHITE_MIN = 150;
/** Mindest-Streuung (Standardabweichung des Minimum-Kanals) im Fenster 3 m × 3,5 m: Weißwasser ist
 *  körnig (Sanna: Median 12–14), glattes helles Wasser über Kalkgrund oder Gletschertrübe nicht (5–7). */
export const WHITE_MIN_TEXTURE = 9;

// ---------------------------------------------------------------------------------------------
// Streifenbild

export interface Strip {
  rows: number;
  cols: number;
  /** RGB je Zelle, 0/0/0 + valid=0 = keine Bilddaten */
  rgb: Uint8Array;
  valid: Uint8Array;
  /** Stationierung je Zeile (m) und Lage */
  d: Float64Array;
  p: LngLat[];
}

const M_PER_DEG_LAT = 110574;

export async function sampleStrip(
  line: LngLat[],
  src: OrthoSource,
  decode: TileDecoder,
  opts: { fetchFn?: typeof fetch; onProgress?: (done: number, total: number) => void; signal?: AbortSignal; maxTiles?: number } = {},
): Promise<Strip> {
  const fetchFn = opts.fetchFn ?? fetch;
  const samples = resample(line, ALONG);
  const rows = samples.length, cols = Math.round((2 * HALF_WIDTH) / ACROSS) + 1;
  // Richtung je Punkt über ±10 m geglättet
  const px = new Float64Array(rows * cols), py = new Float64Array(rows * cols);
  const tiles = new Map<string, RGBA | null>();
  for (let i = 0; i < rows; i++) {
    const a = samples[Math.max(0, i - 10)].p, b = samples[Math.min(rows - 1, i + 10)].p;
    const kx = Math.cos((samples[i].p[1] * Math.PI) / 180) * 111320;
    let ex = (b[0] - a[0]) * kx, ey = (b[1] - a[1]) * M_PER_DEG_LAT;
    const L = Math.hypot(ex, ey) || 1;
    ex /= L; ey /= L;
    // Normale (links der Fließrichtung)
    const nx = -ey, ny = ex;
    for (let c = 0; c < cols; c++) {
      const o = -HALF_WIDTH + c * ACROSS;
      const p: LngLat = [samples[i].p[0] + (nx * o) / kx, samples[i].p[1] + (ny * o) / M_PER_DEG_LAT];
      if (!src.covers(p) && (c === 0 || c === cols - 1)) { px[i * cols + c] = NaN; continue; }
      const [X, Y] = src.toPixel(p);
      px[i * cols + c] = X; py[i * cols + c] = Y;
      const key = `${Math.floor(X / 256)}/${Math.floor(Y / 256)}`;
      if (!tiles.has(key)) tiles.set(key, null);
    }
  }
  const keys = [...tiles.keys()];
  if (opts.maxTiles && keys.length > opts.maxTiles) throw new Error(`Strecke zu lang für die Weißwasser-Suche (${keys.length} Bildkacheln, max. ${opts.maxTiles}).`);
  let done = 0;
  const work = async (key: string) => {
    const [x, y] = key.split("/").map(Number);
    try {
      const r = await fetchFn(src.tileUrl(x, y), { signal: opts.signal });
      if (r.ok) tiles.set(key, await decode(await r.arrayBuffer()));
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
    opts.onProgress?.(++done, keys.length);
  };
  for (let i = 0; i < keys.length; i += 12) await Promise.all(keys.slice(i, i + 12).map(work));

  const rgb = new Uint8Array(rows * cols * 3), valid = new Uint8Array(rows * cols);
  for (let k = 0; k < rows * cols; k++) {
    const X = px[k], Y = py[k];
    if (!Number.isFinite(X)) continue;
    const t = tiles.get(`${Math.floor(X / 256)}/${Math.floor(Y / 256)}`);
    if (!t) continue;
    const ix = Math.min(255, Math.floor(X) & 255), iy = Math.min(255, Math.floor(Y) & 255);
    const o = (iy * t.width + ix) * 4;
    if (t.data[o + 3] === 0) continue; // transparent = außerhalb der Abdeckung
    const r = t.data[o], g = t.data[o + 1], b = t.data[o + 2];
    rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = b; valid[k] = 1;
  }
  return { rows, cols, rgb, valid, d: Float64Array.from(samples.map((s) => s.d)), p: samples.map((s) => s.p) };
}

// ---------------------------------------------------------------------------------------------
// Auswertung

export interface WhitewaterBin {
  d: number;
  /** Wasserpixel und Weißwasserpixel im 10-m-Abschnitt */
  water: number;
  white: number;
  /** Anteil Weißwasser an der Wasserfläche */
  frac: number;
  /** Anteil über 30 m geglättet */
  smooth: number;
  /** Weißwasserfläche je Flussmeter (m²/m), über 30 m geglättet */
  density: number;
  /** typische Wasserbreite (m), null = kein Wasser erkennbar */
  width: number | null;
  /** Anteil Zeilen mit Bilddaten */
  coverage: number;
}

export interface Profile {
  bins: WhitewaterBin[];
  /** Weißwasser-Maske je Zelle (für Vorschau/Debug) */
  white: Uint8Array;
  wet: Uint8Array;
  coverage: number;
}

const quantile = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Wasserfläche je Querzeile + Weißwasser mit lokaler Helligkeitsschwelle. */
export function whitewaterProfile(strip: Strip): Profile {
  const { rows, cols, rgb, valid } = strip;
  const wet = new Uint8Array(rows * cols), white = new Uint8Array(rows * cols);
  const V = (k: number) => Math.min(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]);
  // 1) Helligkeit des hellen ruhigen Wassers je 10 m (oberes Quartil wasserähnlicher Pixel nahe der
  //    Linie; Weißwasser selbst ist nicht „wasserähnlich“, Schatten fallen ins untere Quartil)
  const nb = Math.ceil((strip.d[rows - 1] + 1e-6) / BIN) + 1;
  const vals: number[][] = Array.from({ length: nb }, () => []);
  const c0 = Math.round(cols / 2), near = Math.round(15 / ACROSS);
  for (let i = 0; i < rows; i += 2) {
    const bi = Math.floor(strip.d[i] / BIN);
    for (let c = c0 - near; c <= c0 + near; c += 2) {
      const k = i * cols + c;
      if (valid[k] && isWaterLike(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2])) vals[bi].push(V(k));
    }
  }
  // über ±25 m zusammenfassen (stabiler)
  const medV = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const pool: number[] = [];
    for (let j = Math.max(0, b - 2); j <= Math.min(nb - 1, b + 2); j++) pool.push(...vals[j]);
    medV[b] = pool.length >= 20 ? quantile(pool, 0.75) : NaN;
  }
  const localStd = (i: number, c: number) => {
    let sum = 0, sq = 0, n = 0;
    for (let di = -1; di <= 1; di++) {
      const ii = i + di;
      if (ii < 0 || ii >= rows) continue;
      for (let dc = -3; dc <= 3; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= cols || !valid[ii * cols + cc]) continue;
        const v = V(ii * cols + cc);
        sum += v; sq += v * v; n++;
      }
    }
    return n > 4 ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : 0;
  };
  const thrOf = (b: number) => Math.min(235, Math.max(WHITE_MIN, (Number.isFinite(medV[b]) ? medV[b] : 120) + WHITE_MARGIN));
  // 2) je Zeile: Lauf aus Wasser-/Weißwasserpixeln, der der Linie am nächsten liegt (Lücken ≤ 2 m)
  const widths: number[][] = Array.from({ length: nb }, () => []);
  const rowsWithData = new Float64Array(nb), rowsAll = new Float64Array(nb);
  const gapMax = Math.round(2 / ACROSS);
  for (let i = 0; i < rows; i++) {
    const bi = Math.floor(strip.d[i] / BIN), thr = thrOf(bi);
    rowsAll[bi]++;
    const w = new Uint8Array(cols);
    let any = 0;
    for (let c = 0; c < cols; c++) {
      const k = i * cols + c;
      if (!valid[k]) continue;
      any++;
      const r = rgb[k * 3], g = rgb[k * 3 + 1], b = rgb[k * 3 + 2];
      if (isWhite(r, g, b, thr) && localStd(i, c) >= WHITE_MIN_TEXTURE) w[c] = 2;
      else if (isWaterLike(r, g, b)) w[c] = 1;
    }
    if (any < cols / 2) continue;
    rowsWithData[bi]++;
    // Läufe mit Lückentoleranz
    let best: [number, number] | null = null, bestScore = -Infinity;
    for (let c = 0; c < cols; ) {
      if (!w[c]) { c++; continue; }
      let e = c, gap = 0, last = c;
      while (e < cols && gap <= gapMax) { if (w[e]) { last = e; gap = 0; } else gap++; e++; }
      const len = last - c + 1;
      const dist = c <= c0 && last >= c0 ? 0 : Math.min(Math.abs(c - c0), Math.abs(last - c0));
      const score = len - dist * 1.5;
      if (len * ACROSS >= 3 && score > bestScore) { bestScore = score; best = [c, last]; }
      c = last + 1;
    }
    if (!best || bestScore < 0) continue;
    widths[bi].push((best[1] - best[0] + 1) * ACROSS);
    for (let c = best[0]; c <= best[1]; c++) {
      const k = i * cols + c;
      if (!w[c]) continue;
      wet[k] = 1;
      if (w[c] === 2) white[k] = 1;
    }
  }
  // 3) Weißwasser nur zählen, wo es körnig ist: isolierte große einfarbige Flächen (Brücken,
  //    Dächer) haben kaum Wasser in der Nachbarschaft → Zellen ohne Wasser-Nachbarn ±3 m verwerfen
  const R = Math.round(3 / ACROSS);
  for (let i = 0; i < rows; i++) for (let c = 0; c < cols; c++) {
    const k = i * cols + c;
    if (!white[k]) continue;
    let waterN = 0;
    for (let di = -R; di <= R && !waterN; di += 2) for (let dc = -R; dc <= R; dc += 2) {
      const ii = i + di * 0.5 | 0, cc = c + dc;
      if (ii < 0 || ii >= rows || cc < 0 || cc >= cols) continue;
      const kk = ii * cols + cc;
      if (wet[kk] && !white[kk]) { waterN++; break; }
    }
    if (!waterN) white[k] = 0;
  }
  const water = new Float64Array(nb), wh = new Float64Array(nb);
  for (let i = 0; i < rows; i++) {
    const bi = Math.floor(strip.d[i] / BIN);
    for (let c = 0; c < cols; c++) { const k = i * cols + c; if (wet[k]) { water[bi]++; if (white[k]) wh[bi]++; } }
  }
  const cell = ALONG * ACROSS;
  const bins: WhitewaterBin[] = [];
  for (let b = 0; b < nb; b++) {
    const frac = water[b] * cell >= 15 ? wh[b] / water[b] : 0;
    bins.push({ d: b * BIN, water: water[b] * cell, white: wh[b] * cell, frac, smooth: 0, density: 0, width: widths[b].length ? median(widths[b]) : null, coverage: rowsAll[b] ? rowsWithData[b] / rowsAll[b] : 0 });
  }
  for (let b = 0; b < nb; b++) {
    let w = 0, s = 0, n = 0;
    for (let j = Math.max(0, b - 1); j <= Math.min(nb - 1, b + 1); j++) { s += bins[j].white; w += bins[j].water; n++; }
    bins[b].smooth = w > 0 ? s / w : 0;
    bins[b].density = s / (n * BIN);
  }
  const cov = rowsAll.reduce((x, y) => x + y, 0);
  return { bins, white, wet, coverage: cov ? rowsWithData.reduce((x, y) => x + y, 0) / cov : 0 };
}

export interface WhitewaterSpot {
  d0: number;
  d1: number;
  /** Stelle mit dem höchsten Anteil */
  dPeak: number;
  center: LngLat;
  peakFrac: number;
  meanFrac: number;
  /** höchste Weißwasserdichte (m²/m) */
  peakDensity: number;
  /** Weißwasserfläche in m² */
  area: number;
  width: number | null;
  strong: boolean;
  /** Zusatzmerkmale (falls Profil/Linie übergeben) */
  bend?: number;
  narrowing?: number;
  gradient?: number;
  /** liegt an einer Abbruchkante (siehe findBreaklines) */
  hazard?: boolean;
  notes: string[];
}

/** Schwallstellen aus dem Weißwasserprofil. */
export function findSpots(bins: WhitewaterBin[], params: WhitewaterParams = DEFAULT_PARAMS): Omit<WhitewaterSpot, "center" | "notes">[] {
  const out: Omit<WhitewaterSpot, "center" | "notes">[] = [];
  let cur: { b0: number; b1: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const sel = bins.slice(cur.b0, cur.b1 + 1);
    const area = sel.reduce((s, b) => s + b.white, 0), water = sel.reduce((s, b) => s + b.water, 0);
    const peak = sel.reduce((m, b) => (b.density > m.density ? b : m), sel[0]);
    const ws = sel.map((b) => b.width).filter((w): w is number => w !== null);
    if (area >= params.minArea)
      out.push({
        d0: bins[cur.b0].d, d1: bins[cur.b1].d + BIN, dPeak: peak.d + BIN / 2, peakFrac: peak.smooth, meanFrac: water ? area / water : 0, peakDensity: peak.density, area,
        width: ws.length ? median(ws) : null, strong: peak.density >= params.strongDensity,
      });
    cur = null;
  };
  const GAP = 5; // Bins (50 m) Lücke zusammenfassen
  let gap = 0;
  for (let b = 0; b < bins.length; b++) {
    if (bins[b].density >= params.spotDensity && bins[b].smooth >= params.minFrac) {
      if (!cur) cur = { b0: b, b1: b };
      else cur.b1 = b;
      gap = 0;
    } else if (cur && ++gap > GAP) flush();
  }
  flush();
  return out;
}

/** Richtungsänderung (Grad) über ±40 m an Stationierung d. */
export function bendAt(strip: Pick<Strip, "d" | "p">, d: number, half = 40): number {
  const idx = (x: number) => Math.max(0, Math.min(strip.d.length - 1, Math.round(x / ALONG)));
  const a = strip.p[idx(d - half)], m = strip.p[idx(d)], b = strip.p[idx(d + half)];
  const k = Math.cos((m[1] * Math.PI) / 180);
  const h1 = Math.atan2((m[1] - a[1]), (m[0] - a[0]) * k), h2 = Math.atan2((b[1] - m[1]), (b[0] - m[0]) * k);
  let dh = ((h2 - h1) * 180) / Math.PI;
  while (dh > 180) dh -= 360;
  while (dh < -180) dh += 360;
  return Math.abs(dh);
}

export interface WhitewaterResult {
  source: OrthoSource;
  spots: WhitewaterSpot[];
  bins: WhitewaterBin[];
  coverage: number;
  params: WhitewaterParams;
}

/** Merkmale ergänzen: Kurve, Verengung, lokales Gefälle, Zusammenfallen mit Steilstufen. */
export function describeSpots(
  raw: Omit<WhitewaterSpot, "center" | "notes">[],
  strip: Pick<Strip, "d" | "p">,
  bins: WhitewaterBin[],
  ctx: { gradientAt?: (d: number) => number; steps?: { d0: number; d1: number }[] } = {},
): WhitewaterSpot[] {
  return raw.map((s) => {
    const center = strip.p[Math.max(0, Math.min(strip.p.length - 1, Math.round(s.dPeak / ALONG)))];
    let bend = 0;
    for (let d = s.d0 - 50; d <= s.d1 + 120; d += 10) bend = Math.max(bend, bendAt(strip, d, 50));
    const around = bins.filter((b) => b.width !== null && Math.abs(b.d - s.dPeak) <= 500 && (b.d < s.d0 - 50 || b.d > s.d1 + 50)).map((b) => b.width as number);
    const typical = around.length >= 5 ? median(around) : null;
    const narrowing = typical && s.width ? s.width / typical : undefined;
    const gradient = ctx.gradientAt?.(s.dPeak);
    const hazard = (ctx.steps ?? []).some((st) => st.d1 >= s.d0 - 50 && st.d0 <= s.d1 + 50);
    const notes: string[] = [];
    if (bend >= 60) notes.push(`in scharfer Kurve (${Math.round(bend)}°)`);
    if (narrowing !== undefined && narrowing <= 0.7) notes.push(`Flussbett verengt (~${Math.round(narrowing * 100)} % der üblichen Breite)`);
    if (gradient !== undefined && gradient >= 30) notes.push(`steil (${Math.round(gradient)} m/km)`);
    if (hazard) notes.push("an einer möglichen Abbruchkante (Wasserfall/Stufe/Wehr)");
    return { ...s, center, bend, narrowing, gradient, hazard, notes };
  });
}

// ---------------------------------------------------------------------------------------------
// Lernen aus eigenen Markierungen

export interface WhitewaterLabel {
  p: LngLat;
  /** true = Schwallstelle, false = keine */
  schwall: boolean;
  note?: string;
  date?: string;
}

/** Merkmal einer Markierung: höchste Weißwasserdichte (m²/m) im Umkreis ±30 m (Stationierung). */
export function labelFeature(bins: WhitewaterBin[], d: number): number {
  return bins.filter((b) => Math.abs(b.d + BIN / 2 - d) <= 30).reduce((m, b) => Math.max(m, b.density), 0);
}

/**
 * Schwelle aus Markierungen anpassen: wählt die Schwelle, die positive und negative Beispiele
 * am besten trennt (ausgewogene Trefferquote). Nur positive → knapp unter dem schwächsten.
 */
export function fitParams(samples: { f: number; schwall: boolean }[], base: WhitewaterParams = DEFAULT_PARAMS): WhitewaterParams {
  const pos = samples.filter((s) => s.schwall).map((s) => s.f), neg = samples.filter((s) => !s.schwall).map((s) => s.f);
  if (!pos.length) {
    if (!neg.length) return base;
    return { ...base, spotDensity: clamp(Math.max(base.spotDensity, Math.max(...neg) * 1.1)) };
  }
  if (!neg.length) return { ...base, spotDensity: clamp(Math.min(base.spotDensity, Math.min(...pos) * 0.9)) };
  const cands = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = base.spotDensity, bestScore = -1;
  for (let i = 0; i <= cands.length; i++) {
    const t = i === 0 ? cands[0] * 0.9 : i === cands.length ? cands[i - 1] * 1.1 : (cands[i - 1] + cands[i]) / 2;
    const tp = pos.filter((f) => f >= t).length / pos.length, tn = neg.filter((f) => f < t).length / neg.length;
    const score = tp + tn - Math.abs(t - base.spotDensity) * 0.001; // bei Gleichstand nahe am Standard bleiben
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return { ...base, spotDensity: clamp(best) };
}
const clamp = (t: number) => Math.min(20, Math.max(0.5, t));

// ---------------------------------------------------------------------------------------------
// Abbruchkanten (Wasserfall, Stufe, Wehr): scharf einsetzendes Weißwasser/Gischt + Höhenverlust
//
// Trainiert an Selfoss, Dettifoss, Hafragilsfoss (Jökulsá á Fjöllum, NÁTT-Luftbild) und
// Gegenbeispielen ohne Kante (Pianser Schwall, Sanna-Oberlauf, Soča-Blockstrecke, Stromschnellen
// zwischen Selfoss und Dettifoss mit Höhenmodell-Artefakt). Gischt ist glatt – deshalb hier ohne
// Textur- und ohne Wasserfarben-Kriterium (Gletscherwasser ist grau), nur in der Flussmitte.

export interface BreakParams {
  /** Mindestsprung des Weißanteils (Flussmitte) von oberhalb nach unterhalb der Kante */
  minJump: number;
  /** Weißanteil unmittelbar unterhalb der Kante */
  minBelow: number;
  /** Mindest-Höhenverlust (m) zwischen 60 m oberhalb und 30 m unterhalb der Kante */
  minDrop: number;
}
export const DEFAULT_BREAK: BreakParams = { minJump: 0.4, minBelow: 0.5, minDrop: 5 };
/** Weiß für Gischt/Schaum: Minimum-Kanal ≥ 165, Sättigung ≤ 0,14 */
export const SPRAY_MIN = 165;

export interface Breakline {
  d: number;
  center: LngLat;
  /** Weißanteil 15 m oberhalb / unterhalb */
  above: number;
  below: number;
  /** Höhenverlust (m) laut Höhenmodell, und davon über dem örtlichen Gefälle */
  drop: number;
  excess: number;
  /** deutlich: scharfe Kante und ≥ 10 m Höhenverlust */
  confidence: "deutlich" | "möglich";
}

/** Weißanteil je Meter in der Flussmitte (±8 m um die Linie). NaN = keine Bilddaten. */
export function centerWhite(strip: Strip, half = 8): Float64Array {
  const out = new Float64Array(strip.rows).fill(NaN);
  const c0 = Math.round(strip.cols / 2), band = Math.round(half / ACROSS);
  for (let i = 0; i < strip.rows; i++) {
    let w = 0, n = 0;
    for (let c = c0 - band; c <= c0 + band; c++) {
      const k = i * strip.cols + c;
      if (!strip.valid[k]) continue;
      const r = strip.rgb[k * 3], g = strip.rgb[k * 3 + 1], b = strip.rgb[k * 3 + 2];
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      n++;
      if (mn >= SPRAY_MIN && (mx - mn) / Math.max(mx, 1) <= 0.14) w++;
    }
    if (n >= band) out[i] = w / n;
  }
  return out;
}

const meanRange = (a: Float64Array, i0: number, i1: number) => {
  let s = 0, n = 0;
  for (let i = Math.max(0, i0); i < Math.min(a.length, i1); i++) if (Number.isFinite(a[i])) { s += a[i]; n++; }
  return n >= (i1 - i0) / 2 ? s / n : NaN;
};

/**
 * Abbruchkanten: Weißwasser/Gischt setzt entlang des Flusses schlagartig ein (Sprung ≥ minJump
 * auf 15 m, unterhalb ≥ minBelow) UND das Höhenmodell zeigt dort Höhenverlust ≥ minDrop.
 * `zAt(d)` = monoton fallendes, ungeglättetes Profil (Talboden) an Stationierung d.
 */
export function findBreaklines(strip: Strip, zAt: (d: number) => number, params: BreakParams = DEFAULT_BREAK): Breakline[] {
  const wf = centerWhite(strip);
  const L = 15;
  const cand: { i: number; jump: number; above: number; below: number }[] = [];
  for (let i = L; i < strip.rows - L; i++) {
    const above = meanRange(wf, i - L, i), below = meanRange(wf, i, i + L);
    if (!Number.isFinite(above) || !Number.isFinite(below)) continue;
    const jump = below - above;
    if (jump >= params.minJump && below >= params.minBelow) cand.push({ i, jump, above, below });
  }
  // je Häufung nur das stärkste Maximum
  const peaks: typeof cand = [];
  for (const c of cand) {
    const last = peaks[peaks.length - 1];
    if (last && c.i - last.i < 60) { if (c.jump > last.jump) peaks[peaks.length - 1] = c; }
    else peaks.push(c);
  }
  const total = strip.d[strip.rows - 1];
  const out: Breakline[] = [];
  for (const pk of peaks) {
    const d = strip.d[pk.i];
    const drop = zAt(Math.max(0, d - 60)) - zAt(Math.min(total, d + 30));
    const regional = (zAt(Math.max(0, d - 500)) - zAt(Math.min(total, d + 500))) / Math.max(1, Math.min(total, d + 500) - Math.max(0, d - 500));
    const excess = drop - regional * 90;
    if (drop < params.minDrop || excess < params.minDrop * 0.6) continue;
    out.push({
      d, center: strip.p[pk.i], above: pk.above, below: pk.below, drop, excess,
      confidence: pk.jump >= 0.6 && drop >= 10 ? "deutlich" : "möglich",
    });
  }
  return out;
}
