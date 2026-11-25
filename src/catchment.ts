// Einzugsgebiet oberhalb einer Strecke – grobe Näherung für die Wetterhinweise.
// Der Abfluss an der Strecke ist die Summe dessen, was oberhalb fällt oder schmilzt: Regen im ganzen
// Gebiet (vor allem im Gebirge), Schnee- und Gletscherschmelze in den hohen Lagen. Das Wetter an der
// Strecke selbst zählt am wenigsten. Deshalb: Hauptfluss vom Einstieg flussaufwärts bis zur Quelle
// verfolgen (OSM-Flussnamen aus groben Vektorkacheln) plus die größten Zubringer und Bezugspunkte
// darüber verteilen. Kein echtes Einzugsgebiet (keine Wasserscheiden) – eine Näherung.

import type { LngLat } from "./geo";
import type { RiverLine } from "./vectorWater";

export interface Catchment {
  /** Name des Hauptflusses (OSM), falls gefunden */
  river?: string;
  /** Zubringer oberhalb bzw. entlang der Strecke, deren Wetter mitzählt */
  tributaries: string[];
  /** Bezugspunkte fürs Wetter (Einstieg, flussaufwärts, Zubringer) */
  points: LngLat[];
  /** verfolgte Flussläufe (für die Karte) */
  lines: LngLat[][];
  /** Länge des Hauptflusses oberhalb des Einstiegs (km, grob) */
  upstreamKm: number;
  /** grob geschätzte Fläche (km²) */
  areaKm2: number;
  /** Stauseen/Speicher oberhalb (Namen) */
  reservoirs: string[];
  /** true = nur Umkreis um den Einstieg (Fluss nicht verfolgbar) */
  fallback: boolean;
}

const KM = 111.2;
export const distKm = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * KM * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), (a[1] - b[1]) * KM);
const minDist = (p: LngLat, pts: LngLat[]) => pts.reduce((m, q) => Math.min(m, distKm(p, q)), Infinity);

/** Ring von 4 Punkten (~13 km) um p – Rückfall, wenn kein Fluss verfolgt werden kann */
export function ringAround(p: LngLat): LngLat[] {
  return [0, 1, 2, 3].map((k) => {
    const t = (k * Math.PI) / 2 + Math.PI / 4;
    return [p[0] + 0.17 * Math.cos(t), p[1] + 0.12 * Math.sin(t)] as LngLat;
  });
}

/** Fläche aus Flusslänge nach dem Hack'schen Gesetz L ≈ 1,4·A^0,6 (Größenordnung) */
export const areaFromLength = (lengthKm: number) => Math.pow(Math.max(1, lengthKm) / 1.4, 1 / 0.6);

const RESERVOIR = /stausee|speicher|stauweiher|lago|bacino|invaso|réservoir|retenue|barrage|reservoir|magasin|dam\b|jezero/i;

/** gleiche Flüsse in anderer Sprache (Graubünden: En = Inn) */
const ALIAS: Record<string, string> = { En: "Inn" };
const norm = (n: string) => ALIAS[n] ?? n;

/**
 * Flussläufe gleichen Namens als Netz: vom Startpunkt aus entlang der Linien laufen (Kachelnähte und
 * Verzweigungen über 0,6 km Nähe verbunden), gesperrte Punkte nicht betreten. Liefert je erreichtem Punkt
 * die Fließstrecke (km) vom Start.
 */
function walk(lines: LngLat[][], start: LngLat, blocked: (c: LngLat) => boolean, maxKm = 80): { c: LngLat; d: number }[] {
  const nodes: LngLat[] = [];
  const next: number[][] = [];
  for (const l of lines) {
    const base = nodes.length;
    l.forEach((c, i) => {
      nodes.push(c);
      next.push([]);
      if (i > 0) {
        next[base + i].push(base + i - 1);
        next[base + i - 1].push(base + i);
      }
    });
  }
  // Nähte: Raster 0,01° (~1 km)
  const grid = new Map<string, number[]>();
  const key = (c: LngLat) => `${Math.round(c[0] * 100)},${Math.round(c[1] * 100)}`;
  nodes.forEach((c, i) => (grid.get(key(c)) ?? grid.set(key(c), []).get(key(c))!).push(i));
  nodes.forEach((c, i) => {
    const gx = Math.round(c[0] * 100), gy = Math.round(c[1] * 100);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (j !== i && distKm(c, nodes[j]) < 0.6) next[i].push(j);
  });
  if (!nodes.length) return [];
  const s0 = nodes.reduce((b, c, i) => (distKm(c, start) < distKm(nodes[b], start) ? i : b), 0);
  if (distKm(nodes[s0], start) > 2.5) return [];
  const dist = new Map<number, number>([[s0, 0]]);
  const queue = [s0];
  while (queue.length) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const i = queue.shift()!;
    for (const j of next[i]) {
      if (blocked(nodes[j])) continue;
      const d = dist.get(i)! + distKm(nodes[i], nodes[j]);
      if (d > maxKm || d >= (dist.get(j) ?? Infinity)) continue;
      dist.set(j, d);
      queue.push(j);
    }
  }
  return [...dist].map(([i, d]) => ({ c: nodes[i], d }));
}

export function catchmentFromRivers(route: LngLat[], rivers: RiverLine[], waterNames: { name: string; p: LngLat }[] = []): Catchment {
  const putIn = route[0];
  const step = Math.max(1, Math.floor(route.length / 30));
  const sample = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const fallback = (): Catchment => ({ tributaries: [], points: [putIn, ...ringAround(putIn)], lines: [], upstreamKm: 0, areaKm2: 0, reservoirs: [], fallback: true });
  const rv = rivers.map((r) => ({ ...r, name: norm(r.name) }));

  // Hauptfluss: Name, dessen Linien der Strecke am häufigsten nahe kommen (grobe Kacheln → 2 km Toleranz)
  const votes = new Map<string, number>();
  for (const p of sample) for (const r of rv) if (r.coords.some((c) => distKm(c, p) < 2)) votes.set(r.name, (votes.get(r.name) ?? 0) + 1);
  const main = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return fallback();

  // Strecke ab ~1,5 km unterhalb des Einstiegs sperren → der Weg führt nur flussaufwärts
  const downstream = sample.filter((p) => distKm(p, putIn) > 1.5);
  const onRoute = (c: LngLat) => downstream.some((p) => distKm(c, p) < 1.2);
  const mainLines = rv.filter((r) => r.name === main).map((r) => r.coords);
  const up = walk(mainLines, putIn, onRoute).filter((x) => x.d > 0.5);
  const upstreamKm = up.reduce((m, x) => Math.max(m, x.d), 0);

  // Bezugspunkte entlang des Hauptflusses: ~5, 15, 30, 45 km und das obere Ende (Quelle)
  const points: LngLat[] = [putIn];
  for (const d of [5, 15, 30, 45, upstreamKm]) {
    if (d > upstreamKm + 0.1) continue;
    const c = up.reduce<{ c: LngLat; d: number } | null>((b, x) => (!b || Math.abs(x.d - d) < Math.abs(b.d - d) ? x : b), null)?.c;
    if (c && points.every((p) => distKm(p, c) > 4)) points.push(c);
  }

  // Zubringer (1. und 2. Ordnung), die den Hauptfluss oberhalb oder die Strecke berühren – nicht erst am Ausstieg
  const nearEnd = sample.slice(-Math.max(2, Math.ceil(sample.length * 0.15)));
  const anchor0 = [...up.map((x) => x.c), ...sample.filter((p) => !nearEnd.includes(p))];
  const byName = new Map<string, LngLat[][]>();
  for (const r of rv) if (r.name !== main) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(r.coords);
  const lengthOf = (ls: LngLat[][]) => ls.reduce((a, l) => a + l.reduce((s, c, i) => (i ? s + distKm(l[i - 1], c) : s), 0), 0);
  const touching = (ls: LngLat[][], anchor: LngLat[]) => ls.some((l) => l.some((c) => anchor.some((a) => distKm(a, c) < 1.8)));
  // Flüsse, die erst am Ausstieg dazukommen (z. B. der Inn an der Sanna-Mündung), zählen nicht
  const okTrib = (ls: LngLat[][]) => !touching(ls, nearEnd);
  const first = [...byName].filter(([, ls]) => touching(ls, anchor0) && okTrib(ls));
  const firstCoords = first.flatMap(([, ls]) => ls.flat());
  const second = [...byName].filter(([n, ls]) => !first.some(([f]) => f === n) && touching(ls, firstCoords) && okTrib(ls));
  const top = [...first, ...second]
    .map(([n, ls]) => ({ n, ls, len: lengthOf(ls) }))
    .filter((t) => t.len >= 5)
    .sort((a, b) => b.len - a.len)
    .slice(0, 4);

  const lines: LngLat[][] = [];
  // nur die erreichten Teile des Hauptflusses zeichnen
  const reached = new Set(up.map((x) => `${x.c[0]},${x.c[1]}`));
  for (const l of mainLines) {
    const part = l.filter((c) => reached.has(`${c[0]},${c[1]}`));
    if (part.length > 1) lines.push(part);
  }
  for (const t of top) {
    const all = t.ls.flat();
    const anchor = [...anchor0, ...firstCoords];
    const mouth = all.reduce((b, c) => (minDist(c, anchor) < minDist(b, anchor) ? c : b));
    const c = all.reduce((b, x) => (Math.abs(distKm(x, mouth) - 10) < Math.abs(distKm(b, mouth) - 10) ? x : b));
    if (points.every((p) => distKm(p, c) > 4)) points.push(c);
    lines.push(...t.ls);
  }
  if (points.length < 3) for (const p of ringAround(putIn)) if (points.length < 5) points.push(p);
  const reservoirs = [...new Set(waterNames.filter((w) => RESERVOIR.test(w.name) && minDist(w.p, [...points, ...up.map((x) => x.c)]) < 6).map((w) => w.name))];
  const tribLen = top.reduce((a, t) => a + Math.min(t.len, 60), 0);
  return {
    river: main,
    tributaries: top.map((t) => t.n),
    points: points.slice(0, 8),
    lines,
    upstreamKm,
    areaKm2: areaFromLength(upstreamKm + tribLen * 0.5),
    reservoirs,
    fallback: false,
  };
}
