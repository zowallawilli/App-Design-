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

export function toGpx(a: Analysis, name: string, narrows?: NarrowsResult, whitewater: WhitewaterSpot[] = [], hazards: HazardOut[] = []): string {
  const bkWpts = hazards
    .map((h) => `  <wpt lat="${h.center[1].toFixed(6)}" lon="${h.center[0].toFixed(6)}">\n    <name>${esc(`Gefahrenstelle km ${km(h.d)}`)}</name>\n    <desc>${esc(`${h.title}: ${h.text}. Indikator – vor Ort prüfen.`)}</desc>\n    <sym>Danger Area</sym>\n  </wpt>`)
    .join("\n");
  const nrWpts = (narrows?.features ?? [])
    .map(
      (f) =>
        `  <wpt lat="${f.center[1].toFixed(6)}" lon="${f.center[0].toFixed(6)}">\n` +
        `    <name>${esc(f.title)}</name>\n    <desc>${esc(f.detail)}</desc>\n    <sym>${f.kind === "engstelle" ? "Caution" : "Danger Area"}</sym>\n  </wpt>`,
    )
    .join("\n");
  const wwWpts = whitewater
    .map(
      (s) =>
        `  <wpt lat="${s.center[1].toFixed(6)}" lon="${s.center[0].toFixed(6)}">\n` +
        `    <name>${esc(`Schwall km ${km(s.dPeak)}`)}</name>\n    <desc>${esc(spotText(s))}</desc>\n    <sym>Caution</sym>\n  </wpt>`,
    )
    .join("\n");
  const trkpts = a.profile
    .map((p) => `      <trkpt lat="${p.p[1].toFixed(6)}" lon="${p.p[0].toFixed(6)}"><ele>${p.z.toFixed(1)}</ele></trkpt>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Packraft-Planer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
${nrWpts}
${bkWpts}
${wwWpts}
  <trk>
    <name>${esc(name)}</name>
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
