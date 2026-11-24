// Engstellen, Schluchten und versteckte Klammen entlang einer analysierten Strecke.
//
// 1. Flussbreite (Sentinel-2): Querprofil alle 25 m, Breite des zusammenhängenden
//    Wasser-/Kiesbett-Streifens um die Flusslinie. Engstelle = Breite deutlich unter
//    der typischen Breite der Umgebung.
// 2. Talquerschnitt (Höhenmodell): alle 50 m die Talbreite 5 m und 20 m über dem
//    Wasserspiegel sowie die Tiefe (Anstieg innerhalb 250 m). Schlucht = schmal und tief.
// 3. Versteckte Klamm: Der Fluss verschwindet im Satellitenbild (Schatten, Bäume,
//    zu schmal), während die Hänge beidseitig steil ansteigen.

import { destination, type LngLat } from "./geo";
import { bearing } from "./geo";
import type { ProfilePoint } from "./analysis";

export type NarrowKind = "engstelle" | "schlucht" | "klamm";

export interface CrossSection {
  d: number;
  p: LngLat;
  /** Breite Wasser/Kiesbett in m (Sentinel-2); null = kein Signal am Fluss */
  width: number | null;
  /** Talbreite 5 m bzw. 20 m über dem Wasserspiegel (m) */
  w5?: number;
  w20?: number;
  /** Tiefe: min(links, rechts) des Anstiegs innerhalb 250 m (m) */
  depth?: number;
}

export interface NarrowFeature {
  kind: NarrowKind;
  d0: number;
  d1: number;
  center: LngLat;
  title: string;
  detail: string;
}

export interface NarrowsResult {
  sections: CrossSection[];
  features: NarrowFeature[];
  /** Sentinel-2-Datum(e), falls genutzt */
  satellite?: string;
  /** Auflösung der Querprofile im Höhenmodell (m) */
  demStep: number;
}

export interface NarrowsOptions {
  /** Höhen für Punkte (gleiche Schnittstelle wie in der Analyse) */
  elevations: (points: LngLat[], onProgress?: (done: number, total: number) => void) => Promise<number[]>;
  /** Sentinel-2-Indizes für Punkte; fehlt → keine Breiten / keine versteckten Klammen */
  satellite?: (points: LngLat[]) => Promise<{ ndwi: Float32Array; ndvi: Float32Array; label: string } | null>;
  /** Abtastung der Höhen-Querprofile (m), z. B. 3 m mit 1-m-Modell, 10 m global */
  demStep?: number;
  /** Schlucht, wenn Talbreite 20 m über Wasser höchstens so breit ist (m) */
  gorgeWidth?: number;
  /** … und die Hänge beidseitig mindestens so hoch sind (m) */
  gorgeDepth?: number;
  onProgress?: (msg: string) => void;
}

const SAT_STEP = 5; // m entlang des Querprofils
const SAT_HALF = 150; // m je Seite
const DEM_HALF = 250;
const DEM_EVERY = 50; // m entlang des Flusses
/** Engstellen nur bei typischer Flussbett-Breite ab diesem Wert (m) */
export const MIN_REF_WIDTH = 30;
/** … und bis zu diesem Wert – breitere Kiesebenen (verzweigte Flüsse) verengen sich natürlich */
export const MAX_REF_WIDTH = 100;

/** Schwellen für Schluchten je nach Höhenmodell (global an der Soča, fein an der Sjoa/Åsengjuvet kalibriert). */
export const GORGE_FINE = { demStep: 3, gorgeWidth: 90, gorgeDepth: 30 };
export const GORGE_GLOBAL = { demStep: 10, gorgeWidth: 140, gorgeDepth: 60 };

/** Fließrichtung an jedem Profilpunkt (aus den Nachbarn). */
function headings(profile: ProfilePoint[]): number[] {
  return profile.map((_, i) => {
    const a = profile[Math.max(0, i - 2)].p, b = profile[Math.min(profile.length - 1, i + 2)].p;
    return bearing(a, b);
  });
}

/** Zählt als Flussbett: Wasser (NDWI > 0) oder unbewachsen (NDVI < 0,3). */
export const isRiverPixel = (ndwi: number, ndvi: number) => !Number.isNaN(ndwi) && (ndwi > 0 || ndvi < 0.3);

/**
 * Breite des zusammenhängenden Flussbett-Streifens in einem Querprofil.
 * `cls` sind die Klassen von links (−half) nach rechts (+half) in festen Schritten.
 * Startpunkt ist das Flussbett-Pixel nächst der Mitte (max. ±20 m), einzelne
 * Lücken (1 Schritt) werden überbrückt.
 */
export function stripWidth(cls: boolean[], step: number): number | null {
  const mid = (cls.length - 1) / 2;
  const reach = Math.round(20 / step);
  let seed = -1;
  for (let k = 0; k <= reach && seed < 0; k++) {
    if (cls[Math.round(mid) - k]) seed = Math.round(mid) - k;
    else if (cls[Math.round(mid) + k]) seed = Math.round(mid) + k;
  }
  if (seed < 0) return null;
  let l = seed, r = seed;
  while (l - 1 >= 0 && (cls[l - 1] || (l - 2 >= 0 && cls[l - 2]))) l -= cls[l - 1] ? 1 : 2;
  while (r + 1 < cls.length && (cls[r + 1] || (r + 2 < cls.length && cls[r + 2]))) r += cls[r + 1] ? 1 : 2;
  return (r - l + 1) * step;
}

/** Abstand vom Fluss, bis das Gelände um h über den Wasserspiegel steigt (m), je Seite. */
export function riseDistance(side: number[], z0: number, h: number, step: number): number {
  for (let k = 0; k < side.length; k++) if (side[k] >= z0 + h) return (k + 1) * step;
  return side.length * step;
}

const median = (v: number[]) => {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export async function analyzeNarrows(profile: ProfilePoint[], o: NarrowsOptions): Promise<NarrowsResult> {
  const say = o.onProgress ?? (() => {});
  const head = headings(profile);
  const sections: CrossSection[] = profile.map((p) => ({ d: p.d, p: p.p, width: null }));

  // ---- 1) Breite aus Sentinel-2 -------------------------------------------------
  let satellite: string | undefined;
  if (o.satellite) {
    say("Flussbreite aus Sentinel-2 messen …");
    const nPer = 2 * Math.round(SAT_HALF / SAT_STEP) + 1;
    const pts: LngLat[] = [];
    profile.forEach((p, i) => {
      for (let k = 0; k < nPer; k++) {
        const off = -SAT_HALF + k * SAT_STEP;
        pts.push(off === 0 ? p.p : destination(p.p, Math.abs(off), head[i] + (off < 0 ? -90 : 90)));
      }
    });
    try {
      const sat = await o.satellite(pts);
      if (sat) {
        satellite = sat.label;
        profile.forEach((_, i) => {
          const cls: boolean[] = [];
          for (let k = 0; k < nPer; k++) cls.push(isRiverPixel(sat.ndwi[i * nPer + k], sat.ndvi[i * nPer + k]));
          sections[i].width = stripWidth(cls, SAT_STEP);
        });
      }
    } catch (e) {
      say(`Sentinel-2 nicht verfügbar (${(e as Error).message})`);
    }
  }

  // ---- 2) Talquerschnitte aus dem Höhenmodell ------------------------------------
  say("Talquerschnitte berechnen …");
  const demStep = o.demStep ?? 10;
  const nSide = Math.round(DEM_HALF / demStep);
  const every = Math.max(1, Math.round(DEM_EVERY / (profile[1] ? profile[1].d - profile[0].d : DEM_EVERY)));
  const idx: number[] = [];
  for (let i = 0; i < profile.length; i += every) idx.push(i);
  const qpts: LngLat[] = [];
  for (const i of idx)
    for (const side of [-90, 90])
      for (let k = 1; k <= nSide; k++) qpts.push(destination(profile[i].p, k * demStep, head[i] + side));
  const zq = await o.elevations(qpts, (a, b) => say(`Talquerschnitte ${Math.round((a / b) * 100)} %`));
  idx.forEach((i, j) => {
    const base = j * 2 * nSide;
    const left = zq.slice(base, base + nSide), right = zq.slice(base + nSide, base + 2 * nSide);
    // Wasserspiegel: tiefster Wert aus Talboden-Suche und den ersten Querprofilpunkten
    const z0 = Math.min(profile[i].floor, ...left.slice(0, 2), ...right.slice(0, 2));
    const s = sections[i];
    s.w5 = riseDistance(left, z0, 5, demStep) + riseDistance(right, z0, 5, demStep);
    s.w20 = riseDistance(left, z0, 20, demStep) + riseDistance(right, z0, 20, demStep);
    s.depth = Math.min(Math.max(...left) - z0, Math.max(...right) - z0);
  });

  // ---- Merkmale ableiten ---------------------------------------------------------
  const features: NarrowFeature[] = [];
  const group = (flags: boolean[], minLen: number, make: (i0: number, i1: number) => NarrowFeature | null) => {
    let start = -1;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        const i1 = i - 1;
        if (profile[i1].d - profile[start].d + (profile[1]?.d ?? 0) >= minLen) {
          const f = make(start, i1);
          if (f) features.push(f);
        }
        start = -1;
      }
    }
  };
  const centerOf = (i0: number, i1: number) => profile[Math.round((i0 + i1) / 2)].p;
  const km = (d: number) => (d / 1000).toFixed(1).replace(".", ",");

  // Engstellen: Breite ≤ 50 % der typischen Breite (±1 km) und mindestens 15 m schmaler.
  // Nur wo das Flussbett typischerweise ≥ 30 m breit ist (≥ 3 Sentinel-2-Pixel) –
  // schmalere Flüsse kann der Satellit nicht verlässlich in der Breite auflösen.
  if (satellite) {
    const widths = sections.map((s) => s.width);
    const smooth = widths.map((_, i) => {
      const v = widths.slice(Math.max(0, i - 1), i + 2).filter((x): x is number => x !== null);
      return v.length ? median(v) : null;
    });
    const ref = profile.map((p) => {
      const v = sections.filter((s) => Math.abs(s.d - p.d) <= 1000 && s.width !== null).map((s) => s.width!);
      return v.length >= 8 ? median(v) : NaN;
    });
    // Nachbarprofile müssen ebenfalls sichtbares Flussbett zeigen – am Rand verdeckter
    // Abschnitte (Schatten, Bäume) entstehen sonst scheinbare Verengungen
    const stable = (i: number) => widths.slice(Math.max(0, i - 2), i + 3).every((x) => x !== null);
    const narrow = smooth.map((w, i) => w !== null && stable(i) && ref[i] >= MIN_REF_WIDTH && ref[i] <= MAX_REF_WIDTH && w <= 0.5 * ref[i] && ref[i] - w >= 15);
    // Engstellen, die weniger als 100 m auseinanderliegen, zusammenfassen
    for (let i = 0, last = -Infinity; i < narrow.length; i++) {
      if (!narrow[i]) continue;
      if (profile[i].d - last <= 100) for (let k = i - 1; k >= 0 && !narrow[k]; k--) narrow[k] = true;
      last = profile[i].d;
    }
    group(narrow, 25, (i0, i1) => {
      const wmin = Math.min(...smooth.slice(i0, i1 + 1).filter((x): x is number => x !== null));
      const r = median(ref.slice(i0, i1 + 1).filter((x) => !Number.isNaN(x)));
      return {
        kind: "engstelle",
        d0: profile[i0].d,
        d1: profile[i1].d,
        center: centerOf(i0, i1),
        title: `Engstelle: ~${Math.round(wmin)} m breit`,
        detail: `km ${km(profile[i0].d)}–${km(profile[i1].d)} · sonst ~${Math.round(r)} m Flussbett (Sentinel-2, 10 m Auflösung)`,
      };
    });
  }

  // Schluchten: Talbreite 20 m über Wasser schmal und beidseitig tief
  const gw = o.gorgeWidth ?? GORGE_GLOBAL.gorgeWidth, gd = o.gorgeDepth ?? GORGE_GLOBAL.gorgeDepth;
  const gorge = sections.map((s) => s.w20 !== undefined && s.w20 <= gw && (s.depth ?? 0) >= gd);
  // Lücken zwischen den 50-m-Querprofilen schließen
  for (let i = 0; i < gorge.length; i++) if (sections[i].w20 === undefined) gorge[i] = gorge[i - (i % every)] && (gorge[i - (i % every) + every] ?? false);
  group(gorge, 100, (i0, i1) => {
    const ss = sections.slice(i0, i1 + 1).filter((s) => s.w20 !== undefined);
    const wmin = Math.min(...ss.map((s) => s.w20!));
    const dep = median(ss.map((s) => s.depth!));
    return {
      kind: "schlucht",
      d0: profile[i0].d,
      d1: profile[i1].d,
      center: centerOf(i0, i1),
      title: `Schlucht: ${Math.round(profile[i1].d - profile[i0].d)} m lang`,
      detail:
        `km ${km(profile[i0].d)}–${km(profile[i1].d)} · 20 m über Wasser nur ~${Math.round(wmin)} m breit, ~${Math.round(dep)} m tief · Umtragen schwierig` +
        (demStep > 5 ? " (grobes Höhenmodell: echte Breite meist geringer)" : ""),
    };
  });

  // Versteckte Klamm: kein Flussbett im Satellitenbild über ≥ 75 m, vorher und nachher
  // sichtbar, Hänge beidseitig ≥ 25 m hoch und Tal 20 m über Wasser ≤ 150 m breit
  if (satellite) {
    const visible = sections.map((s) => s.width !== null);
    const steep = sections.map((_, i) => {
      const j = i - (i % every);
      const s = sections[j];
      return s.depth !== undefined && s.depth >= 25 && (s.w20 ?? Infinity) <= 150;
    });
    const hidden = visible.map((v, i) => !v && steep[i]);
    group(hidden, 75, (i0, i1) => {
      const before = visible.slice(Math.max(0, i0 - 20), i0).some(Boolean);
      const after = visible.slice(i1 + 1, i1 + 21).some(Boolean);
      if (!before || !after) return null;
      const dep = median(sections.slice(i0, i1 + 1).filter((s) => s.depth !== undefined).map((s) => s.depth!));
      return {
        kind: "klamm",
        d0: profile[i0].d,
        d1: profile[i1].d,
        center: centerOf(i0, i1),
        title: `Mögliche Klamm: Fluss ${Math.round(profile[i1].d - profile[i0].d)} m unsichtbar`,
        detail: `km ${km(profile[i0].d)}–${km(profile[i1].d)} · im Satellitenbild verdeckt (Schatten, Bäume oder sehr schmal), Hänge ~${Math.round(dep)} m hoch · unbedingt erkunden`,
      };
    });
  }

  features.sort((a, b) => a.d0 - b.d0);
  return { sections, features: mergeGorges(features, profile), satellite, demStep };
}

/**
 * Schlucht- und Klamm-Meldungen, die weniger als 1 km auseinanderliegen, zu einer
 * Schluchtstrecke zusammenfassen. Helle Felswände in der Schlucht sehen im Satellitenbild
 * wie Flussbett aus – die Meldungen liegen dann oft am Anfang und Ende der eigentlichen Klamm.
 */
export function mergeGorges(features: NarrowFeature[], profile: ProfilePoint[], gap = 1000): NarrowFeature[] {
  const out: NarrowFeature[] = [];
  let cur: NarrowFeature[] = [];
  const km = (d: number) => (d / 1000).toFixed(1).replace(".", ",");
  const flush = () => {
    if (cur.length === 1) out.push(cur[0]);
    else if (cur.length > 1) {
      const d0 = Math.min(...cur.map((f) => f.d0)), d1 = Math.max(...cur.map((f) => f.d1));
      const mid = (d0 + d1) / 2;
      const center = profile.reduce((b, q) => (Math.abs(q.d - mid) < Math.abs(b.d - mid) ? q : b)).p;
      const hasKlamm = cur.some((f) => f.kind === "klamm");
      out.push({
        kind: hasKlamm ? "klamm" : "schlucht",
        d0,
        d1,
        center,
        title: `${hasKlamm ? "Schlucht-/Klammstrecke" : "Schluchtstrecke"}: ${Math.round(d1 - d0)} m`,
        detail: `km ${km(d0)}–${km(d1)} · ${cur.length} Hinweise: ${cur.map((f) => f.title.split(":")[0].replace("Mögliche ", "")).join(", ")} · Umtragen/Ausstieg prüfen, unbedingt erkunden`,
      });
    }
    cur = [];
  };
  for (const f of features) {
    if (f.kind === "engstelle") {
      out.push(f);
      continue;
    }
    if (cur.length && f.d0 - Math.max(...cur.map((c) => c.d1)) > gap) flush();
    cur.push(f);
  }
  flush();
  return out.sort((a, b) => a.d0 - b.d0);
}
