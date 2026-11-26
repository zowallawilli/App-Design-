// Export der Analyse als GPX (für GPS/Offline-Karten), CSV und GeoJSON.

import type { Analysis } from "./analysis";
import type { NarrowsResult } from "./narrows";
import type { WhitewaterSpot } from "./whitewater";
import type { LngLat } from "./geo";

/** Gefahrenstelle für den Export (siehe hazards() in main.ts) */
export interface HazardOut { d: number; center: LngLat; kind: string; title: string; text: string }
/** weitere Stelle als Wegpunkt: eigene Stelle oder aus OpenStreetMap (`source` landet im GeoJSON) */
export interface PlaceOut { d: number; center: LngLat; title: string; text: string; sym: string; type: string; source: "eigene" | "osm"; kind: string }


/** Kurzbeschreibung einer Schwallstelle (Indikator) für Wegpunkte/Export */
export function spotText(s: WhitewaterSpot): string {
  return `km ${km(s.d0)}–${km(s.d1)}: Weißwasser im Luftbild (Indikator) – ${s.area.toFixed(0)} m², ${s.peakDensity.toFixed(1)} m² je Flussmeter, ${Math.round(s.peakFrac * 100)} % der Wasserfläche` +
    (s.notes.length ? `; ${s.notes.join("; ")}` : "") + ". Vor Ort besichtigen.";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const km = (m: number) => (m / 1000).toFixed(2);

/** Optionen für den GPX-Export */
export interface GpxOptions {
  /** steile Abschnitte (≥ steepFrom m/km) zusätzlich als eigene Tracks + Wegpunkt am Beginn */
  steep?: boolean;
  steepFrom?: number;
  /** ganze Strecke nach Gefälleklassen in einzelne Tracks teilen (statt eines durchgehenden Tracks) */
  split?: boolean;
  /** Kilometer-Wegpunkte */
  kmMarks?: boolean;
}

/** zusammenhängender Abschnitt gleicher Art (für Tracks/Wegpunkte) */
export interface Stretch { d0: number; d1: number; gradient: number; maxGradient: number; label: string; hint: string; color: string; coords: LngLat[] }

/** Benachbarte Gefälle-Abschnitte zusammenfassen: nach gleicher Klasse (`byClass`) bzw. alle ≥ minGradient. */
export function stretches(a: Analysis, opt: { byClass?: boolean; minGradient?: number } = {}): Stretch[] {
  const out: Stretch[] = [];
  const min = opt.minGradient ?? -Infinity;
  for (const s of a.segments) {
    if (s.gradient < min) continue;
    const last = out[out.length - 1];
    const joins = last && Math.abs(last.d1 - s.d0) < 1 && (opt.byClass ? last.label === s.cls.label : true);
    if (joins) {
      const len0 = last.d1 - last.d0, len1 = s.d1 - s.d0;
      last.gradient = (last.gradient * len0 + s.gradient * len1) / (len0 + len1);
      if (s.gradient > last.maxGradient) Object.assign(last, { maxGradient: s.gradient, label: s.cls.label, hint: s.cls.hint, color: s.cls.color });
      last.d1 = s.d1;
      last.coords.push(...s.coords.slice(1));
    } else out.push({ d0: s.d0, d1: s.d1, gradient: s.gradient, maxGradient: s.gradient, label: s.cls.label, hint: s.cls.hint, color: s.cls.color, coords: [...s.coords] });
  }
  return out;
}

/** Garmin kennt nur benannte Farben (gpxx:DisplayColor) – nächste zur Hex-Farbe */
const GARMIN_COLORS: [string, number[]][] = [
  ["Red", [255, 0, 0]], ["DarkRed", [139, 0, 0]], ["Green", [0, 255, 0]], ["DarkGreen", [0, 100, 0]], ["Blue", [0, 0, 255]],
  ["DarkBlue", [0, 0, 139]], ["Yellow", [255, 255, 0]], ["DarkYellow", [180, 160, 0]], ["Magenta", [255, 0, 255]], ["Cyan", [0, 255, 255]], ["DarkCyan", [0, 139, 139]],
];
export function garminColor(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let best = GARMIN_COLORS[0][0], bd = Infinity;
  for (const [n, rgb] of GARMIN_COLORS) {
    const d = rgb.reduce((acc, v, i) => acc + (v - c[i]) ** 2, 0);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
/** Linienfarbe für Apps, die sie lesen: Garmin (benannt), gpx_style und OsmAnd (Hex). Gaia GPS ignoriert sie beim Import. */
const colorExt = (hex: string) =>
  `    <extensions>\n      <gpxx:TrackExtension><gpxx:DisplayColor>${garminColor(hex)}</gpxx:DisplayColor></gpxx:TrackExtension>\n` +
  `      <gpx_style:line><gpx_style:color>${hex.slice(1).toUpperCase()}</gpx_style:color><gpx_style:width>5</gpx_style:width></gpx_style:line>\n` +
  `      <osmand:color>${hex}</osmand:color>\n    </extensions>\n`;

const kmDe = (m: number) => (m / 1000).toFixed(1).replace(".", ",");
/** kurze WW-Angabe aus dem Hinweis der Gefälleklasse („WW II–III, …“ → „WW II–III“) */
const wwShort = (hint: string) => /WW [IV+–]+/.exec(hint)?.[0] ?? hint.split(",")[0];

/** GPX 1.1 für GPS-Apps (Gaia GPS, Garmin Explore, OsmAnd …): Strecke mit Höhen als Track, Ein-/Ausstieg,
 *  Gefahren-, Schwallstellen und Schluchten als Wegpunkte (mit Höhe, km und Beschreibung). Steile Abschnitte
 *  zusätzlich als eigene, benannte Tracks + Wegpunkt am Beginn – Farben lesen nicht alle Apps (Gaia nicht). */
export function toGpx(a: Analysis, name: string, narrows?: NarrowsResult, whitewater: WhitewaterSpot[] = [], hazards: HazardOut[] = [], opt: GpxOptions = {}, places: PlaceOut[] = []): string {
  const o = { steep: true, steepFrom: 15, split: false, kmMarks: false, ...opt };
  const zAt = (d: number) => a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).z;
  const pAt = (d: number) => a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).p;
  const wpt = (p: LngLat, d: number, title: string, desc: string, sym: string, type: string) =>
    `  <wpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}">\n    <ele>${zAt(d).toFixed(1)}</ele>\n    <name>${esc(title)}</name>\n` +
    `    <desc>${esc(desc)}</desc>\n    <sym>${sym}</sym>\n    <type>${esc(type)}</type>\n  </wpt>`;
  const first = a.profile[0], last = a.profile[a.profile.length - 1];
  const ends = [
    wpt(first.p, 0, `Einstieg ${name}`.trim(), `Einstieg · ${Math.round(first.z)} m ü. M.`, "Boat Ramp", "Einstieg"),
    wpt(last.p, a.length, `Ausstieg ${name}`.trim(), `Ausstieg nach ${km(a.length)} km · ${Math.round(last.z)} m ü. M. · ${a.drop.toFixed(0)} m Höhenverlust`, "Boat Ramp", "Ausstieg"),
  ];
  const bkWpts = hazards.map((h) => wpt(h.center, h.d, `Gefahrenstelle km ${km(h.d)}`, `${h.title}: ${h.text}. Indikator – vor Ort prüfen.`, "Danger Area", "Gefahrenstelle"));
  const nrWpts = (narrows?.features ?? []).map((f) =>
    wpt(f.center, (f.d0 + f.d1) / 2, f.title, `km ${km(f.d0)}–${km(f.d1)}: ${f.detail}`, f.kind === "engstelle" ? "Caution" : "Danger Area", f.kind === "engstelle" ? "Engstelle" : "Schlucht"));
  const wwWpts = whitewater.map((s) => wpt(s.center, s.dPeak, `Schwall km ${km(s.dPeak)}`, spotText(s), "Caution", "Schwallstelle"));
  const plWpts = places.map((q) => wpt(q.center, q.d, q.title, q.text, q.sym, q.type));
  const steep = o.steep ? stretches(a, { minGradient: o.steepFrom }) : [];
  const steepName = (s: Stretch) => `Steil km ${kmDe(s.d0)}–${kmDe(s.d1)} · ${Math.round(s.maxGradient)} m/km`;
  const steepDesc = (s: Stretch) =>
    `Steiler Abschnitt km ${km(s.d0)}–${km(s.d1)} (${Math.round(s.d1 - s.d0)} m): Ø ${s.gradient.toFixed(0)} m/km, steilste 250 m–1 km ${s.maxGradient.toFixed(0)} m/km – ` +
    `Gefälle-Indikator ${wwShort(s.hint)}. Aus dem Höhenprofil – vor Ort besichtigen.`;
  const steepWpts = steep.map((s) => wpt(pAt(s.d0), s.d0, `${steepName(s)}`, steepDesc(s), "Caution", "Steilstrecke"));
  const kmWpts = o.kmMarks
    ? Array.from({ length: Math.floor(a.length / 1000) }, (_, i) => (i + 1) * 1000).map((d) => wpt(pAt(d), d, `km ${d / 1000}`, `Flusskilometer ${d / 1000} ab Einstieg · ${Math.round(zAt(d))} m ü. M.`, "Mile Marker", "Kilometer"))
    : [];
  const trkpts = (pts: { p: LngLat; z: number }[]) =>
    pts.map((p) => `      <trkpt lat="${p.p[1].toFixed(6)}" lon="${p.p[0].toFixed(6)}"><ele>${p.z.toFixed(1)}</ele></trkpt>`).join("\n");
  const ptsIn = (d0: number, d1: number) => a.profile.filter((p) => p.d >= d0 - 1e-6 && p.d <= d1 + 1e-6);
  const trk = (title: string, desc: string, type: string, color: string, pts: { p: LngLat; z: number }[]) =>
    `  <trk>\n    <name>${esc(title)}</name>\n    <desc>${esc(desc)}</desc>\n    <type>${esc(type)}</type>\n${colorExt(color)}    <trkseg>\n${trkpts(pts)}\n    </trkseg>\n  </trk>`;
  // Gefälle je Abschnitt als Text (Gaia liest keine Linienfarben)
  const steepTxt = steep.slice(0, 30).map((s) => `km ${kmDe(s.d0)}–${kmDe(s.d1)} ${Math.round(s.maxGradient)} m/km (${wwShort(s.hint)})`);
  const desc =
    `${km(a.length)} km, ${a.drop.toFixed(0)} m Höhenverlust, Ø ${a.meanGradient.toFixed(1)} m/km. ` +
    (steepTxt.length ? `Steile Abschnitte: ${steepTxt.join("; ")}. ` : "") +
    "Gefälle ist ein Indikator, keine Schwierigkeitsbewertung – vor Ort besichtigen. Erstellt mit Packraft-Planer.";
  const main = o.split
    ? stretches(a, { byClass: true }).map((s) =>
        trk(`${name} · km ${kmDe(s.d0)}–${kmDe(s.d1)} · ${Math.round(s.gradient)} m/km`, `${s.label}: ${s.hint}. Indikator aus dem Höhenprofil.`, "Packrafting", s.color, ptsIn(s.d0, s.d1)))
    : [trk(name, desc, "Packrafting", "#1f78b4", a.profile)];
  const steepTrks = o.steep && !o.split ? steep.map((s) => trk(steepName(s), steepDesc(s), "Steilstrecke", s.color, ptsIn(s.d0, s.d1))) : [];
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Packraft-Planer" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"
  xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"
  xmlns:osmand="https://osmand.net">
  <metadata><name>${esc(name)}</name><desc>${esc(desc)}</desc></metadata>
${[...ends, ...steepWpts, ...nrWpts, ...bkWpts, ...wwWpts, ...plWpts, ...kmWpts].join("\n")}
${[...main, ...steepTrks].join("\n")}
</gpx>
`;
}

export function toCsv(a: Analysis): string {
  const rows = [["abschnitt", "km_von", "km_bis", "hoehe_von_m", "hoehe_bis_m", "gefaelle_m_pro_km", "klasse", "talenge"].join(";")];
  for (const s of a.segments) {
    rows.push(
      [s.index + 1, km(s.d0), km(s.d1), s.z0.toFixed(1), s.z1.toFixed(1), s.gradient.toFixed(1), s.cls.label, s.confined ? "ja" : "nein"].join(";"),
    );
  }
  return rows.join("\n") + "\n";
}

export function toGeoJson(a: Analysis, name: string, narrows?: NarrowsResult, whitewater: WhitewaterSpot[] = [], hazards: HazardOut[] = [], places: PlaceOut[] = []): string {
  return JSON.stringify({
    type: "FeatureCollection",
    properties: { name, length_m: a.length, drop_m: a.drop, mean_gradient_m_per_km: a.meanGradient },
    features: [
      ...a.segments.map((s) => ({
        type: "Feature",
        properties: { kind: "segment", index: s.index + 1, gradient: s.gradient, class: s.cls.id, confined: s.confined, km_from: s.d0 / 1000, km_to: s.d1 / 1000 },
        geometry: { type: "LineString", coordinates: s.coords },
      })),
      ...(narrows?.features ?? []).map((f) => ({
        type: "Feature",
        properties: { kind: f.kind, title: f.title, detail: f.detail, km_from: f.d0 / 1000, km_to: f.d1 / 1000 },
        geometry: { type: "LineString", coordinates: a.profile.filter((p) => p.d >= f.d0 && p.d <= f.d1).map((p) => p.p).concat(f.d1 - f.d0 < 30 ? [f.center, f.center] : []) },
      })),
      ...hazards.map((h) => ({
        type: "Feature",
        properties: { kind: "gefahrenstelle", reason: h.kind, km: h.d / 1000, title: h.title, text: h.text },
        geometry: { type: "Point", coordinates: h.center },
      })),
      ...whitewater.map((s) => ({
        type: "Feature",
        properties: {
          kind: "schwall", hazard: !!s.hazard, strong: s.strong, km_from: s.d0 / 1000, km_to: s.d1 / 1000,
          whitewater_m2: Math.round(s.area), density_m2_per_m: +s.peakDensity.toFixed(2), whitewater_share: +s.peakFrac.toFixed(3), notes: s.notes, text: spotText(s),
        },
        geometry: { type: "Point", coordinates: s.center },
      })),
      ...places.map((q) => ({
        type: "Feature",
        properties: { kind: q.kind, source: q.source, km: +(q.d / 1000).toFixed(3), title: q.title, text: q.text },
        geometry: { type: "Point", coordinates: q.center },
      })),
    ],
  });
}

/** Datei über das Teilen-Menü des Geräts weitergeben (iPhone/Android: z. B. „Gaia GPS“ wählen).
 *  Gibt false zurück, wenn der Browser das Teilen von Dateien nicht kann. */
export async function shareFile(filename: string, content: string, mime: string, title: string): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || typeof File === "undefined") return false;
  const file = new File([content], filename, { type: mime });
  if (nav.canShare && !nav.canShare({ files: [file] })) return false;
  try {
    await nav.share({ files: [file], title });
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  }
  return true;
}

export function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  // Safari und Firefox übernehmen den Dateinamen nur, wenn der Link im Dokument hängt
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
