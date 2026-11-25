// Abfluss an einem Pegel ohne veröffentlichten Abfluss aus Nachbarpegeln schätzen
// (z. B. Inn bei Imst/Magerbach: dort gibt es nur die Wasserstandsklasse).
//
// Verfahren (braucht Einzugsgebiet A und Flusskilometer der Pegel, wie sie Tirol veröffentlicht):
//  1. oberhalb: nächster Pegel mit Abfluss am selben Fluss flussaufwärts (M) plus Zubringer-Pegel,
//     die zwischen M und dem Ziel münden. Ungemessener Rest wird nach Fläche ergänzt:
//        Q ≈ (Q_M + ΣQ_i) · A_Ziel / (A_M + ΣA_i)
//  2. unterhalb (Gegenprobe): nächster Pegel mit Abfluss flussabwärts (D), abzüglich Zubringer,
//     die zwischen Ziel und D münden:   Q ≈ (Q_D − ΣQ_j) · A_Ziel / (A_D − ΣA_j)
//  3. Liefert „oberhalb“ eine viel kleinere Abflussspende als „unterhalb“ (< 50 %), liegt der Pegel
//     oberhalb vermutlich in einer Restwasserstrecke (Kraftwerksausleitung) – dann gilt „unterhalb“.
// Das Ergebnis ist eine Linearkombination Σ w·Q der Quellpegel, damit lassen sich aktueller Wert und
// Tageswerte gleich behandeln. Die Zuordnung „mündet dazwischen“ ist eine Näherung (Lage und
// Flächenbilanz), kein Gewässernetz.

export interface EstStation {
  id: string;
  name: string;
  river: string | null;
  lat: number;
  lon: number;
  /** Einzugsgebiet km² */
  area: number | null;
  /** Flusskilometer (flussaufwärts größer) */
  km: number | null;
  /** aktueller Abfluss (m³/s), null = keiner veröffentlicht */
  q: number | null;
}

export interface Estimate {
  method: "oberhalb" | "unterhalb" | "zwischen";
  /** Quellpegel mit Gewicht: Q ≈ Σ w·Q_quelle */
  terms: { id: string; name: string; w: number }[];
  /** Klartext für die Anzeige */
  label: string;
  /** Hinweis, z. B. vermutete Ausleitung */
  note?: string;
}

const KM = 111.2;
/** Lage von p relativ zur Strecke a→b: t (0 = a, 1 = b) und Abstand in km */
function project(p: EstStation, a: EstStation, b: EstStation) {
  const c = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const ax = a.lon * c, ay = a.lat, bx = b.lon * c - ax, by = b.lat - ay, px = p.lon * c - ax, py = p.lat - ay;
  const l2 = bx * bx + by * by || 1e-12;
  const t = (px * bx + py * by) / l2;
  const tc = Math.max(0, Math.min(1, t));
  return { t, dist: Math.hypot(px - tc * bx, py - tc * by) * KM };
}

const fmt = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace(".", ",");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Zubringer-Pegel, die zwischen a (oben) und b (unten) münden und zusammen höchstens `room` km² haben */
function tributaries(a: EstStation, b: EstStation, all: EstStation[], room: number, maxKm: number, tMax: number) {
  const out: EstStation[] = [];
  let used = 0;
  const cands = all
    .filter((s) => s.q !== null && s.area && s.river !== b.river && s.id !== a.id && s.id !== b.id)
    .map((s) => ({ s, ...project(s, a, b) }))
    // zwischen den beiden Pegeln (nicht am oberen Pegel – dessen Zubringer sind schon enthalten);
    // Zubringer-Pegel liegen oft weit im Seitental, daher etwas Spielraum über das Streckenende
    .filter((x) => x.t > 0.05 && x.t < tMax && x.dist <= maxKm)
    .sort((x, y) => y.s.area! - x.s.area!);
  for (const { s } of cands)
    if (used + s.area! <= room * 1.02) {
      out.push(s);
      used += s.area!;
    }
  return out;
}

export function estimateFromNeighbours(target: EstStation, all: EstStation[], maxKm = 12): Estimate | null {
  if (!target.area || target.km === null || !target.river) return null;
  const same = all.filter((s) => s.river === target.river && s.q !== null && s.area && s.km !== null && s.id !== target.id);
  const up = same.filter((s) => s.km! > target.km! && s.area! < target.area!).sort((a, b) => b.area! - a.area!)[0];
  const down = same.filter((s) => s.km! < target.km! && s.area! > target.area!).sort((a, b) => a.area! - b.area!)[0];

  let upEst: Estimate | null = null, upQ = NaN;
  if (up) {
    const tr = tributaries(up, target, all, target.area - up.area!, maxKm, 1.25);
    const covered = up.area! + sum(tr.map((s) => s.area!));
    if (covered / target.area >= 0.6) {
      const k = target.area / covered;
      const src = [up, ...tr];
      upQ = sum(src.map((s) => s.q!)) * k;
      upEst = {
        method: "oberhalb",
        terms: src.map((s) => ({ id: s.id, name: s.name, w: k })),
        label: `geschätzt aus Pegeln oberhalb: ${src.map((s) => s.name).join(" + ")}` + (k > 1.02 ? ` (Rest nach Einzugsgebiet ×${k.toFixed(2).replace(".", ",")})` : ""),
      };
    }
  }
  let downEst: Estimate | null = null, downQ = NaN;
  if (down) {
    // unterhalb: nur Zubringer, die sicher vor dem unteren Pegel münden
    const tr = tributaries(target, down, all, down.area! - target.area, maxKm, 0.95);
    const rest = down.area! - sum(tr.map((s) => s.area!));
    if (target.area / rest >= 0.5) {
      const k = target.area / rest;
      downQ = (down.q! - sum(tr.map((s) => s.q!))) * k;
      if (downQ > 0)
        downEst = {
          method: "unterhalb",
          terms: [{ id: down.id, name: down.name, w: k }, ...tr.map((s) => ({ id: s.id, name: s.name, w: -k }))],
          label: `geschätzt aus Pegel unterhalb: ${down.name}${tr.length ? ` − ${tr.map((s) => s.name).join(" − ")}` : ""} (nach Einzugsgebiet ×${k.toFixed(2).replace(".", ",")})`,
        };
    }
  }
  if (upEst && downEst && upQ < 0.5 * downQ)
    return {
      ...downEst,
      note: `Die Pegel oberhalb ergeben nur ~${fmt(upQ)} m³/s – vermutlich Restwasserstrecke (Kraftwerksausleitung) oberhalb; deshalb aus dem Pegel unterhalb geschätzt (~${fmt(downQ)} m³/s). Momentwert: Bei Schwallbetrieb der Kraftwerke schwankt er über den Tag.`,
    };
  if (upEst) return downEst ? { ...upEst, note: `Gegenprobe aus Pegel unterhalb: ~${fmt(downQ)} m³/s.` } : upEst;
  return downEst;
}

/** Schätzwert aus den Werten der Quellpegel (null, wenn einer fehlt) */
export function applyEstimate(e: Estimate, value: (id: string) => number | null | undefined): number | null {
  let q = 0;
  for (const t of e.terms) {
    const v = value(t.id);
    if (v === null || v === undefined) return null;
    q += t.w * v;
  }
  return q > 0 ? q : null;
}
