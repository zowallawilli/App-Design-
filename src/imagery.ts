// Herkunft, Aufnahmedatum und Auflösung des hochauflösenden Luft-/Satellitenbilds
// (Esri World Imagery) an beliebigen Punkten. Esri veröffentlicht dazu je Bildstand einen
// Metadaten-Dienst mit Layern je Auflösungsstufe (SRC_DATE, SRC_RES, NICE_NAME …).

import type { LngLat } from "./geo";

const META_ROOT = "https://metadata.maptiles.arcgis.com/arcgis/rest/services";

export interface ImageryInfo {
  /** Aufnahmedatum (YYYY-MM-DD) */
  date: string;
  /** Bodenauflösung in m */
  resolution: number;
  /** Quelle, z. B. „Slovenia2023“ / „GURS“ oder „Vivid“ / „Vantor“ */
  name: string;
  provider: string;
}

let serviceUrl: Promise<string> | null = null;

/** Neuesten Metadaten-Dienst ermitteln (entspricht dem aktuell angezeigten Bildstand). */
export function metadataService(fetchFn: typeof fetch = fetch): Promise<string> {
  if (!serviceUrl) {
    serviceUrl = fetchFn(`${META_ROOT}?f=json`)
      .then((r) => r.json())
      .then((d: { services: { name: string }[] }) => {
        const names = d.services.map((s) => s.name).filter((n) => /^World_Imagery_Metadata_\d{4}_r\d+$/.test(n)).sort();
        if (!names.length) throw new Error("Keine Bild-Metadaten gefunden");
        return `${META_ROOT}/${names[names.length - 1]}/MapServer`;
      });
    serviceUrl.catch(() => (serviceUrl = null));
  }
  return serviceUrl;
}

/** Metadaten-Layer: 0 = 1,9 cm … 13 = 150 m. Für Detailansicht reichen 15 cm … 2,4 m. */
const LAYERS = [3, 4, 5, 6, 7];

const parseDate = (v: string | number) => {
  const s = String(v);
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

/**
 * Bildinfo an einem Punkt für die Detailstufe `zoom` (Kachel-Zoom der Karte).
 * Bei mehreren Treffern gewinnt der mit der höchsten Zeichenreihenfolge (das sichtbare Bild).
 */
export async function imageryAt(p: LngLat, zoom = 18, fetchFn: typeof fetch = fetch): Promise<ImageryInfo | null> {
  const base = await metadataService(fetchFn);
  const results = await Promise.all(
    LAYERS.map(async (l) => {
      const url =
        `${base}/${l}/query?geometry=${p[0]},${p[1]}&geometryType=esriGeometryPoint&inSR=4326` +
        `&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE,SRC_RES,NICE_NAME,NICE_DESC,MinMapLevel,MaxMapLevel,DrawOrder&returnGeometry=false&f=json`;
      try {
        const d = (await (await fetchFn(url)).json()) as { features?: { attributes: Record<string, string | number> }[] };
        return d.features?.map((f) => f.attributes) ?? [];
      } catch {
        return [];
      }
    }),
  );
  const hits = results.flat().filter((a) => Number(a.MinMapLevel) <= zoom && Number(a.MaxMapLevel) >= zoom);
  const all = hits.length ? hits : results.flat();
  if (!all.length) return null;
  all.sort((a, b) => Number(b.DrawOrder) - Number(a.DrawOrder) || Number(a.SRC_RES) - Number(b.SRC_RES));
  const a = all[0];
  return { date: parseDate(a.SRC_DATE), resolution: Number(a.SRC_RES), name: String(a.NICE_NAME), provider: String(a.NICE_DESC) };
}

export interface ImageryStretch extends ImageryInfo {
  d0: number;
  d1: number;
}

/** Bildstände entlang einer Strecke (Stichproben alle `every` m, gleiche Bilder zusammengefasst). */
export async function imageryAlong(points: { d: number; p: LngLat }[], every = 1500, fetchFn: typeof fetch = fetch): Promise<ImageryStretch[]> {
  if (!points.length) return [];
  const total = points[points.length - 1].d;
  const n = Math.max(2, Math.round(total / every) + 1);
  const picks = Array.from({ length: n }, (_, k) => {
    const d = (total * k) / (n - 1);
    return points.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
  });
  const infos = await Promise.all(picks.map((q) => imageryAt(q.p, 18, fetchFn).catch(() => null)));
  const out: ImageryStretch[] = [];
  picks.forEach((q, k) => {
    const info = infos[k];
    if (!info) return;
    const last = out[out.length - 1];
    if (last && last.date === info.date && last.name === info.name) last.d1 = q.d;
    else out.push({ ...info, d0: q.d, d1: q.d });
  });
  // Lücken zwischen Stichproben dem jeweils vorherigen Bild zuschlagen
  out.forEach((s, i) => (s.d1 = out[i + 1] ? out[i + 1].d0 : total));
  if (out[0]) out[0].d0 = 0;
  return out;
}
