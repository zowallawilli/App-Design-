// Flusslauf zwischen Ein- und Ausstieg automatisch nachziehen.
//
// Verfahren: kostengünstigster Weg (Dijkstra) über ein Raster, dessen Kosten aus
// mehreren Quellen kombiniert werden:
//  1. Höhenmodell – Zellen nahe dem lokalen Talboden sind billig, Hänge teuer,
//     bergauf fließen kostet extra.
//  2. Sentinel-2 – Zellen mit Wassersignal (NDWI) sind billig.
//  3. OpenStreetMap – kartierte Gewässerlinien werden ins Raster „eingebrannt“.
// Fehlt eine Quelle, arbeiten die übrigen allein weiter.

import { cumulative, haversine, type LngLat } from "./geo";
import { lngLatToPixel, metersPerPixel, type TileLoader } from "./dem";
import { loadGrid, MinHeap, pixelToLngLat, type Grid } from "./flow";

/** Kostenfaktoren für Wasser bzw. unbewachsenes Flussbett (kleiner = stärker bevorzugt) */
export const WATER_MIN = 0.04;
export const BARE_MIN = 0.12;

export interface RouteInputs {
  /** Gewässerlinien im Ausschnitt (OSM), optional mit Namen */
  waterways?: (bbox: [number, number, number, number]) => Promise<{ name?: string; coords: LngLat[] }[]>;
  /** NDWI je Rasterzelle (NaN = keine Daten) */
  water?: (grid: Grid) => Promise<{ ndwi: Float32Array; ndvi?: Float32Array; label: string } | null>;
  loader?: TileLoader;
  maxZoom?: number;
  maxCells?: number;
  onProgress?: (msg: string) => void;
  /** nur für Tests/Diagnose: Zugriff auf Raster und Kosten */
  debug?: (g: Grid, cost: Float32Array, path: number[], layers: CostLayers & { demTrust: Float32Array }) => void;
}

export interface RouteResult {
  line: LngLat[];
  /** genutzte Quellen, z. B. ["OSM", "Sentinel-2 (2025-08-14)", "Höhenmodell"] */
  sources: string[];
  /** Anteil der Strecke auf OSM-Linien bzw. auf Wasser-/Flussbett-Pixeln aus Sentinel-2 (0–1) */
  shareOsm: number;
  shareWater: number;
  /** Rasterauflösung in m */
  resolution: number;
  reversed: boolean;
}

/** Laufendes Minimum über ein Fenster ±r (eindimensional, O(n·r) ausreichend für kleine r). */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.min(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.min(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/** Zeichnet eine Linie ins Raster (Bresenham), Wert = min(bestehend, v). */
function burnLine(mask: Float32Array, g: Grid, coords: LngLat[], v: number) {
  let prev: [number, number] | null = null;
  for (const c of coords) {
    const [px, py] = lngLatToPixel(c, g.z);
    const cur: [number, number] = [Math.floor(px - g.x0), Math.floor(py - g.y0)];
    if (prev) {
      let [x0, y0] = prev;
      const [x1, y1] = cur;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 100000; guard++) {
        if (x0 >= 0 && y0 >= 0 && x0 < g.w && y0 < g.h) mask[y0 * g.w + x0] = Math.min(mask[y0 * g.w + x0], v);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    prev = cur;
  }
}

export interface CostLayers {
  /** Höhe über lokalem Talboden (m) */
  hand: Float32Array;
  /** Multiplikator Wasser (Sentinel-2), 1 = kein Wasser */
  water: Float32Array;
  /** Multiplikator OSM, 1 = keine Linie */
  osm: Float32Array;
}

/**
 * Kosten je Zelle und „Vertrauen ins Höhenmodell“ (0–1). Je deutlicher Satellit oder
 * OSM ein Gewässer zeigen, desto weniger zählt das Höhenmodell – es ist in Schluchten
 * oft um einige Pixel verschoben.
 */
export function buildCost(g: Grid, layers: CostLayers): { cost: Float32Array; demTrust: Float32Array } {
  const cost = new Float32Array(g.w * g.h);
  const demTrust = new Float32Array(g.w * g.h);
  for (let i = 0; i < cost.length; i++) {
    const sat = layers.water[i] * layers.osm[i];
    const k = Math.min(1, sat) ** 4;
    demTrust[i] = k;
    // Höhe über Talboden: moderat steigende Strafe (max. ×11), damit einzelne falsch
    // eingeordnete Zellen den Weg nicht blockieren
    cost[i] = (1 + (Math.min(30, layers.hand[i]) / 3) * k) * sat;
  }
  return { cost, demTrust };
}

/** Dijkstra von a nach b (Zellindizes). Liefert Zellfolge oder null. */
export function leastCostPath(g: Grid, cost: Float32Array, a: number, b: number, uphillPenalty = 2, demTrust?: Float32Array): number[] | null {
  const n = g.w * g.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(1 << 16);
  dist[a] = 0;
  heap.push(0, a);
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy = [-1, -1, -1, 0, 0, 1, 1, 1];
  const len = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === b) break;
    const cx = c % g.w, cy = (c - cx) / g.w;
    for (let k = 0; k < 8; k++) {
      const nx = cx + dx[k], ny = cy + dy[k];
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const ni = ny * g.w + nx;
      if (done[ni]) continue;
      // bergauf kostet extra – abgeschwächt, wo Satellit/OSM eindeutig ein Gewässer zeigen
      const up = Math.max(0, g.elev[ni] - g.elev[c]) * (demTrust ? demTrust[ni] : 1);
      const d = dist[c] + len[k] * (cost[c] + cost[ni]) * 0.5 + uphillPenalty * up;
      if (d < dist[ni]) {
        dist[ni] = d;
        prev[ni] = c;
        heap.push(d, ni);
      }
    }
  }
  if (prev[b] < 0 && a !== b) return null;
  const path: number[] = [];
  for (let c = b; c >= 0; c = prev[c]) {
    path.push(c);
    if (c === a) break;
  }
  return path.reverse();
}

/** Billigste Zelle im Umkreis r (Zellen) um einen Punkt. */
function snap(g: Grid, cost: Float32Array, p: LngLat, r: number): number {
  const [fx, fy] = lngLatToPixel(p, g.z);
  const sx = Math.floor(fx - g.x0), sy = Math.floor(fy - g.y0);
  let best = sy * g.w + sx, bestC = Infinity;
  for (let y = Math.max(0, sy - r); y <= Math.min(g.h - 1, sy + r); y++)
    for (let x = Math.max(0, sx - r); x <= Math.min(g.w - 1, sx + r); x++) {
      const d2 = (x - sx) ** 2 + (y - sy) ** 2;
      if (d2 > r * r) continue;
      const c = cost[y * g.w + x] * (1 + d2 / (r * r)); // Nähe zum Klick leicht bevorzugen
      if (c < bestC) { bestC = c; best = y * g.w + x; }
    }
  return best;
}

/**
 * Zieht den Flusslauf zwischen Ein- und Ausstieg nach. Läuft der gefundene Weg am
 * Rand des Ausschnitts entlang (Fluss macht einen großen Bogen), wird der Ausschnitt
 * vergrößert und neu gerechnet.
 */
export async function traceRiver(putIn: LngLat, takeOut: LngLat, inpIn: RouteInputs = {}): Promise<RouteResult> {
  const inp = { ...inpIn, waterways: inpIn.waterways && sharedWaterways(inpIn.waterways) };
  const spanKm = haversine(putIn, takeOut) / 1000;
  // Flüsse mäandern: Ausschnitt deutlich größer als die Luftlinie
  let marginDeg = Math.max(0.015, (spanKm / 111) * 0.4);
  let res: RouteResult & { touchesEdge: boolean } = await traceOnce(putIn, takeOut, inp, marginDeg);
  for (let attempt = 0; attempt < 2 && res.touchesEdge; attempt++) {
    marginDeg *= 2;
    inp.onProgress?.("Fluss verlässt den Ausschnitt – größeren Bereich berechnen …");
    res = await traceOnce(putIn, takeOut, inp, marginDeg);
  }
  const { touchesEdge: _ignored, ...coarse } = res;
  if (coarse.resolution <= REFINE_ABOVE_M) return coarse;

  // Lange Strecke: grob gefundenen Verlauf in Stücke teilen und jedes Stück fein nachziehen
  const cum = cumulative(coarse.line);
  const total = cum[cum.length - 1];
  const pieces = Math.max(2, Math.ceil(total / (REFINE_PIECE_KM * 1000)));
  const cut = (k: number) => coarse.line[cum.findIndex((d) => d >= (total * k) / pieces)] ?? coarse.line[coarse.line.length - 1];
  const parts: RouteResult[] = [];
  for (let k = 0; k < pieces; k++) {
    const a = k === 0 ? putIn : cut(k), b = k === pieces - 1 ? takeOut : cut(k + 1);
    const say = (m: string) => inp.onProgress?.(`Feinabgleich ${k + 1}/${pieces}: ${m}`);
    try {
      const span = haversine(a, b) / 1000;
      const r = await traceOnce(a, b, { ...inp, onProgress: say }, Math.max(0.012, (span / 111) * 0.4));
      parts.push(r);
    } catch {
      // Stück nicht verfeinerbar → groben Verlauf übernehmen
      const i0 = cum.findIndex((d) => d >= (total * k) / pieces), i1 = cum.findIndex((d) => d >= (total * (k + 1)) / pieces);
      parts.push({ ...coarse, line: coarse.line.slice(i0, i1 < 0 ? undefined : i1 + 1) });
    }
  }
  const lens = parts.map((p) => cumulative(p.line).at(-1) ?? 0);
  const sum = lens.reduce((x, y) => x + y, 0) || 1;
  const wavg = (f: (p: RouteResult) => number) => parts.reduce((acc, p, i) => acc + f(p) * lens[i], 0) / sum;
  return {
    line: parts.flatMap((p, i) => (i === 0 ? p.line : p.line.slice(1))),
    sources: mergeSources(parts.flatMap((p) => p.sources), Math.max(...parts.map((p) => p.resolution))),
    shareOsm: wavg((p) => p.shareOsm),
    shareWater: wavg((p) => p.shareWater),
    resolution: Math.max(...parts.map((p) => p.resolution)),
    reversed: coarse.reversed,
  };
}

/** Höchstens so lange wird auf OSM-Gewässer gewartet (ms); danach ohne OSM weiter. */
export const OSM_TIMEOUT = 8000;

/**
 * Gewässerlinien nur einmal für den größten Ausschnitt laden; Teilstücke beim Feinabgleich
 * nutzen dieselben Daten. Antwortet OSM nicht rechtzeitig, wird ohne OSM gerechnet.
 */
function sharedWaterways(fetchWays: NonNullable<RouteInputs["waterways"]>): NonNullable<RouteInputs["waterways"]> {
  let loaded: { bbox: [number, number, number, number]; ways: Promise<{ name?: string; coords: LngLat[] }[] | null> } | null = null;
  return async (bbox) => {
    const inside = loaded && loaded.bbox[0] <= bbox[0] && loaded.bbox[1] <= bbox[1] && loaded.bbox[2] >= bbox[2] && loaded.bbox[3] >= bbox[3];
    if (!inside) {
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), OSM_TIMEOUT));
      loaded = { bbox, ways: Promise.race([fetchWays(bbox).catch(() => null), timeout]) };
    }
    const ways = await loaded!.ways;
    if (!ways) throw new Error("OSM nicht verfügbar");
    return ways;
  };
}

/** Ab dieser Rastergröße (m) wird eine lange Strecke stückweise fein nachgezogen. */
export const REFINE_ABOVE_M = 10;
/** Länge der Stücke beim Feinabgleich (km). */
export const REFINE_PIECE_KM = 6;

async function traceOnce(putIn: LngLat, takeOut: LngLat, inp: RouteInputs, marginDeg: number): Promise<RouteResult & { touchesEdge: boolean }> {
  const say = inp.onProgress ?? (() => {});
  const bbox: [number, number, number, number] = [
    Math.min(putIn[0], takeOut[0]) - marginDeg / Math.cos((putIn[1] * Math.PI) / 180),
    Math.min(putIn[1], takeOut[1]) - marginDeg,
    Math.max(putIn[0], takeOut[0]) + marginDeg / Math.cos((putIn[1] * Math.PI) / 180),
    Math.max(putIn[1], takeOut[1]) + marginDeg,
  ];

  say("Höhenmodell laden …");
  const osmPromise = inp.waterways ? inp.waterways(bbox).catch(() => null) : Promise.resolve(null);
  const g = await loadGrid(bbox, inp.loader, inp.maxCells ?? 3_000_000, inp.maxZoom ?? 15, (d, t) => say(`Höhenmodell ${Math.round((d / t) * 100)} %`));
  const mpp = metersPerPixel((bbox[1] + bbox[3]) / 2, g.z);
  const n = g.w * g.h;

  // 1) Höhe über lokalem Talboden (Radius ~ 60 m)
  say("Talboden berechnen …");
  const r = Math.max(2, Math.round(60 / mpp));
  const floor = minFilter(g.elev, g.w, g.h, r);
  const hand = new Float32Array(n);
  for (let i = 0; i < n; i++) hand[i] = g.elev[i] - floor[i];

  // 2) Sentinel-2
  const sources: string[] = [];
  const water = new Float32Array(n).fill(1);
  let haveSat = false;
  if (inp.water) {
    say("Sentinel-2-Szene suchen …");
    try {
      const w = await inp.water(g);
      if (w) {
        haveSat = true;
        for (let i = 0; i < n; i++) {
          const v = w.ndwi[i];
          if (Number.isNaN(v)) continue;
          // Wasser: NDWI −0,1 … 0,2 → Multiplikator 1 … WATER_MIN
          const tw = Math.min(1, Math.max(0, (v + 0.1) / 0.3));
          let m = 1 - (1 - WATER_MIN) * tw;
          // Unbewachsenes Flussbett (Kies, Fels, Wildwasser) im Talboden: NDVI 0,45 … 0,15 → 1 … BARE_MIN.
          // Nur bis 40 m über dem (in Schluchten oft verschobenen) Talboden des Höhenmodells, damit Geröllhalden weiter oben nicht anziehen.
          const nd = w.ndvi?.[i];
          if (nd !== undefined && !Number.isNaN(nd) && hand[i] < 40) {
            const tb = Math.min(1, Math.max(0, (0.4 - nd) / 0.3));
            m = Math.min(m, 1 - (1 - BARE_MIN) * tb);
          }
          // dichter Bewuchs (Wald) ist selten Flussbett
          if (nd !== undefined && nd > 0.65) m *= 1.5;
          water[i] = m;
        }
        // Lücken durch Mischpixel (Bäume über dem Flussbett) schließen
        water.set(minFilter(water, g.w, g.h, Math.max(1, Math.round(5 / mpp))));
        sources.push(`Sentinel-2 (${w.label})`);
      }
    } catch (e) {
      say(`Sentinel-2 nicht verfügbar (${(e as Error).message})`);
    }
  }

  // 3) OSM
  say("Gewässerlinien abwarten …");
  const osm = new Float32Array(n).fill(1);
  const ways = await osmPromise;
  let osmMask: Uint8Array | null = null;
  if (ways && ways.length) {
    // Gewässer, das Ein- und Ausstieg am nächsten liegt, bekommt Vorrang
    const nearestName = (p: LngLat) => {
      let best = { d: Infinity, name: undefined as string | undefined };
      for (const w of ways) for (const c of w.coords) {
        const d = haversine(c, p);
        if (d < best.d) best = { d, name: w.name };
      }
      return best;
    };
    const na = nearestName(putIn), nb = nearestName(takeOut);
    const main = new Set([na.d < 300 ? na.name : undefined, nb.d < 300 ? nb.name : undefined].filter(Boolean));
    for (const w of ways) burnLine(osm, g, w.coords, w.name && main.has(w.name) ? 0.03 : 0.3);
    osmMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (osm[i] < 1) osmMask[i] = 1;
    sources.push("OpenStreetMap");
  }
  sources.push(`Höhenmodell (${mpp.toFixed(1)} m)`);

  const { cost, demTrust } = buildCost(g, { hand, water, osm });
  const snapR = Math.max(2, Math.round(80 / mpp));
  let a = snap(g, cost, putIn, snapR);
  let b = snap(g, cost, takeOut, snapR);

  // Fließrichtung: Einstieg soll höher liegen; sonst intern tauschen
  let reversed = false;
  if (g.elev[a] < g.elev[b] - 2) {
    [a, b] = [b, a];
    reversed = true;
  }

  say("Flusslauf suchen …");
  const path = leastCostPath(g, cost, a, b, 2, demTrust);
  if (!path || path.length < 2) throw new Error("Kein zusammenhängender Flusslauf zwischen Ein- und Ausstieg gefunden.");

  inp.debug?.(g, cost, path, { hand, water, osm, demTrust });
  const edge = 2;
  const touchesEdge = path.some((c) => {
    const x = c % g.w, y = (c - x) / g.w;
    return x < edge || y < edge || x >= g.w - edge || y >= g.h - edge;
  });
  let onOsm = 0, onWater = 0;
  for (const c of path) {
    if (osmMask?.[c]) onOsm++;
    if (haveSat && water[c] < 0.5) onWater++;
  }

  // Treppen glätten (gleitendes Mittel über 5 Zellen), Endpunkte bleiben
  const pts = path.map((c) => [c % g.w, Math.floor(c / g.w)] as [number, number]);
  let line = pts.map((_, k) => {
    const h = Math.min(2, k, pts.length - 1 - k);
    let sx = 0, sy = 0;
    for (let j = k - h; j <= k + h; j++) { sx += pts[j][0]; sy += pts[j][1]; }
    const m = 2 * h + 1;
    return pixelToLngLat(g.x0 + sx / m + 0.5, g.y0 + sy / m + 0.5, g.z);
  });
  if (reversed) line = line.reverse();

  return {
    line,
    sources,
    shareOsm: onOsm / path.length,
    shareWater: onWater / path.length,
    resolution: mpp,
    reversed,
    touchesEdge,
  };
}

/** Quellen der Teilstücke zusammenfassen: alle Sentinel-2-Daten in einem Eintrag. */
function mergeSources(all: string[], resolution: number): string[] {
  const dates = [...new Set(all.filter((x) => x.startsWith("Sentinel-2")).flatMap((x) => x.slice(12, -1).split(", ")))].sort();
  return [
    ...(dates.length ? [`Sentinel-2 (${dates.join(", ")})`] : []),
    ...(all.includes("OpenStreetMap") ? ["OpenStreetMap"] : []),
    `Höhenmodell (${resolution.toFixed(1)} m)`,
  ];
}
