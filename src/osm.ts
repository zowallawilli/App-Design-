// Flussgeometrien aus OpenStreetMap (Overpass API) laden und zu einer Hauptlinie verketten.

import { locateOnLine, type LngLat } from "./geo";

export const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Nach dieser Zeit ohne Antwort wird parallel der nächste Server gefragt (ms). */
export const HEDGE_DELAY = 3500;

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

const cache = new Map<string, Promise<OverpassElement[]>>();

/**
 * Overpass-Abfrage mit gestaffelten Anfragen: Antwortet der erste Server nicht
 * innerhalb von HEDGE_DELAY (oder mit Fehler), wird der nächste gefragt; die erste
 * gültige Antwort gewinnt, die übrigen Anfragen werden abgebrochen.
 * Ergebnisse werden für die Sitzung zwischengespeichert.
 */
export function overpass(query: string, fetchFn: typeof fetch = fetch, hedgeDelay = HEDGE_DELAY): Promise<OverpassElement[]> {
  const hit = cache.get(query);
  if (hit) return hit;
  // Abfragen nacheinander (Overpass weist zu viele gleichzeitige Abfragen derselben Adresse ab, HTTP 429);
  // bei Überlastung einmal nach kurzer Pause wiederholen
  const once = () => overpassOnce(query, fetchFn, hedgeDelay);
  const run = () => once().catch((e: Error) => (/HTTP 429|HTTP 504|too many|timed out/i.test(e.message) ? new Promise<void>((r) => setTimeout(r, RETRY_DELAY)).then(once) : Promise.reject(e)));
  const p = queue.then(run, run);
  queue = p.then(() => undefined, () => undefined);
  cache.set(query, p);
  p.catch(() => cache.delete(query));
  return p;
}
let queue: Promise<void> = Promise.resolve();
/** Pause vor dem zweiten Versuch (ms) */
export const RETRY_DELAY = 4000;

function overpassOnce(query: string, fetchFn: typeof fetch, hedgeDelay: number): Promise<OverpassElement[]> {
  return new Promise<OverpassElement[]>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let next = 0, failed = 0, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const errors: string[] = [];
    const launch = () => {
      if (settled || next >= OVERPASS_URLS.length) return;
      const url = OVERPASS_URLS[next++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      clearTimeout(timer);
      timer = setTimeout(launch, hedgeDelay);
      fetchFn(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as { elements: OverpassElement[]; remark?: string };
          if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          controllers.forEach((c) => c !== ctrl && c.abort());
          resolve(json.elements);
        })
        .catch((e: Error) => {
          if (settled || e.name === "AbortError") return;
          errors.push(`${new URL(url).host}: ${e.message}`);
          if (++failed === OVERPASS_URLS.length) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`OpenStreetMap nicht erreichbar (${errors.join("; ")})`));
          } else launch(); // sofort den nächsten Server fragen
        });
    };
    launch();
  });
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

/** Suchradius um den Klickpunkt für den restlichen Fluss (m). */
export const RIVER_RADIUS = 25000;

/**
 * Eine einzige Abfrage: Gewässer am Klickpunkt plus alle Wege ihrer Waterway-Relation
 * im Umkreis. `qt` sortiert nicht – spart Serverzeit.
 */
export function clickQuery(p: LngLat, radius = 250, riverRadius = RIVER_RADIUS): string {
  const w = `["waterway"~"${WATERWAYS}"]`;
  return (
    `[out:json][timeout:30];way(around:${radius},${p[1]},${p[0]})${w}->.near;` +
    `rel(bw.near)["type"~"^(waterway|route)$"]->.r;` +
    `(way(r.r)${w}(around:${riverRadius},${p[1]},${p[0]});.near;);out body geom qt;`
  );
}

/** Wege gleichen Namens im Umkreis (nur nötig, wenn der Fluss keine Relation hat). */
export async function waysByName(name: string, p: LngLat, radius = RIVER_RADIUS): Promise<OsmWay[]> {
  const n = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const q = `[out:json][timeout:30];way(around:${radius},${p[1]},${p[0]})["waterway"~"${WATERWAYS}"]["name"="${n}"];out body geom qt;`;
  return toWays(await overpass(q));
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
  // Gleichnamige Wege, die versehentlich gegen die Fließrichtung digitalisiert sind, werden umgedreht angehängt.
  const flip = (w: OsmWay): OsmWay => ({ ...w, nodes: [...w.nodes].reverse(), coords: [...w.coords].reverse() });
  const sameRiver = (w: OsmWay) => !!seed.tags.name && w.tags.name === seed.tags.name;

  const used = new Set([seed.id]);
  let coords = [...seed.coords];
  // flussabwärts
  let tailNode = seed.nodes[seed.nodes.length - 1];
  for (;;) {
    let next = pick(startsAt.get(tailNode), used);
    if (!next) {
      const rev = pick(endsAt.get(tailNode)?.filter(sameRiver), used);
      if (rev) next = flip(rev);
    }
    if (!next) break;
    used.add(next.id);
    coords = coords.concat(next.coords.slice(1));
    tailNode = next.nodes[next.nodes.length - 1];
  }
  // flussaufwärts
  let headNode = seed.nodes[0];
  for (;;) {
    let prev = pick(endsAt.get(headNode), used);
    if (!prev) {
      const rev = pick(startsAt.get(headNode)?.filter(sameRiver), used);
      if (rev) prev = flip(rev);
    }
    if (!prev) break;
    used.add(prev.id);
    coords = prev.coords.slice(0, -1).concat(coords);
    headNode = prev.nodes[0];
  }
  return coords;
}

/** Fluss unter einem Klickpunkt laden. */
export async function loadRiverAt(p: LngLat): Promise<RiverLine> {
  let ways = toWays(await overpass(clickQuery(p)));
  const near = ways.filter((w) => locateOnLine(w.coords, p).offset <= 300);
  if (near.length === 0) throw new Error("Kein Gewässer in der Nähe gefunden (OSM). Näher heranzoomen oder Strecke selbst zeichnen.");
  const ranked = near
    .map((w) => ({ w, off: locateOnLine(w.coords, p).offset, river: w.tags.waterway === "river" ? 0 : 1 }))
    .sort((a, b) => a.off + a.river * 50 - (b.off + b.river * 50));
  const seed = ranked[0].w;
  // Ohne Waterway-Relation kamen nur die Wege am Klickpunkt – dann über den Namen nachladen
  const sameName = ways.filter((w) => seed.tags.name && w.tags.name === seed.tags.name);
  if (seed.tags.name && sameName.length <= near.filter((w) => w.tags.name === seed.tags.name).length) {
    const more = await waysByName(seed.tags.name, p);
    const ids = new Set(ways.map((w) => w.id));
    ways = ways.concat(more.filter((w) => !ids.has(w.id)));
  }
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

/** Alle Gewässerlinien in einem Ausschnitt [W, S, O, N] – für das automatische Nachziehen. */
export async function waterwaysInBbox(bbox: [number, number, number, number]): Promise<{ name?: string; coords: LngLat[] }[]> {
  const q = `[out:json][timeout:25];way["waterway"~"${WATERWAYS}"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});out tags geom qt;`;
  const els = await overpass(q);
  return els
    .filter((e) => e.type === "way" && e.geometry)
    .map((e) => ({ name: e.tags?.name, coords: e.geometry!.map((g) => [g.lon, g.lat] as LngLat) }));
}
