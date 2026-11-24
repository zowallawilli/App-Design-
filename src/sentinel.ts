// Wasserflächen aus Sentinel-2 (ESA Copernicus, 10 m) über den freien STAC-Katalog von Element 84 (AWS Open Data).
// Berechnet wird der NDWI = (Grün − NIR) / (Grün + NIR); Wasser hat positive Werte.

import proj4 from "proj4";
import type { Grid } from "./flow";

export const STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search";

export interface Scene {
  id: string;
  /** Umriss der Kachel [W, S, O, N] */
  bbox: [number, number, number, number];
  date: string;
  cloud: number;
  epsg: number;
  green: string;
  red: string;
  nir: string;
}

interface StacFeature {
  id: string;
  bbox: [number, number, number, number];
  properties: Record<string, unknown>;
  assets: Record<string, { href: string }>;
}

/**
 * Sucht wolkenarme Sommerszenen (Sommer, damit Schnee nicht als Wasser erscheint),
 * die zusammen den Ausschnitt abdecken. Liegt der Ausschnitt über einer
 * Kachelgrenze, werden mehrere Szenen kombiniert (bevorzugt vom selben Tag).
 */
export async function findScenes(bbox: [number, number, number, number], fetchFn: typeof fetch = fetch): Promise<Scene[]> {
  const now = new Date();
  const from = new Date(now.getFullYear() - 3, 0, 1).toISOString();
  const res = await fetchFn(STAC_SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collections: ["sentinel-2-l2a"],
      bbox,
      datetime: `${from}/${now.toISOString()}`,
      query: { "eo:cloud_cover": { lt: 10 } },
      sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
      limit: 100,
    }),
  });
  if (!res.ok) throw new Error(`Sentinel-2-Katalog HTTP ${res.status}`);
  const json = (await res.json()) as { features: StacFeature[] };
  const north = (bbox[1] + bbox[3]) / 2 > 55;
  const months = north ? [6, 7, 8, 9] : [6, 7, 8, 9, 10];
  const candidates = json.features
    .filter((f) => {
      const d = new Date(String(f.properties.datetime));
      const snow = Number(f.properties["s2:snow_ice_percentage"] ?? 0);
      const nodata = Number(f.properties["s2:nodata_pixel_percentage"] ?? 0);
      return (
        months.includes(d.getUTCMonth() + 1) && snow < 5 && nodata < 50 &&
        ["green", "red", "nir"].every((k) => f.assets[k]?.href.startsWith("https://"))
      );
    })
    .map((f) => ({
      id: f.id,
      bbox: f.bbox,
      date: String(f.properties.datetime).slice(0, 10),
      cloud: Number(f.properties["eo:cloud_cover"]),
      epsg: Number(f.properties["proj:epsg"] ?? String(f.properties["proj:code"] ?? "").replace("EPSG:", "")),
      green: f.assets.green.href,
      red: f.assets.red.href,
      nir: f.assets.nir.href,
    }))
    .filter((s) => s.epsg > 32600 && s.epsg < 32800);
  if (candidates.length === 0) return [];
  // Anteil des Ausschnitts, den eine Kachel abdeckt (über die Umrisse, Näherung)
  const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const cover = (sc: Scene) =>
    area([Math.max(sc.bbox[0], bbox[0]), Math.max(sc.bbox[1], bbox[1]), Math.min(sc.bbox[2], bbox[2]), Math.min(sc.bbox[3], bbox[3])]) / area(bbox);
  // wolkenärmste Szenen zuerst, bei Gleichstand die mit größerer Abdeckung, dann die neueste
  candidates.sort((a, b) => a.cloud - b.cloud || cover(b) - cover(a) || b.date.localeCompare(a.date));
  const first = candidates.reduce((best, c) => (cover(c) > cover(best) + 0.05 && c.cloud < 3 ? c : best), candidates[0]);
  const chosen = [first];
  if (cover(first) < 0.999) {
    // weitere Kacheln: andere MGRS-Kachel, möglichst selber Tag
    const tile = (sc: Scene) => sc.id.split("_")[1];
    const others = candidates.filter((c) => tile(c) !== tile(first));
    const sameDay = others.filter((c) => c.date === first.date);
    for (const pool of [sameDay, others]) {
      for (const c of pool) if (!chosen.some((x) => tile(x) === tile(c))) chosen.push(c);
      if (chosen.length >= 3) break;
    }
  }
  return chosen.slice(0, 3);
}

function utmDef(epsg: number) {
  const south = epsg >= 32700;
  const zone = epsg - (south ? 32700 : 32600);
  return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

const TILE = 256;

function gridPixelToLngLat(g: Grid, cx: number, cy: number): [number, number] {
  const n = TILE * 2 ** g.z;
  const px = g.x0 + cx + 0.5, py = g.y0 + cy + 0.5;
  return [(px / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI];
}

export interface Indices {
  /** (Grün − NIR) / (Grün + NIR): Wasser > 0 */
  ndwi: Float32Array;
  /** (NIR − Rot) / (NIR + Rot): Vegetation > 0,4, Kies/Fels/Wasser < 0,2 */
  ndvi: Float32Array;
}

/**
 * NDWI und NDVI für jede Rasterzelle (NaN = keine Daten). Die Szene wird nur im
 * benötigten Fenster gelesen (Cloud-Optimized GeoTIFF, HTTP-Range-Requests).
 */
export async function indicesForGrid(g: Grid, scene: Scene): Promise<Indices> {
  const { fromUrl } = await import("geotiff");
  const fwd = proj4("EPSG:4326", utmDef(scene.epsg));
  const [gt, rt, nt] = await Promise.all([fromUrl(scene.green), fromUrl(scene.red), fromUrl(scene.nir)]);
  const [gi, ri, ni] = await Promise.all([gt.getImage(), rt.getImage(), nt.getImage()]);
  const [ox, oy] = gi.getOrigin();
  const [rx, ry] = gi.getResolution(); // ry negativ

  // UTM-Koordinaten auf einem groben Gitter berechnen und dazwischen interpolieren
  const step = 8;
  const lw = Math.ceil(g.w / step) + 1, lh = Math.ceil(g.h / step) + 1;
  const ux = new Float64Array(lw * lh), uy = new Float64Array(lw * lh);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let j = 0; j < lh; j++)
    for (let i = 0; i < lw; i++) {
      const [e, nn] = fwd.forward(gridPixelToLngLat(g, Math.min(i * step, g.w - 1), Math.min(j * step, g.h - 1)));
      ux[j * lw + i] = e; uy[j * lw + i] = nn;
      minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, nn); maxN = Math.max(maxN, nn);
    }
  const W = gi.getWidth(), H = gi.getHeight();
  const c0 = Math.max(0, Math.floor((minE - ox) / rx) - 2), c1 = Math.min(W, Math.ceil((maxE - ox) / rx) + 2);
  const r0 = Math.max(0, Math.floor((maxN - oy) / ry) - 2), r1 = Math.min(H, Math.ceil((minN - oy) / ry) + 2);
  const ndwi = new Float32Array(g.w * g.h).fill(NaN);
  const ndvi = new Float32Array(g.w * g.h).fill(NaN);
  if (c1 <= c0 || r1 <= r0) return { ndwi, ndvi };
  const window = [c0, r0, c1, r1];
  const [[gb], [rb], [nb]] = (await Promise.all([gi, ri, ni].map((im) => im.readRasters({ window })))) as unknown as [ArrayLike<number>][];
  const ww = c1 - c0;
  for (let y = 0; y < g.h; y++) {
    const fy = y / step, j = Math.min(lh - 2, Math.floor(fy)), ty = fy - j;
    for (let x = 0; x < g.w; x++) {
      const fx = x / step, i = Math.min(lw - 2, Math.floor(fx)), tx = fx - i;
      const k = j * lw + i;
      const e = (ux[k] * (1 - tx) + ux[k + 1] * tx) * (1 - ty) + (ux[k + lw] * (1 - tx) + ux[k + lw + 1] * tx) * ty;
      const nn = (uy[k] * (1 - tx) + uy[k + 1] * tx) * (1 - ty) + (uy[k + lw] * (1 - tx) + uy[k + lw + 1] * tx) * ty;
      const c = Math.floor((e - ox) / rx) - c0, r = Math.floor((nn - oy) / ry) - r0;
      if (c < 0 || r < 0 || c >= ww || r >= r1 - r0) continue;
      const gv = gb[r * ww + c], rv = rb[r * ww + c], nv = nb[r * ww + c];
      if (gv === 0 && nv === 0) continue; // NoData
      ndwi[y * g.w + x] = (gv - nv) / (gv + nv + 1e-6);
      ndvi[y * g.w + x] = (nv - rv) / (nv + rv + 1e-6);
    }
  }
  return { ndwi, ndvi };
}

/** Fertige Wasserquelle für traceRiver(): Szene suchen und NDWI auf das Raster legen. */
export async function sentinelWater(g: Grid): Promise<(Indices & { label: string }) | null> {
  const [w, n] = gridPixelToLngLat(g, 0, 0);
  const [e, s] = gridPixelToLngLat(g, g.w - 1, g.h - 1);
  const scenes = await findScenes([w, s, e, n]);
  if (scenes.length === 0) return null;
  const parts = await Promise.all(scenes.map((sc) => indicesForGrid(g, sc)));
  // erste Szene hat Vorrang; Lücken (außerhalb der Kachel) aus den weiteren füllen
  const out = parts[0];
  for (const p of parts.slice(1))
    for (let i = 0; i < out.ndwi.length; i++)
      if (Number.isNaN(out.ndwi[i]) && !Number.isNaN(p.ndwi[i])) {
        out.ndwi[i] = p.ndwi[i];
        out.ndvi[i] = p.ndvi[i];
      }
  const dates = [...new Set(scenes.map((sc) => sc.date))];
  return { ...out, label: dates.join(", ") };
}
