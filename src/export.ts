// Export der Analyse als GPX (für GPS/Offline-Karten), CSV und GeoJSON.

import type { Analysis } from "./analysis";
import type { NarrowsResult } from "./narrows";
import type { WhitewaterSpot } from "./whitewater";
import type { LngLat } from "./geo";

/** Gefahrenstelle für den Export (siehe hazards() in main.ts) */
export interface HazardOut { d: number; center: LngLat; kind: string; title: string; text: string }


/** Kurzbeschreibung einer Schwallstelle (Indikator) für Wegpunkte/Export */
export function spotText(s: WhitewaterSpot): string {
  return `km ${km(s.d0)}–${km(s.d1)}: Weißwasser im Luftbild (Indikator) – ${s.area.toFixed(0)} m², ${s.peakDensity.toFixed(1)} m² je Flussmeter, ${Math.round(s.peakFrac * 100)} % der Wasserfläche` +
    (s.notes.length ? `; ${s.notes.join("; ")}` : "") + ". Vor Ort besichtigen.";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const km = (m: number) => (m / 1000).toFixed(2);

/** GPX 1.1 für GPS-Apps (Gaia GPS, OsmAnd, Garmin …): Strecke mit Höhen als Track, Ein-/Ausstieg,
 *  Gefahren-, Schwallstellen und Schluchten als Wegpunkte (mit Höhe, km und Beschreibung). */
export function toGpx(a: Analysis, name: string, narrows?: NarrowsResult, whitewater: WhitewaterSpot[] = [], hazards: HazardOut[] = []): string {
  const zAt = (d: number) => a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).z;
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
  const trkpts = a.profile
    .map((p) => `      <trkpt lat="${p.p[1].toFixed(6)}" lon="${p.p[0].toFixed(6)}"><ele>${p.z.toFixed(1)}</ele></trkpt>`)
    .join("\n");
  // Gefälle je Abschnitt als Text (GPX kennt keine Linienfarben je Abschnitt)
  const steep = a.segments
    .filter((s) => s.gradient >= 15)
    .map((s) => `km ${km(s.d0)}–${km(s.d1)} ${s.gradient.toFixed(0)} m/km (${s.cls.label})`)
    .slice(0, 30);
  const desc =
    `${km(a.length)} km, ${a.drop.toFixed(0)} m Höhenverlust, Ø ${a.meanGradient.toFixed(1)} m/km. ` +
    (steep.length ? `Steile Abschnitte: ${steep.join("; ")}. ` : "") +
    "Gefälle ist ein Indikator, keine Schwierigkeitsbewertung – vor Ort besichtigen. Erstellt mit Packraft-Planer.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Packraft-Planer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><desc>${esc(desc)}</desc></metadata>
${[...ends, ...nrWpts, ...bkWpts, ...wwWpts].join("\n")}
  <trk>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <type>Packrafting</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
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

export function toGeoJson(a: Analysis, name: string, narrows?: NarrowsResult, whitewater: WhitewaterSpot[] = [], hazards: HazardOut[] = []): string {
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
