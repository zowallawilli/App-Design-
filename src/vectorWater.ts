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
