// Flussgeometrien aus OpenStreetMap (Overpass API) laden und zu einer Hauptlinie verketten.

import { locateOnLine, type LngLat } from "./geo";

export const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export interface OsmWay {
  id: number;
  nodes: number[];
  coords: LngLat[];
  tags: Record<string, string>;
}

export interface RiverLine {
  name: string;
  wayIds: number[];
  coords: LngLat[];
}

interface OverpassElement {
  type: string;
  id: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

async function overpass(query: string): Promise<OverpassElement[]> {
  let lastErr: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = await res.json();
      return json.elements as OverpassElement[];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Overpass nicht erreichbar");
}

function toWays(elements: OverpassElement[]): OsmWay[] {
  return elements
    .filter((e) => e.type === "way" && e.geometry && e.nodes)
    .map((e) => ({
      id: e.id,
      nodes: e.nodes!,
      coords: e.geometry!.map((g) => [g.lon, g.lat] as LngLat),
      tags: e.tags ?? {},
    }));
}

const WATERWAYS = "^(river|stream|canal)$";

/** Gewässerabschnitte in der Nähe eines Punktes. */
export async function waysNear(p: LngLat, radius = 250): Promise<OsmWay[]> {
  const q = `[out:json][timeout:25];way(around:${radius},${p[1]},${p[0]})["waterway"~"${WATERWAYS}"];out body geom;`;
  return toWays(await overpass(q));
}

/**
 * Alle Wege desselben Flusses: bevorzugt über die Waterway-Relation,
 * sonst über den Namen im Umkreis.
 */
export async function riverWays(seed: OsmWay, p: LngLat, searchRadius = 60000): Promise<OsmWay[]> {
  const rel = `[out:json][timeout:60];way(${seed.id});rel(bw)["type"~"^(waterway|route)$"]->.r;way(r.r)["waterway"~"${WATERWAYS}"];out body geom;`;
  let ways = toWays(await overpass(rel));
  if (ways.length === 0 && seed.tags.name) {
    const name = seed.tags.name.replace(/"/g, '\\"');
    const q = `[out:json][timeout:60];way(around:${searchRadius},${p[1]},${p[0]})["waterway"~"${WATERWAYS}"]["name"="${name}"];out body geom;`;
    ways = toWays(await overpass(q));
  }
  if (!ways.some((w) => w.id === seed.id)) ways.push(seed);
  return ways;
}

/**
 * Verkettet Wege zu einer durchgehenden Hauptlinie durch den Startweg.
 * OSM-Gewässer sind in Fließrichtung digitalisiert; an Verzweigungen
 * (Nebenarme, Inseln) wird der Weg mit gleichem Namen und größerer Länge bevorzugt.
 */
export function chainWays(ways: OsmWay[], seedId: number): LngLat[] {
  const byId = new Map(ways.map((w) => [w.id, w]));
  const seed = byId.get(seedId);
  if (!seed) throw new Error("Startweg fehlt");
  const startsAt = new Map<number, OsmWay[]>();
  const endsAt = new Map<number, OsmWay[]>();
  for (const w of ways) {
    const s = w.nodes[0], e = w.nodes[w.nodes.length - 1];
    (startsAt.get(s) ?? startsAt.set(s, []).get(s)!).push(w);
    (endsAt.get(e) ?? endsAt.set(e, []).get(e)!).push(w);
  }
  const score = (w: OsmWay) =>
    (w.tags.name && w.tags.name === seed.tags.name ? 1e9 : 0) +
    (w.tags.waterway === seed.tags.waterway ? 1e8 : 0) +
    w.coords.length;
  const pick = (c: OsmWay[] | undefined, used: Set<number>) =>
    (c ?? []).filter((w) => !used.has(w.id)).sort((a, b) => score(b) - score(a))[0];

  const used = new Set([seed.id]);
  let coords = [...seed.coords];
  // flussabwärts
  let tail = seed;
  for (;;) {
    const next = pick(startsAt.get(tail.nodes[tail.nodes.length - 1]), used);
    if (!next) break;
    used.add(next.id);
    coords = coords.concat(next.coords.slice(1));
    tail = next;
  }
  // flussaufwärts
  let head = seed;
  for (;;) {
    const prev = pick(endsAt.get(head.nodes[0]), used);
    if (!prev) break;
    used.add(prev.id);
    coords = prev.coords.slice(0, -1).concat(coords);
    head = prev;
  }
  return coords;
}

/** Fluss unter einem Klickpunkt laden. */
export async function loadRiverAt(p: LngLat): Promise<RiverLine> {
  const near = await waysNear(p);
  if (near.length === 0) throw new Error("Kein Gewässer in der Nähe gefunden (OSM). Näher heranzoomen oder Strecke selbst zeichnen.");
  const ranked = near
    .map((w) => ({ w, off: locateOnLine(w.coords, p).offset, river: w.tags.waterway === "river" ? 0 : 1 }))
    .sort((a, b) => a.off + a.river * 50 - (b.off + b.river * 50));
  const seed = ranked[0].w;
  const ways = await riverWays(seed, p);
  return { name: seed.tags.name ?? "(unbenanntes Gewässer)", wayIds: ways.map((w) => w.id), coords: chainWays(ways, seed.id) };
}

/** Ortssuche über Nominatim. */
export async function geocode(q: string): Promise<{ name: string; p: LngLat }[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "de" } });
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (HTTP ${res.status})`);
  const json = (await res.json()) as { display_name: string; lon: string; lat: string }[];
  return json.map((r) => ({ name: r.display_name, p: [Number(r.lon), Number(r.lat)] }));
}
