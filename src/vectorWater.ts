// Gewässer aus OpenStreetMap über vorberechnete Vektorkacheln (OpenFreeMap, OpenMapTiles-Schema).
// Schnell (CDN, zwischengespeichert), kostenlos, ohne Schlüssel – unabhängig von der oft
// überlasteten Overpass-API. Enthält Flusslinien (Ebene „waterway“) und Wasserflächen
// (Ebene „water“, z. B. als Fläche kartierte Flüsse und Seen).

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import type { LngLat } from "./geo";

export const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";

export interface WaterFeature {
  name?: string;
  coords: LngLat[];
  /** true = Fläche (äußerer Ring), sonst Linie */
  area?: boolean;
  /** OpenMapTiles-Klasse: river, stream, canal, lake … */
  kind?: string;
}

let tileUrl: Promise<string> | null = null;
function template(fetchFn: typeof fetch): Promise<string> {
  if (!tileUrl) {
    tileUrl = fetchFn(OFM_TILEJSON).then((r) => r.json()).then((j: { tiles: string[] }) => j.tiles[0]);
    tileUrl.catch(() => (tileUrl = null));
  }
  return tileUrl;
}

const tileCache = new Map<string, Promise<WaterFeature[]>>();

function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

async function loadTile(z: number, x: number, y: number, fetchFn: typeof fetch): Promise<WaterFeature[]> {
  const url = (await template(fetchFn)).replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetchFn(url);
  if (res.status === 404 || res.status === 204) return [];
  if (!res.ok) throw new Error(`Vektorkachel HTTP ${res.status}`);
  const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
  const out: WaterFeature[] = [];
  for (const layerName of ["waterway", "water"] as const) {
    const layer = vt.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const props = f.properties as Record<string, string | number | boolean>;
      if (props.brunnel === "tunnel") continue; // verrohrte Abschnitte
      const kind = String(props.class ?? "");
      const gj = f.toGeoJSON(x, y, z) as GeoJSON.Feature;
      const name = (props["name:latin"] ?? props.name) as string | undefined;
      const geom = gj.geometry;
      if (layerName === "waterway") {
        const lines = geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
        for (const l of lines) out.push({ name, kind, coords: l as LngLat[] });
      } else {
        const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
        for (const p of polys) out.push({ name, kind, area: true, coords: p[0] as LngLat[] });
      }
    }
  }
  return out;
}

/** Alle Gewässer im Ausschnitt [W, S, O, N]. Zoom 14 (volle Detailstufe), bei großen Ausschnitten 13/12. */
export async function waterInBbox(bbox: [number, number, number, number], fetchFn: typeof fetch = fetch): Promise<WaterFeature[]> {
  let z = 14;
  const count = (zz: number) => (lon2tile(bbox[2], zz) - lon2tile(bbox[0], zz) + 1) * (lat2tile(bbox[1], zz) - lat2tile(bbox[3], zz) + 1);
  while (z > 11 && count(z) > 120) z--;
  const jobs: Promise<WaterFeature[]>[] = [];
  for (let x = lon2tile(bbox[0], z); x <= lon2tile(bbox[2], z); x++)
    for (let y = lat2tile(bbox[3], z); y <= lat2tile(bbox[1], z); y++) {
      const key = `${z}/${x}/${y}`;
      let t = tileCache.get(key);
      if (!t) {
        t = loadTile(z, x, y, fetchFn);
        t.catch(() => tileCache.delete(key));
        tileCache.set(key, t);
      }
      jobs.push(t);
    }
  return (await Promise.all(jobs)).flat();
}

/**
 * Gletscherfläche (km²) im Umkreis `radiusKm` um einen Punkt aus der OpenMapTiles-Ebene „landcover“
 * (Klasse ice/glacier, OSM natural=glacier). Grobe Näherung für Gletschereinfluss – der Umkreis ist
 * nicht das Einzugsgebiet. Gezählt werden Flächenteile, deren Schwerpunkt im Umkreis liegt.
 */
export async function glacierAreaNear(p: LngLat, radiusKm = 20, fetchFn: typeof fetch = fetch): Promise<number> {
  const z = 9;
  const dLat = radiusKm / 111.2, dLon = radiusKm / (111.2 * Math.cos((p[1] * Math.PI) / 180));
  const x0 = lon2tile(p[0] - dLon, z), x1 = lon2tile(p[0] + dLon, z), y0 = lat2tile(p[1] + dLat, z), y1 = lat2tile(p[1] - dLat, z);
  const tmpl = await template(fetchFn);
  const kx = 111.2 * Math.cos((p[1] * Math.PI) / 180);
  let area = 0;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(
        (async () => {
          const res = await fetchFn(tmpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
          if (!res.ok) return;
          const layer = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer()))).layers.landcover;
          if (!layer) return;
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            if (f.properties.class !== "ice") continue;
            const g = (f.toGeoJSON(x, y, z) as GeoJSON.Feature).geometry;
            const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
            for (const poly of polys) {
              const ring = poly[0] as LngLat[];
              let a = 0, cx = 0, cy = 0;
              for (let k = 0; k < ring.length - 1; k++) {
                const [ax, ay] = [(ring[k][0] - p[0]) * kx, (ring[k][1] - p[1]) * 111.2];
                const [bx, by] = [(ring[k + 1][0] - p[0]) * kx, (ring[k + 1][1] - p[1]) * 111.2];
                a += ax * by - bx * ay;
                cx += ax; cy += ay;
              }
              cx /= Math.max(1, ring.length - 1); cy /= Math.max(1, ring.length - 1);
              if (Math.hypot(cx, cy) <= radiusKm) area += Math.abs(a) / 2;
            }
          }
        })().catch(() => undefined),
      );
  await Promise.all(jobs);
  return area;
}

export interface RiverLine {
  name: string;
  kind: string;
  coords: LngLat[];
}

/**
 * Benannte Flüsse (Ebene „waterway“) und Namen von Wasserflächen (Ebene „water_name“, z. B. Stauseen)
 * im Ausschnitt [W, S, O, N] aus groben Kacheln (Zoom 9, ~40 km je Kachel) – für das Einzugsgebiet.
 */
export async function riversInBbox(bbox: [number, number, number, number], fetchFn: typeof fetch = fetch): Promise<{ rivers: RiverLine[]; waterNames: { name: string; p: LngLat }[] }> {
  const z = 9;
  const tmpl = await template(fetchFn);
  const rivers: RiverLine[] = [];
  const waterNames: { name: string; p: LngLat }[] = [];
  const jobs: Promise<void>[] = [];
  for (let x = lon2tile(bbox[0], z); x <= lon2tile(bbox[2], z); x++)
    for (let y = lat2tile(bbox[3], z); y <= lat2tile(bbox[1], z); y++)
      jobs.push(
        (async () => {
          const res = await fetchFn(tmpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
          if (!res.ok) return;
          const vt = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
          const ww = vt.layers.waterway;
          if (ww)
            for (let i = 0; i < ww.length; i++) {
              const f = ww.feature(i);
              const props = f.properties as Record<string, string | number | boolean>;
              const name = (props["name:latin"] ?? props.name) as string | undefined;
              if (!name || props.brunnel === "tunnel") continue;
              const g = (f.toGeoJSON(x, y, z) as GeoJSON.Feature).geometry;
              const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
              for (const l of lines) rivers.push({ name, kind: String(props.class ?? ""), coords: l as LngLat[] });
            }
          const wn = vt.layers.water_name;
          if (wn)
            for (let i = 0; i < wn.length; i++) {
              const f = wn.feature(i);
              const name = (f.properties["name:latin"] ?? f.properties.name) as string | undefined;
              const g = (f.toGeoJSON(x, y, z) as GeoJSON.Feature).geometry;
              if (name && g.type === "Point") waterNames.push({ name, p: g.coordinates as LngLat });
            }
        })().catch(() => undefined),
      );
  await Promise.all(jobs);
  return { rivers, waterNames };
}

/** Gletscherfläche (km²) in der Nähe mehrerer Punkte (je `radiusKm`), jede Fläche nur einmal gezählt. */
export async function glacierAreaAround(points: LngLat[], radiusKm = 8, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!points.length) return 0;
  const z = 9;
  const tmpl = await template(fetchFn);
  const tiles = new Set<string>();
  for (const p of points) {
    const dLat = radiusKm / 111.2, dLon = radiusKm / (111.2 * Math.cos((p[1] * Math.PI) / 180));
    for (let x = lon2tile(p[0] - dLon, z); x <= lon2tile(p[0] + dLon, z); x++)
      for (let y = lat2tile(p[1] + dLat, z); y <= lat2tile(p[1] - dLat, z); y++) tiles.add(`${x}/${y}`);
  }
  let area = 0;
  await Promise.all(
    [...tiles].map(async (k) => {
      const [x, y] = k.split("/").map(Number);
      const res = await fetchFn(tmpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y))).catch(() => null);
      if (!res?.ok) return;
      const layer = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer()))).layers.landcover;
      if (!layer) return;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.properties.class !== "ice") continue;
        const g = (f.toGeoJSON(x, y, z) as GeoJSON.Feature).geometry;
        const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        for (const poly of polys) {
          const ring = poly[0] as LngLat[];
          const c0 = ring[0];
          const kx = 111.2 * Math.cos((c0[1] * Math.PI) / 180);
          let a = 0, cx = 0, cy = 0;
          for (let j = 0; j < ring.length - 1; j++) {
            const ax = (ring[j][0] - c0[0]) * kx, ay = (ring[j][1] - c0[1]) * 111.2;
            const bx = (ring[j + 1][0] - c0[0]) * kx, by = (ring[j + 1][1] - c0[1]) * 111.2;
            a += ax * by - bx * ay;
            cx += ring[j][0]; cy += ring[j][1];
          }
          const cen: LngLat = [cx / Math.max(1, ring.length - 1), cy / Math.max(1, ring.length - 1)];
          const near = points.some((p) => Math.hypot((cen[0] - p[0]) * 111.2 * Math.cos((p[1] * Math.PI) / 180), (cen[1] - p[1]) * 111.2) <= radiusKm);
          if (near) area += Math.abs(a) / 2;
        }
      }
    }),
  );
  return area;
}
