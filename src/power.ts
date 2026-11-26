// Wucht-Bewertung: Strömungsleistung je Meter Fluss Ω = ρ · g · Q · S  (W/m).
// Große Wassermengen machen auch flache Flüsse schwer (Wuchtwasser), kleine Wassermengen
// entschärfen steile Bäche. Die Klassen sind an Referenzflüssen kalibriert:
//   Nahe Kirn–Monzingen (WW I) ~ 360 W/m · Soča Srpenica–Trnovo (WW II–III+) ~ 1 700 W/m ·
//   Markarfljót oberhalb der Schlucht (WW II–III) ~ 2 300 (MQ) … 5 300 W/m (Sommer).

import { GRADIENT_CLASSES, type Analysis, type GradientClass } from "./analysis";

const RHO_G = 1000 * 9.81;

/** Grenzen in W/m: < 300 Zahmwasser, 300–1000 WW I, 1000–2500 WW II, 2500–6000 WW III, 6000–15000 WW IV, > 15000 WW V+ */
export const POWER_LIMITS = [0, 300, 1000, 2500, 6000, 15000];

/** Strömungsleistung (W/m) für Abfluss q (m³/s) und Gefälle (m/km). */
export const streamPower = (q: number, gradientPerKm: number) => RHO_G * q * Math.max(0, gradientPerKm) / 1000;

/** Klassenindex 0–5 (wie GRADIENT_CLASSES) aus der Strömungsleistung. */
export function powerClassIndex(omega: number): number {
  let k = 0;
  POWER_LIMITS.forEach((lim, i) => {
    if (omega >= lim) k = i;
  });
  return k;
}

export type RatingMode = "gradient" | "power" | "combined";

/** Legende für die Wucht-/kombinierte Bewertung: gleiche Farben, Beschriftung als Schwierigkeit. */
const RATED_LABELS = ["Zahmwasser", "WW I", "WW II", "WW II–III", "WW III–IV", "WW IV+"];
export const RATED_CLASSES: GradientClass[] = GRADIENT_CLASSES.map((c, i) => ({
  ...c,
  label: RATED_LABELS[i],
  hint: i === 0 ? "kein Wildwasser" : i >= 4 ? "Stellen besichtigen, Umtragen einplanen" : "",
}));

/**
 * Bewertung je Abschnitt neu einfärben: nach Gefälle (wie bisher), nach Wucht oder kombiniert
 * (die jeweils schwierigere Einstufung). Liefert eine Kopie der Analyse mit ersetzten Klassen,
 * damit Karte, Profil und Legende unverändert weiterarbeiten können.
 */
export function rateAnalysis(a: Analysis, mode: RatingMode, q: number | null): Analysis {
  if (mode === "gradient" || q === null || !(q > 0)) return a;
  const gi = (c: GradientClass) => GRADIENT_CLASSES.findIndex((x) => x.id === c.id);
  const segments = a.segments.map((s) => {
    const p = powerClassIndex(streamPower(q, s.gradient));
    const k = mode === "power" ? p : Math.max(p, gi(s.cls));
    return { ...s, cls: RATED_CLASSES[k] };
  });
  const classShare = RATED_CLASSES.map((cls) => ({
    cls,
    length: segments.filter((s) => s.cls.id === cls.id).reduce((acc, s) => acc + (s.d1 - s.d0), 0),
  }));
  return { ...a, segments, classShare };
}

/**
 * Stehende Wellen (Rollwellen, Wellenzüge unter Stufen) laufen genau so schnell gegen die Strömung,
 * wie das Wasser fließt. Dispersionsrelation mit Wassertiefe h:
 *   v = √(g·λ/2π · tanh(2πh/λ))
 * Tiefes Wasser (h ≳ λ/2): tanh → 1, v = √(g·λ/2π). Bei flachem Wasser sind die Wellen kürzer, d. h. der
 * gleiche Kammabstand bedeutet dort eine langsamere Strömung. Ohne Tiefe: Tiefwasser-Näherung.
 */
export function waveVelocity(lambda: number, depth = Infinity): number {
  const t = Number.isFinite(depth) ? Math.tanh((2 * Math.PI * depth) / lambda) : 1;
  return Math.sqrt(((9.81 * lambda) / (2 * Math.PI)) * t);
}

/** Übliche Wassertiefe in Wellenzügen von Packraft-Flüssen (m) */
export const WAVE_DEPTHS: [number, number] = [0.5, 2];

/** Spanne der Fließgeschwindigkeit für die übliche Tiefe (flach … tief); `shallowMatters`, wenn die Tiefe
 *  das Ergebnis spürbar (> 10 %) beeinflusst – ab etwa λ > 4 m. */
export function waveVelocityRange(lambda: number, depths: [number, number] = WAVE_DEPTHS) {
  const min = waveVelocity(lambda, depths[0]), max = waveVelocity(lambda, depths[1]), deep = waveVelocity(lambda);
  return { min, max, deep, shallowMatters: lambda > 4 };
}
