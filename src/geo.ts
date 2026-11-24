// Geometrie-Hilfsfunktionen (WGS84, Koordinaten als [lon, lat]).

export type LngLat = [number, number];

const R = 6371008.8; // mittlerer Erdradius in m

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Großkreisdistanz in Metern. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Gesamtlänge einer Linie in Metern. */
export function lineLength(line: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

/** Kumulierte Distanzen je Stützpunkt. */
export function cumulative(line: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

/** Anfangskurs von a nach b in Grad (0 = Nord, im Uhrzeigersinn). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Zielpunkt bei gegebener Distanz (m) und Kurs (Grad). */
export function destination(p: LngLat, distance: number, bearingDeg: number): LngLat {
  const δ = distance / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(p[1]);
  const λ1 = toRad(p[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [toDeg(λ2), toDeg(φ2)];
}

export interface Sample {
  /** Distanz ab Startpunkt in m */
  d: number;
  p: LngLat;
  /** Fließrichtung an dieser Stelle (Grad) */
  heading: number;
}

/** Tastet eine Linie in gleichmäßigen Abständen ab (inkl. Endpunkt). */
export function resample(line: LngLat[], step: number): Sample[] {
  if (line.length < 2) throw new Error("Linie braucht mindestens zwei Punkte");
  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  const out: Sample[] = [];
  let seg = 0;
  const n = Math.max(1, Math.round(total / step));
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    while (seg < line.length - 2 && cum[seg + 1] < d) seg++;
    const a = line[seg];
    const b = line[seg + 1];
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 0 ? (d - cum[seg]) / segLen : 0;
    out.push({
      d,
      p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      heading: bearing(a, b),
    });
  }
  return out;
}

/** Projektion eines Punktes auf die Linie: liefert Distanz entlang der Linie und Abstand. */
export function locateOnLine(line: LngLat[], p: LngLat): { d: number; offset: number; point: LngLat } {
  const cum = cumulative(line);
  let best = { d: 0, offset: Infinity, point: line[0] };
  // lokale äquirektanguläre Projektion je Segment – genau genug für Snapping
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const kx = Math.cos(toRad((a[1] + b[1]) / 2));
    const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const off = haversine(q, p);
    if (off < best.offset) best = { d: cum[i] + (cum[i + 1] - cum[i]) * t, offset: off, point: q };
  }
  return best;
}

/** Schneidet den Linienabschnitt zwischen den Distanzen d0 < d1 heraus. */
export function sliceLine(line: LngLat[], d0: number, d1: number): LngLat[] {
  if (d0 > d1) [d0, d1] = [d1, d0];
  const cum = cumulative(line);
  const interp = (d: number): LngLat => {
    let i = 0;
    while (i < line.length - 2 && cum[i + 1] < d) i++;
    const len = cum[i + 1] - cum[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / len)) : 0;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  };
  const out: LngLat[] = [interp(d0)];
  for (let i = 0; i < line.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(line[i]);
  out.push(interp(d1));
  return out;
}
