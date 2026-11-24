// Kern der Gefälleanalyse: Längsprofil, Glättung, Abschnitte, Hotspots, Talenge.

import { destination, type LngLat, resample, type Sample } from "./geo";

export type ElevationFn = (points: LngLat[], onProgress?: (done: number, total: number) => void) => Promise<number[]>;

export interface GradientClass {
  id: string;
  min: number; // m/km
  label: string;
  hint: string;
  color: string;
}

/**
 * Gefälleklassen (m/km). Die Hinweise sind Faustregeln: Die tatsächliche Schwierigkeit
 * hängt stark von Wasserführung, Flussbreite, Blockgröße und Verblockung ab.
 */
export const GRADIENT_CLASSES: GradientClass[] = [
  { id: "flat", min: 0, label: "< 3 m/km · flach", hint: "meist zahm (WW I–II), Wind und Strecke statt Wildwasser", color: "#2b83ba" },
  { id: "moderate", min: 3, label: "3–8 m/km · mäßig", hint: "häufig WW II, einzelne Schwälle", color: "#64bc9c" },
  { id: "marked", min: 8, label: "8–15 m/km · deutlich", hint: "häufig WW II–III, bei Hochwasser mehr", color: "#c7e57e" },
  { id: "steep", min: 15, label: "15–30 m/km · steil", hint: "WW III–IV möglich, Stellen besichtigen", color: "#fdc861" },
  { id: "verysteep", min: 30, label: "30–60 m/km · sehr steil", hint: "Wildbach-Charakter (WW IV–V), Umtragen wahrscheinlich", color: "#f46d43" },
  { id: "extreme", min: 60, label: "> 60 m/km · extrem", hint: "Stufen, Fälle – meist nicht fahrbar", color: "#b2182b" },
];

export function classify(gradient: number): GradientClass {
  let c = GRADIENT_CLASSES[0];
  for (const k of GRADIENT_CLASSES) if (gradient >= k.min) c = k;
  return c;
}

export interface AnalysisOptions {
  /** Abtastabstand entlang des Flusses (m) */
  step: number;
  /** Länge der ausgewerteten Abschnitte (m) */
  segmentLength: number;
  /** Fensterlänge für die Hotspot-Suche (m) */
  hotspotWindow: number;
  /** Ab diesem Gefälle (m/km) gilt ein Fenster als Hotspot */
  hotspotThreshold: number;
  /** Mindest-Höhenverlust (m) eines Hotspots – unterdrückt Rauschen des Höhenmodells */
  hotspotMinDrop: number;
  /**
   * Gleitendes Mittel (m) nach der monotonen Anpassung. Höhenmodelle liefern im Talboden
   * Treppenstufen (1-m-Quantisierung, Pixelraster); das Mittel verteilt sie auf die Strecke.
   */
  smoothWindow: number;
  /** Querabstände (m), an denen nach dem Talboden gesucht wird */
  floorOffsets: number[];
  /** Querabstand (m) für die Talenge-Prüfung */
  confinementOffset: number;
  /** Anstieg (m) auf beiden Seiten innerhalb confinementOffset, ab dem eine Talenge gemeldet wird */
  confinementRise: number;
}

export const DEFAULT_OPTIONS: AnalysisOptions = {
  step: 25,
  segmentLength: 500,
  hotspotWindow: 250,
  hotspotThreshold: 30,
  hotspotMinDrop: 10,
  smoothWindow: 300,
  floorOffsets: [15, 30],
  confinementOffset: 100,
  confinementRise: 20,
};

export interface ProfilePoint {
  d: number;
  p: LngLat;
  /** Höhe direkt unter der Flusslinie */
  raw: number;
  /** tiefster Wert quer zur Linie (Talboden) */
  floor: number;
  /** geglättet, monoton fallend */
  z: number;
  /** min. Hangüberhöhung links/rechts im Querabstand (m) */
  walls: number;
}

export interface Segment {
  index: number;
  d0: number;
  d1: number;
  z0: number;
  z1: number;
  gradient: number; // m/km
  cls: GradientClass;
  confined: boolean;
  coords: LngLat[];
}

export interface Hotspot {
  d0: number;
  d1: number;
  drop: number;
  maxGradient: number;
  center: LngLat;
  confined: boolean;
}

export interface Analysis {
  reversed: boolean;
  length: number;
  zStart: number;
  zEnd: number;
  drop: number;
  meanGradient: number;
  maxSegmentGradient: number;
  confinedLength: number;
  profile: ProfilePoint[];
  segments: Segment[];
  hotspots: Hotspot[];
  classShare: { cls: GradientClass; length: number }[];
}

/**
 * Isotone Regression (Pool-Adjacent-Violators): beste monoton fallende Näherung.
 * Flüsse fließen nicht bergauf – Ausreißer im Höhenmodell (Brücken, Hangpixel,
 * Vegetation) werden dadurch ausgeglichen, ohne echte Stufen zu verwischen.
 */
export function monotoneDecreasing(values: number[]): number[] {
  const blocks: { sum: number; n: number }[] = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n) break;
      a.sum += b.sum;
      a.n += b.n;
      blocks.pop();
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
  return out;
}

/** Zentriertes gleitendes Mittel (Halbbreite k Stützpunkte); zu den Enden hin symmetrisch verkürzt, damit Start- und Endhöhe erhalten bleiben. */
export function movingAverage(values: number[], k: number): number[] {
  if (k <= 0) return [...values];
  const pre = [0];
  for (const v of values) pre.push(pre[pre.length - 1] + v);
  return values.map((_, i) => {
    const h = Math.min(k, i, values.length - 1 - i);
    const a = i - h, b = i + h;
    return (pre[b + 1] - pre[a]) / (b - a + 1);
  });
}

function interpZ(profile: ProfilePoint[], d: number): number {
  if (d <= profile[0].d) return profile[0].z;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].d >= d) {
      const a = profile[i - 1], b = profile[i];
      const t = (d - a.d) / (b.d - a.d || 1);
      return a.z + (b.z - a.z) * t;
    }
  }
  return profile[profile.length - 1].z;
}

export async function analyzeRiver(
  line: LngLat[],
  elevations: ElevationFn,
  opts: Partial<AnalysisOptions> = {},
  onProgress?: (msg: string) => void,
): Promise<Analysis> {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  let samples: Sample[] = resample(line, o.step);

  // Abfragepunkte: Mitte, Querprofil Talboden, Querprofil Talenge
  const offsets = [...o.floorOffsets, o.confinementOffset];
  const buildQuery = (ss: Sample[]) => {
    const pts: LngLat[] = [];
    for (const s of ss) {
      pts.push(s.p);
      for (const off of offsets) {
        pts.push(destination(s.p, off, s.heading - 90));
        pts.push(destination(s.p, off, s.heading + 90));
      }
    }
    return pts;
  };
  const perSample = 1 + offsets.length * 2;

  onProgress?.("Höhendaten laden …");
  let z = await elevations(buildQuery(samples), (a, b) => onProgress?.(`Höhendaten ${Math.round((a / b) * 100)} %`));

  // Fließrichtung prüfen: Start muss höher liegen als Ende
  let reversed = false;
  const head = z[0], tail = z[(samples.length - 1) * perSample];
  if (head < tail) {
    reversed = true;
    samples = resample([...line].reverse(), o.step);
    z = await elevations(buildQuery(samples));
  }

  const nFloor = o.floorOffsets.length * 2;
  const profileRaw = samples.map((s, i) => {
    const base = i * perSample;
    const raw = z[base];
    const floor = Math.min(raw, ...z.slice(base + 1, base + 1 + nFloor));
    const left = z[base + 1 + nFloor];
    const right = z[base + 2 + nFloor];
    return { d: s.d, p: s.p, raw, floor, walls: Math.min(left, right) - floor };
  });
  const smooth = movingAverage(monotoneDecreasing(profileRaw.map((p) => p.floor)), Math.round(o.smoothWindow / o.step / 2));
  const profile: ProfilePoint[] = profileRaw.map((p, i) => ({ ...p, z: smooth[i] }));

  const length = profile[profile.length - 1].d;
  const confinedAt = (d0: number, d1: number) => {
    const pts = profile.filter((p) => p.d >= d0 && p.d <= d1);
    const n = pts.filter((p) => p.walls >= o.confinementRise).length;
    return pts.length > 0 && n / pts.length >= 0.5;
  };

  // Abschnitte
  const segments: Segment[] = [];
  const nSeg = Math.max(1, Math.round(length / o.segmentLength));
  for (let k = 0; k < nSeg; k++) {
    const d0 = (length * k) / nSeg;
    const d1 = (length * (k + 1)) / nSeg;
    const z0 = interpZ(profile, d0), z1 = interpZ(profile, d1);
    const gradient = ((z0 - z1) / (d1 - d0)) * 1000;
    const coords = profile.filter((p) => p.d >= d0 - 1e-6 && p.d <= d1 + 1e-6).map((p) => p.p);
    segments.push({ index: k, d0, d1, z0, z1, gradient, cls: classify(gradient), confined: confinedAt(d0, d1), coords });
  }

  // Hotspots: gleitendes Fenster, zusammenhängende Überschreitungen zusammenfassen
  const hotspots: Hotspot[] = [];
  const w = Math.min(o.hotspotWindow, length);
  let cur: { d0: number; d1: number; max: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const drop = interpZ(profile, cur.d0) - interpZ(profile, cur.d1);
    const mid = (cur.d0 + cur.d1) / 2;
    const center = profile.reduce((a, b) => (Math.abs(b.d - mid) < Math.abs(a.d - mid) ? b : a)).p;
    if (drop >= o.hotspotMinDrop) hotspots.push({ d0: cur.d0, d1: cur.d1, drop, maxGradient: cur.max, center, confined: confinedAt(cur.d0, cur.d1) });
    cur = null;
  };
  for (let d = 0; d + w <= length + 1e-6; d += o.step) {
    const g = ((interpZ(profile, d) - interpZ(profile, d + w)) / w) * 1000;
    if (g >= o.hotspotThreshold) {
      if (cur && d <= cur.d1) {
        cur.d1 = d + w;
        cur.max = Math.max(cur.max, g);
      } else {
        flush();
        cur = { d0: d, d1: d + w, max: g };
      }
    }
  }
  flush();

  const classShare = GRADIENT_CLASSES.map((cls) => ({
    cls,
    length: segments.filter((s) => s.cls.id === cls.id).reduce((a, s) => a + (s.d1 - s.d0), 0),
  }));

  const zStart = profile[0].z, zEnd = profile[profile.length - 1].z;
  return {
    reversed,
    length,
    zStart,
    zEnd,
    drop: zStart - zEnd,
    meanGradient: ((zStart - zEnd) / length) * 1000,
    maxSegmentGradient: Math.max(...segments.map((s) => s.gradient)),
    confinedLength: segments.filter((s) => s.confined).reduce((a, s) => a + (s.d1 - s.d0), 0),
    profile,
    segments,
    hotspots,
    classShare,
  };
}
