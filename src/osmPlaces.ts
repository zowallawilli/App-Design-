// Stromschnellen, Wehre, Wasserfälle, Ein-/Ausstiege und Umtragestellen aus OpenStreetMap (Overpass API).
// Von Freiwilligen eingetragen – in der App immer als „aus OSM, nicht geprüft“ gekennzeichnet.
// Tags: https://wiki.openstreetmap.org/wiki/Whitewater_sports (whitewater=*, whitewater:rapid_grade) und
// waterway=waterfall|weir|dam|rapids|lock_gate.

import { haversine, locateOnLine, type LngLat } from "./geo";
import { overpass } from "./osm";

export type OsmPlaceKind = "rapid" | "waterfall" | "weir" | "dam" | "lock" | "put_in" | "egress" | "access" | "portage" | "hazard";

export const OSM_KIND: Record<OsmPlaceKind, { text: string; color: string; /** Wegpunkt-Symbol (Garmin/Gaia) */ sym: string }> = {
  rapid: { text: "Stromschnelle", color: "#457b9d", sym: "Caution" },
  waterfall: { text: "Wasserfall", color: "#e76f51", sym: "Danger Area" },
  weir: { text: "Wehr", color: "#e76f51", sym: "Danger Area" },
  dam: { text: "Staudamm", color: "#e76f51", sym: "Danger Area" },
  lock: { text: "Schleuse", color: "#e76f51", sym: "Caution" },
  hazard: { text: "Gefahr", color: "#e76f51", sym: "Danger Area" },
  put_in: { text: "Einstieg", color: "#2a9d8f", sym: "Boat Ramp" },
  egress: { text: "Ausstieg", color: "#2a9d8f", sym: "Boat Ramp" },
  access: { text: "Ein-/Ausstieg", color: "#2a9d8f", sym: "Boat Ramp" },
  portage: { text: "Umtragen", color: "#6d597a", sym: "Trail Head" },
};

export interface OsmPlace {
  /** z. B. "node/123" */
  id: string;
  kind: OsmPlaceKind;
  p: LngLat;
  /** Wildwassergrad laut OSM (whitewater:rapid_grade, 1–6 → „III“) */
  grade?: string;
  name?: string;
  /** Freitext aus description/note/hazard */
  note?: string;
  /** Stationierung (m ab Einstieg) und Abstand zur Strecke (m) */
  d: number;
  offset: number;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
/** OSM-Grad („3“, „3+“, „III“, „2-3“) → römisch mit Zusatz („III+“, „II–III“) */
export function osmGrade(v?: string): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toUpperCase();
  const one = (x: string) => {
    const m = /^([1-6]|VI|IV|V|I{1,3})([+-])?$/.exec(x.trim());
    if (!m) return null;
    const n = /^\d$/.test(m[1]) ? ROMAN[Number(m[1])] : m[1];
    return n + (m[2] ?? "");
  };
  const parts = t.split(/\s*[-–/]\s*(?=[1-6IV])/);
  const r = parts.map(one);
  return r.every(Boolean) ? r.join("–") : undefined;
}

/** Art einer OSM-Stelle aus den Tags (null = nicht relevant) */
export function placeKind(tags: Record<string, string>): OsmPlaceKind | null {
  const ww = (tags.whitewater ?? "").toLowerCase();
  if (ww) {
    if (/put_in/.test(ww) && /egress/.test(ww)) return "access";
    if (ww === "put_in") return "put_in";
    if (ww === "egress") return "egress";
    if (/^portage/.test(ww)) return "portage";
    if (ww === "hazard") return "hazard";
    if (ww === "rapid") return "rapid";
  }
  switch (tags.waterway) {
    case "waterfall": return "waterfall";
    case "weir": return "weir";
    case "dam": return "dam";
    case "lock_gate": return "lock";
    case "rapids": return "rapid";
  }
  return null;
}

/** Overpass-Abfrage für die Umgebung der Strecke (Rechteck + Puffer) */
export function placesQuery(line: LngLat[], padM = 300): string {
  const lats = line.map((p) => p[1]), lons = line.map((p) => p[0]);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats);
  const dLat = padM / 111_320, dLon = padM / (111_320 * Math.cos(((lat0 + lat1) / 2) * Math.PI / 180));
  const bb = [lat0 - dLat, Math.min(...lons) - dLon, lat1 + dLat, Math.max(...lons) + dLon].map((v) => v.toFixed(5)).join(",");
  return `[out:json][timeout:25];(nwr["whitewater"](${bb});node["waterway"~"^(waterfall|weir|dam|rapids|lock_gate)$"](${bb});way["waterway"~"^(weir|dam|rapids)$"](${bb}););out tags center;`;
}

export interface OsmEl { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

/** Elemente → Stellen an der Strecke: Flussobjekte ≤ 60 m, Zugänge/Umtragen ≤ 150 m von der Linie; Dubletten (≤ 25 m, gleiche Art) zusammengefasst. */
export function placesOnLine(els: OsmEl[], line: LngLat[]): OsmPlace[] {
  const out: OsmPlace[] = [];
  for (const e of els) {
    const t = e.tags ?? {};
    const kind = placeKind(t);
    const c = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
    if (!kind || !c) continue;
    const p: LngLat = [c.lon, c.lat];
    const at = locateOnLine(line, p);
    const max = kind === "put_in" || kind === "egress" || kind === "access" || kind === "portage" ? 150 : 60;
    if (at.offset > max) continue;
    if (out.some((o) => o.kind === kind && haversine(o.p, p) < 25)) continue;
    const name = t["whitewater:rapid_name"] ?? t["whitewater:name"] ?? t.name;
    const note = t.description ?? t.note ?? t["whitewater:hazard"] ?? (t.hazard && t.hazard !== "yes" ? t.hazard : undefined);
    out.push({
      id: `${e.type}/${e.id}`, kind, p, d: at.d, offset: at.offset, name: name || undefined, note: note || undefined,
      grade: osmGrade(t["whitewater:rapid_grade"] ?? t["whitewater:grade"]),
    });
  }
  return out.sort((a, b) => a.d - b.d);
}

export async function loadOsmPlaces(line: LngLat[], fetchFn: typeof fetch = fetch): Promise<OsmPlace[]> {
  return placesOnLine(await overpass(placesQuery(line), fetchFn), line);
}

/** Kurztext, z. B. „Stromschnelle · WW III (OSM) · Pianser Schwall“ */
export const osmPlaceText = (o: OsmPlace) =>
  `${OSM_KIND[o.kind].text}${o.grade ? ` · WW ${o.grade}` : ""}${o.name ? ` · ${o.name}` : ""}`;
