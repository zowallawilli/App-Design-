import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { analyzeRiver, type Analysis } from "./analysis";
import { compositeTileLoader, demStats, ElevationSampler, kartverketBreaker, nearNorway, TERRARIUM_URL, type DemSource } from "./dem";
import { download, toCsv, toGeoJson, toGpx } from "./export";
import { haversine, lineLength, locateOnLine, sliceLine, type LngLat } from "./geo";
import { geocode, loadRiverAt, waterwaysInBbox } from "./osm";
import { waterInBbox } from "./vectorWater";
import { PRESETS } from "./presets";
import { renderProfile } from "./profileChart";
import { traceRiver } from "./route";
import { sentinelPoints, sentinelWater } from "./sentinel";
import { analyzeNarrows, GORGE_FINE, GORGE_GLOBAL, type NarrowKind, type NarrowsResult } from "./narrows";
import { imageryAlong, imageryAt, type ImageryStretch } from "./imagery";
import { flowOn, latestDate, meanFlow, officialGauges, riverCell, seriesFor, summerMean, type DischargeSeries, type FlowState } from "./discharge";
import { hasHistory, matchGauge, nveKey, resetGaugeCache, setNveKey, type GaugeMatch } from "./gauges";
import { rateAnalysis, streamPower, waveVelocity, type RatingMode } from "./power";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const setStatus = (msg: string, error = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
};
const fmtKm = (m: number) => `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;

// ---------- Karte ----------
const BASEMAPS = {
  esri: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Bilder © Esri, Maxar, Earthstar Geographics u. a.",
    maxzoom: 19,
  },
  s2: {
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"],
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (enthält modifizierte Copernicus-Sentinel-Daten 2023)',
    maxzoom: 15,
  },
  topo: {
    tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende, SRTM | Stil © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxzoom: 17,
  },
} as const;
type BaseKey = keyof typeof BASEMAPS;

const empty = { type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection;

const style: StyleSpecification = {
  version: 8,
  sources: {
    ...Object.fromEntries(
      Object.entries(BASEMAPS).map(([k, b]) => [k, { type: "raster", tiles: [...b.tiles], tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom }]),
    ),
    dem: {
      type: "raster-dem",
      tiles: [TERRARIUM_URL],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: "Höhen: AWS Terrain Tiles (SRTM, EU-DEM u. a.)",
    },
    river: { type: "geojson", data: empty },
    narrows: { type: "geojson", data: empty },
    gauge: { type: "geojson", data: empty },
    section: { type: "geojson", data: empty },
    draft: { type: "geojson", data: empty },
    cursor: { type: "geojson", data: empty },
  },
  layers: [
    ...(Object.keys(BASEMAPS) as BaseKey[]).map((k) => ({
      id: `base-${k}`,
      type: "raster" as const,
      source: k,
      layout: { visibility: (k === "esri" ? "visible" : "none") as "visible" | "none" },
    })),
    { id: "river", type: "line", source: "river", paint: { "line-color": "#7fd3ff", "line-width": 3, "line-opacity": 0.85 } },
    { id: "section-casing", type: "line", source: "section", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#102027", "line-width": 9, "line-opacity": 0.7 } },
    { id: "section", type: "line", source: "section", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 6 } },
    {
      id: "section-confined", type: "line", source: "section", filter: ["==", ["get", "confined"], true],
      paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [1.5, 1.5], "line-offset": 7 },
    },
    {
      id: "narrows-casing", type: "line", source: "narrows", layout: { "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": 6, "line-offset": -9, "line-opacity": 0.9 },
    },
    {
      id: "narrows", type: "line", source: "narrows", layout: { "line-cap": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-offset": -9 },
    },
    { id: "draft-line", type: "line", source: "draft", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#ffd166", "line-width": 3, "line-dasharray": [2, 1] } },
    { id: "draft-pts", type: "circle", source: "draft", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4, "circle-color": "#ffd166", "circle-stroke-color": "#000", "circle-stroke-width": 1 } },
    {
      id: "gauge", type: "circle", source: "gauge",
      paint: {
        "circle-radius": ["match", ["get", "kind"], "gauge", 8, 6],
        "circle-color": ["match", ["get", "kind"], "gauge", "#e63946", "#1f78b4"],
        "circle-stroke-color": "#fff", "circle-stroke-width": 2,
      },
    },
    { id: "cursor", type: "circle", source: "cursor", paint: { "circle-radius": 7, "circle-color": "#ffffff", "circle-stroke-color": "#000000", "circle-stroke-width": 2 } },
  ],
};

const map = new maplibregl.Map({
  container: "map",
  style,
  center: [13.62, 46.31],
  zoom: 10.5,
  maxPitch: 75,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
const src = (id: string) => map.getSource(id) as GeoJSONSource;
// für automatisierte Tests im Entwicklungsmodus
if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = map;

document.querySelectorAll<HTMLButtonElement>("#basemap button").forEach((b) =>
  b.addEventListener("click", () => {
    const key = b.dataset.base as BaseKey;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, "visibility", k === key ? "visible" : "none");
    void updateImageDate();
    document.querySelectorAll("#basemap button").forEach((x) => x.classList.toggle("on", x === b));
  }),
);
$<HTMLInputElement>("terrain").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  map.setTerrain(on ? { source: "dem", exaggeration: 1.4 } : null);
  if (on && map.getPitch() < 30) map.easeTo({ pitch: 55 });
  if (!on) map.easeTo({ pitch: 0 });
});

// Aufnahmedatum/Auflösung des Luftbilds in der Kartenmitte anzeigen
let imgReq = 0;
async function updateImageDate() {
  const el = $("img-date");
  const esriOn = map.getLayoutProperty("base-esri", "visibility") !== "none";
  if (!esriOn || map.getZoom() < 12) return (el.textContent = "");
  const id = ++imgReq;
  const c = map.getCenter();
  try {
    const info = await imageryAt([c.lng, c.lat], Math.round(map.getZoom()) + 1);
    if (id !== imgReq) return;
    el.textContent = info ? `Bild: ${info.date.split("-").reverse().join(".")} · ${info.resolution.toString().replace(".", ",")} m · ${info.provider}` : "";
  } catch {
    if (id === imgReq) el.textContent = "";
  }
}
map.on("moveend", () => void updateImageDate());
map.on("load", () => void updateImageDate());

// ---------- Zustand ----------
type Mode = "idle" | "osm-river" | "osm-in" | "osm-out" | "route-in" | "route-out" | "draw" | "wave";
let mode: Mode = "idle";
let riverLine: LngLat[] | null = null;
let riverName = "";
let putIn: LngLat | null = null;
let drawPts: LngLat[] = [];
interface FlowInfo {
  imagery: (ImageryStretch & { flow: FlowState | null })[];
  series: DischargeSeries | null;
  today: FlowState | null;
  mq: number;
  summer: number;
  /** Eichung an einem gemessenen Pegel (Faktor gemessen ÷ Modell) */
  /** offizieller Pegel an der Strecke (gemessene Werte, Eichfaktor fürs Modell) */
  gauge: GaugeMatch | null;
  gaugeErrors: string[];
  error?: string;
}
let current: { analysis: Analysis; name: string; source: string; dem: string; literature?: string; narrows?: NarrowsResult; flow?: FlowInfo } | null = null;

/** Darstellung der Engstellen-Typen */
export const NARROW_STYLE: Record<NarrowKind, { color: string; letter: string; label: string }> = {
  engstelle: { color: "#ff9f1c", letter: "E", label: "Engstelle (Flussbreite, Sentinel-2)" },
  schlucht: { color: "#8e44ad", letter: "S", label: "Schlucht (Talquerschnitt, Höhenmodell)" },
  klamm: { color: "#111111", letter: "K", label: "Mögliche Klamm (Fluss im Satellitenbild verdeckt, steile Hänge)" },
};
let lastSection: { line: LngLat[]; name: string; source: string; literature?: string } | null = null;
let markers: maplibregl.Marker[] = [];
let chart: { highlight: (d: number | null) => void } | null = null;
/** Jeder neue Vorgang erhöht den Zähler; ältere Ergebnisse werden verworfen. */
let runId = 0;
let busy = false;

/** Wird geworfen, wenn ein Vorgang abgebrochen bzw. durch einen neuen ersetzt wurde. */
class Cancelled extends Error {
  constructor() {
    super("Abgebrochen");
    this.name = "Cancelled";
  }
}
/**
 * Fortschrittsmeldung für Vorgang `id`. Ist inzwischen ein neuer Vorgang gestartet
 * oder wurde abgebrochen, bricht die Meldung den alten Vorgang ab (statt im
 * Hintergrund weiterzurechnen).
 */
const progressFor = (id: number) => (m: string) => {
  if (id !== runId) throw new Cancelled();
  setStatus(m);
};
const isCancel = (e: unknown) => e instanceof Cancelled;

function setBusy(b: boolean) {
  busy = b;
  $("cancel").hidden = !b;
  document.querySelectorAll<HTMLButtonElement>("#load-preset, .modes button, #finish-draw, #undo-draw").forEach((x) => (x.disabled = b));
  document.querySelectorAll<HTMLSelectElement>("#panel details select").forEach((x) => (x.disabled = b));
  document.body.classList.toggle("busy", b);
}

const MODE_HELP: Record<Mode, string> = {
  idle: "Wähle einen Modus oder lade die Referenzstrecke.",
  "osm-river": "Klicke auf einen Fluss in der Karte, um ihn aus OpenStreetMap zu laden.",
  "osm-in": "Klicke auf den Einstieg (wird auf die Flusslinie gesetzt).",
  "osm-out": "Klicke auf den Ausstieg (flussabwärts).",
  "route-in": "Klicke auf den Einstieg am Fluss.",
  "route-out": "Klicke auf den Ausstieg – der Flusslauf dazwischen wird automatisch nachgezogen.",
  draw: "Klicke flussabwärts Punkte entlang des Flusses. Doppelklick oder „Zeichnen beenden“ schließt ab, Esc bricht ab.",
  wave: "Weit ins Luftbild zoomen und nacheinander die Kämme einer Wellenfolge anklicken (mind. 3). Doppelklick oder „Messung beenden“ wertet aus, Esc bricht ab.",
};

function setMode(m: Mode) {
  mode = m;
  $("mode-help").textContent = MODE_HELP[m];
  const group = m.startsWith("osm") ? "osm" : m.startsWith("route") ? "route" : m === "draw" ? "draw" : "";
  document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === group));
  $("finish-draw").hidden = m !== "draw" && m !== "wave";
  $("undo-draw").hidden = m !== "draw" && m !== "wave";
  $("finish-draw").textContent = m === "wave" ? "Messung beenden" : "Zeichnen beenden";
  $("wave-btn").classList.toggle("on", m === "wave");
  // Doppelklick beendet im Zeichenmodus die Linie statt zu zoomen
  if (m === "draw" || m === "wave") map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = m === "idle" ? "" : "crosshair";
}

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

function endpointMarker(p: LngLat, label: string, color: string) {
  const el = document.createElement("div");
  el.style.cssText = `background:${color};color:#fff;font:700 11px system-ui;padding:3px 6px;border-radius:10px;border:2px solid #fff;box-shadow:0 1px 3px #0008`;
  el.textContent = label;
  const m = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -4] }).setLngLat(p).addTo(map);
  markers.push(m);
  return m;
}

function resetAll() {
  runId++;
  setBusy(false);
  lastSection = null;
  riverLine = null;
  putIn = null;
  drawPts = [];
  current = null;
  clearMarkers();
  src("river").setData(empty);
  src("section").setData(empty);
  src("narrows").setData(empty);
  src("gauge").setData(empty);
  src("draft").setData(empty);
  src("cursor").setData(empty);
  $("results").hidden = true;
  $("profile-wrap").hidden = true;
  map.resize();
  setStatus("");
}

function fitLine(line: LngLat[]) {
  const b = new maplibregl.LngLatBounds(line[0], line[0]);
  line.forEach((p) => b.extend(p));
  map.fitBounds(b, { padding: 60, duration: 800 });
}

// ---------- Analyse ----------
const demSource = () => $<HTMLSelectElement>("opt-dem").value as DemSource;

/** Zoomstufe der Höhenabfrage: Norwegen (Kartverket, 1 m) eine Stufe feiner als global. */
function analysisZoom(line: LngLat[]): number {
  const norway = demSource() === "auto" && nearNorway(line[0]);
  return (norway ? 14 : 13) + Number($<HTMLSelectElement>("opt-res").value);
}

/** Flusslauf zwischen zwei Punkten nachziehen (Satellit + OSM + Höhenmodell). */
async function traceSection(from: LngLat, to: LngLat, id: number) {
  const res = Number($<HTMLSelectElement>("opt-res").value);
  const r = await traceRiver(from, to, {
    loader: compositeTileLoader(demSource()),
    water: $<HTMLInputElement>("opt-s2").checked ? sentinelWater : undefined,
    // OSM-Gewässer: zuerst schnelle Vektorkacheln (OpenFreeMap), sonst Overpass
    waterways: $<HTMLInputElement>("opt-osm").checked ? (bbox) => waterInBbox(bbox).catch(() => waterwaysInBbox(bbox)) : undefined,
    maxCells: res < 0 ? 1_500_000 : res > 0 ? 5_000_000 : 3_000_000,
    onProgress: progressFor(id),
  });
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const parts = r.sources.filter((s) => !s.startsWith("Höhenmodell"));
  const source = parts.length
    ? `${r.sources.join(" + ")}${r.shareOsm > 0 ? ` · ${pct(r.shareOsm)} auf OSM` : ""}${r.shareWater > 0 ? ` · ${pct(r.shareWater)} auf Wasser/Kiesbett` : ""}`
    : `${r.sources[0]} – nur Talboden, Kurven evtl. abgeschnitten`;
  // Weder OSM noch ein klares Satellitensignal: Verlauf kann Straßen oder Bahnlinien folgen
  const note =
    r.shareOsm < 0.5 && r.shareWater < 0.5
      ? "Flusslauf unsicher (keine OSM-Gewässer, schwaches Satellitensignal) – bitte im Luftbild prüfen."
      : "";
  return { line: r.line, source, note };
}
function opts() {
  return {
    segmentLength: Number($<HTMLSelectElement>("opt-seg").value),
    hotspotThreshold: Number($<HTMLSelectElement>("opt-hot").value),
    confinementRise: Number($<HTMLSelectElement>("opt-conf").value),
  };
}

/** Führt die Analyse aus. Liefert true bei Erfolg. `note` wird nach Abschluss als Hinweis angezeigt. */
async function runAnalysis(line: LngLat[], name: string, source: string, note = "", literature?: string): Promise<boolean> {
  const id = ++runId;
  lastSection = { line, name, source, literature };
  if (line.length < 2 || lineLength(line) < 100) {
    setStatus("Strecke zu kurz (mindestens 100 m).", true);
    return false;
  }
  if (lineLength(line) > 200_000) {
    setStatus("Strecke über 200 km – bitte kürzeren Abschnitt wählen.", true);
    return false;
  }
  const sampler = new ElevationSampler(compositeTileLoader(demSource()), analysisZoom(line));
  const before = { ...demStats };
  setBusy(true);
  try {
    const a = await analyzeRiver(line, (p, cb) => sampler.elevations(p, cb), opts(), progressFor(id));
    if (id !== runId) return false; // inzwischen neuer Vorgang gestartet
    const kv = demStats.kartverket - before.kartverket, gl = demStats.global - before.global;
    const err = demStats.kartverketErrors - before.kartverketErrors;
    const dem =
      (kv > 0 && gl === 0 ? "Kartverket DTM (1 m)" : kv > 0 ? "Kartverket + global" : "global (SRTM/EU-DEM u. a.)") +
      (err > 0 || (kv === 0 && demSource() === "auto" && nearNorway(line[0]) && kartverketBreaker.lastError)
        ? ` – Kartverket ${kv > 0 ? "teilweise " : ""}nicht erreichbar (${kartverketBreaker.lastError || "Fehler"})`
        : "");
    current = { analysis: a, name, source, dem, literature };
    showResults();
    // Luftbild-Datum und Abfluss parallel laden (blockiert die übrige Analyse nicht)
    void loadFlowInfo(a, id);
    if ($<HTMLInputElement>("opt-narrows").checked) {
      // Querprofile: mit Kartverket fein (3 m), sonst 10 m
      const fine = kv > 0 && gl === 0;
      const th = fine ? GORGE_FINE : GORGE_GLOBAL;
      const qs = fine ? new ElevationSampler(compositeTileLoader(demSource()), 15) : sampler;
      const nr = await analyzeNarrows(a.profile, {
        elevations: (p, cb) => qs.elevations(p, cb),
        satellite: $<HTMLInputElement>("opt-s2").checked ? sentinelPoints : undefined,
        reportNarrows: $<HTMLInputElement>("opt-width").checked,
        ...th,
        onProgress: progressFor(id),
      });
      if (id !== runId) return false;
      current.narrows = nr;
      showResults();
    }
    const notes = [note, a.reversed ? "Fließrichtung wurde anhand der Höhen umgedreht." : ""].filter(Boolean);
    setStatus(notes.length ? `Hinweis: ${notes.join(" ")}` : "");
    return true;
  } catch (e) {
    if (id === runId && !isCancel(e)) setStatus(`Analyse fehlgeschlagen: ${(e as Error).message}`, true);
    return false;
  } finally {
    if (id === runId) setBusy(false);
  }
}

function showResults() {
  if (!current) return;
  const { name, source } = current;
  const a = rated() ?? current.analysis;
  const rq = ratingQ();
  const mode = rateMode();
  $("rate-note").textContent =
    mode === "gradient"
      ? "Farben nach Gefälle allein."
      : rq.q === null
        ? `Wucht-Bewertung wartet auf Abflussdaten (${rq.label}) – bis dahin nach Gefälle.`
        : `${mode === "power" ? "Farben nach Wucht" : "Farben nach der schwierigeren Einstufung aus Gefälle und Wucht"} · Abfluss: ${rq.label} · Strömungsleistung Ø ${Math.round(streamPower(rq.q, current.analysis.meanGradient))} W/m.`;

  src("section").setData({
    type: "FeatureCollection",
    features: a.segments.map((s) => ({
      type: "Feature",
      properties: { color: s.cls.color, gradient: s.gradient, label: s.cls.label, confined: s.confined, d0: s.d0, d1: s.d1, z0: s.z0, z1: s.z1 },
      geometry: { type: "LineString", coordinates: s.coords },
    })),
  });

  clearMarkers();
  endpointMarker(a.profile[0].p, "Einstieg", "#2a9d8f");
  endpointMarker(a.profile[a.profile.length - 1].p, "Ausstieg", "#264653");
  const ranked = [...a.hotspots].sort((x, y) => y.maxGradient - x.maxGradient);
  a.hotspots.forEach((h, i) => {
    const el = document.createElement("button");
    el.className = "hs-marker";
    el.style.cssText = "background:#d7301f;color:#fff;font:700 11px system-ui;width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px #0008;padding:0;cursor:pointer";
    el.textContent = `H${i + 1}`;
    el.title = `km ${(h.d0 / 1000).toFixed(1)}–${(h.d1 / 1000).toFixed(1)}: max. ${h.maxGradient.toFixed(0)} m/km`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusHotspot(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(h.center).addTo(map));
  });

  // Steilstufen / mögliche Wasserfälle
  a.steps.forEach((st, i) => {
    const el = document.createElement("button");
    el.className = "st-marker";
    el.style.cssText = "background:#1d3557;color:#fff;font:700 12px system-ui;width:24px;height:24px;border-radius:4px;border:2px solid #fff;box-shadow:0 1px 3px #0008;padding:0;cursor:pointer";
    el.textContent = "▼";
    el.title = `Steilstufe: ${st.drop.toFixed(0)} m auf ${Math.round(st.d1 - st.d0)} m (km ${(st.d0 / 1000).toFixed(2)})`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusStep(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(st.center).addTo(map));
  });
  const stList = $("steps-list");
  stList.innerHTML = a.steps.length ? "" : `<li class="hint">Keine Stufen ≥ 8 m auf 100 m im Höhenmodell.</li>`;
  a.steps.forEach((st, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id" style="color:#1d3557">▼</span><span>${st.drop.toFixed(0)} m Höhenverlust auf ${Math.round(st.d1 - st.d0)} m</span>` +
      `<span class="meta">km ${(st.d0 / 1000).toFixed(2)}–${(st.d1 / 1000).toFixed(2)} · möglicher Wasserfall, Katarakt oder Wehr – im Luftbild prüfen</span>`;
    b.addEventListener("click", () => focusStep(i));
    li.appendChild(b);
    stList.appendChild(li);
  });

  // Engstellen, Schluchten, Klammen
  const nr = current.narrows;
  src("narrows").setData({
    type: "FeatureCollection",
    features: (nr?.features ?? []).map((f) => ({
      type: "Feature",
      properties: { color: NARROW_STYLE[f.kind].color, kind: f.kind },
      geometry: { type: "LineString", coordinates: a.profile.filter((p) => p.d >= f.d0 - 30 && p.d <= f.d1 + 30).map((p) => p.p) },
    })),
  });
  nr?.features.forEach((f, i) => {
    const st = NARROW_STYLE[f.kind];
    const el = document.createElement("button");
    el.className = "nr-marker";
    el.style.cssText = `background:${st.color};color:#fff;font:700 11px system-ui;width:24px;height:24px;border-radius:5px;border:2px solid #fff;box-shadow:0 1px 3px #0008;padding:0;cursor:pointer;transform:rotate(45deg)`;
    el.innerHTML = `<span style="display:inline-block;transform:rotate(-45deg)">${st.letter}</span>`;
    el.title = `${f.title} – ${f.detail}`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusNarrow(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(f.center).addTo(map));
  });
  const nrList = $("narrows-list");
  nrList.innerHTML = "";
  if (!nr) nrList.innerHTML = `<li class="hint">${$<HTMLInputElement>("opt-narrows").checked ? "Wird berechnet …" : "Ausgeschaltet (Analyse-Parameter)."}</li>`;
  else if (nr.features.length === 0) nrList.innerHTML = `<li class="hint">Keine Engstellen, Schluchten oder verdeckten Abschnitte gefunden.</li>`;
  nr?.features.forEach((f, i) => {
    const st = NARROW_STYLE[f.kind];
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id" style="color:${st.color === "#111111" ? "var(--fg)" : st.color}">${st.letter}</span><span>${f.title}</span><span class="meta">${f.detail}</span>`;
    b.addEventListener("click", () => focusNarrow(i));
    li.appendChild(b);
    nrList.appendChild(li);
  });
  const widths = nr?.sections.map((x) => x.width).filter((x): x is number => x !== null) ?? [];
  $("narrows-meta").textContent = nr
    ? `${nr.satellite ? `Sentinel-2 ${nr.satellite}: Flussbett in ${Math.round((widths.length / nr.sections.length) * 100)} % der Querprofile sichtbar, typisch ~${widths.length ? [...widths].sort((x, y) => x - y)[Math.floor(widths.length / 2)] : "–"} m breit. ` : "Ohne Sentinel-2: nur Talquerschnitte. "}` +
      `Talquerschnitte alle 50 m, Abtastung ${nr.demStep} m${nr.demStep > 5 ? " (globales Höhenmodell – schmale Klammen nur über das Satellitenbild erkennbar)" : " (Kartverket 1 m)"}.`
    : "";

  $("res-title").textContent = name;
  const stats: [string, string][] = [
    ...(current.literature ? ([["Literatur", current.literature]] as [string, string][]) : []),
    ["Flusslinie", source],
    ["Höhenmodell", current.dem],
    ["Länge", fmtKm(a.length)],
    ["Höhe", `${a.zStart.toFixed(0)} → ${a.zEnd.toFixed(0)} m`],
    ["Höhenverlust", `${a.drop.toFixed(0)} m`],
    ["Ø Gefälle", `${a.meanGradient.toFixed(1)} m/km`],
    ["Steilster Abschnitt", `${a.maxSegmentGradient.toFixed(1)} m/km`],
    ["Hotspots", `${a.hotspots.length}`],
    ["Steilstufen", a.steps.length ? `${a.steps.length} (größte ${Math.max(...a.steps.map((x) => x.drop)).toFixed(0)} m)` : "–"],
    ["Talenge", a.confinedLength > 0 ? fmtKm(a.confinedLength) : "–"],
    ...(nr ? ([["Engstellen/Schluchten", nr.features.length ? (["engstelle", "schlucht", "klamm"] as NarrowKind[]).map((k) => `${nr.features.filter((f) => f.kind === k).length} ${NARROW_STYLE[k].letter}`).join(" · ") : "–"]] as [string, string][]) : []),
  ];
  $("stats").innerHTML = stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  $("classes").innerHTML = a.classShare
    .map(({ cls, length }) => {
      const pct = (length / a.length) * 100;
      return `<li style="opacity:${length > 0 ? 1 : 0.45}"><span class="sw" style="background:${cls.color}"></span>` +
        `<span><span class="t">${cls.label}</span><span class="h">${cls.hint}</span></span>` +
        `<span class="v">${length > 0 ? `${fmtKm(length)} · ${pct.toFixed(0)} %` : "–"}</span></li>`;
    })
    .join("") +
    `<li><span class="sw" style="background:repeating-linear-gradient(90deg,#888 0 3px,transparent 3px 6px)"></span>` +
    `<span><span class="t">gestrichelt · Talenge</span><span class="h">beidseitig steile Hänge – Schlucht möglich, Umtragen schwierig</span></span>` +
    `<span class="v">${a.confinedLength > 0 ? fmtKm(a.confinedLength) : "–"}</span></li>`;

  const hsList = $("hotspots");
  hsList.innerHTML = "";
  if (a.hotspots.length === 0) hsList.innerHTML = `<li class="hint">Keine Stellen über ${opts().hotspotThreshold} m/km.</li>`;
  ranked.forEach((h) => {
    const i = a.hotspots.indexOf(h);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id">H${i + 1}</span><span>max. ${h.maxGradient.toFixed(0)} m/km · ${h.drop.toFixed(0)} m auf ${((h.d1 - h.d0)).toFixed(0)} m</span>` +
      `<span class="meta">km ${(h.d0 / 1000).toFixed(1)}–${(h.d1 / 1000).toFixed(1)}${h.confined ? " · Talenge" : ""}</span>`;
    b.addEventListener("click", () => focusHotspot(i));
    li.appendChild(b);
    hsList.appendChild(li);
  });

  renderFlowInfo();
  tourIndex = -1;
  $("tour-label").textContent = `${tourStops().length} markierte Stellen im Luftbild ansehen`;
  $("results").hidden = false;
  $("profile-wrap").hidden = false;
  map.resize();
  requestAnimationFrame(drawChart);
}

function drawChart() {
  if (!current || $("profile-wrap").hidden) return;
  const a = rated() ?? current.analysis;
  chart = renderProfile($("profile"), a, current.narrows, (d) => {
    if (d === null) return src("cursor").setData(empty);
    const p = a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
    src("cursor").setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p.p } });
  });
}

const LEVEL_COLOR: Record<string, string> = { "sehr niedrig": "#b2182b", niedrig: "#ef8a62", mittel: "#4d9221", hoch: "#2166ac", "sehr hoch": "#053061" };

async function loadFlowInfo(a: Analysis, id: number) {
  const pts = a.profile.map((p) => ({ d: p.d, p: p.p }));
  const line = a.profile.map((p) => p.p);
  let info: FlowInfo;
  try {
    const [imagery, cell] = await Promise.all([imageryAlong(pts).catch(() => []), riverCell(line).catch(() => null)]);
    const series = cell ? await seriesFor(cell).catch(() => null) : null;
    const ld = series ? latestDate(series) : null;
    const { match: gauge, errors: gaugeErrors } = await matchGauge(line, series, imagery.map((im) => im.date)).catch((e) => ({ match: null, errors: [String(e)] }));
    info = {
      imagery: imagery.map((im) => ({ ...im, flow: series ? flowOn(series, im.date) : null })),
      series,
      today: series && ld ? flowOn(series, ld) : null,
      mq: series ? meanFlow(series) : NaN,
      summer: series ? summerMean(series) : NaN,
      gauge,
      gaugeErrors,
    };
  } catch (e) {
    info = { imagery: [], series: null, today: null, mq: NaN, summer: NaN, gauge: null, gaugeErrors: [], error: (e as Error).message };
  }
  if (id !== runId && current?.analysis !== a) return;
  if (current?.analysis !== a) return;
  current.flow = info;
  updateQOptions();
  showResults(); // neu einfärben (Wucht-Bewertung braucht den Abfluss)
}

// ---------- Wucht-Bewertung ----------
const rateMode = () => $<HTMLSelectElement>("rate-mode").value as RatingMode;

/** Abfluss für die Wucht-Bewertung je nach Auswahl (m³/s), mit Pegel-Eichung falls vorhanden. */
function ratingQ(): { q: number | null; label: string } {
  const f = current?.flow;
  const src = $<HTMLSelectElement>("q-src").value;
  if (src === "own") {
    const v = Number($<HTMLInputElement>("q-own").value.replace(",", "."));
    return v > 0 ? { q: v, label: `eigener Wert ${v} m³/s` } : { q: null, label: "eigenen Abfluss eingeben" };
  }
  // „heute“ und „Pegel“: gemessener Wert hat Vorrang vor dem Modell – auch wenn das Modell fehlt
  if ((src === "gauge" || src === "today") && f?.gauge?.latest) return { q: f.gauge.latest.q, label: `heute gemessen am Pegel ${f.gauge.gauge.name}: ${fmtQ1(f.gauge.latest.q)} m³/s` };
  if (!f?.series) return { q: null, label: "Abfluss nicht verfügbar" };
  const k = f.gauge?.factor ?? 1;
  const tag = f.gauge?.factor ? ` (geeicht an Pegel ${f.gauge.gauge.name})` : " (Modell)";
  if (src === "mq") return { q: f.mq * k, label: `Mittel MQ ≈ ${fmtQ1(f.mq * k)} m³/s${tag}` };
  if (src === "summer") return { q: f.summer * k, label: `Sommer-Mittel ≈ ${fmtQ1(f.summer * k)} m³/s${tag}` };
  return f.today ? { q: f.today.q * k, label: `heute ≈ ${fmtQ1(f.today.q * k)} m³/s${tag}` } : { q: null, label: "kein Wert für heute" };
}

function fmtQ1(q: number) {
  return (q >= 10 ? q.toFixed(0) : q.toFixed(1)).replace(".", ",");
}

function updateQOptions() {
  const opt = $<HTMLSelectElement>("q-src").querySelector<HTMLOptionElement>('option[value="gauge"]');
  if (opt) opt.hidden = !current?.flow?.gauge?.latest;
}

/** Analyse mit der gewählten Bewertung (Gefälle / Wucht / kombiniert). */
function rated(): Analysis | null {
  if (!current) return null;
  return rateAnalysis(current.analysis, rateMode(), ratingQ().q);
}

$("rate-mode").addEventListener("change", () => current && showResults());

// NVE-Schlüssel (persönlich, kostenlos) – bleibt nur in diesem Browser gespeichert
$<HTMLInputElement>("nve-key").value = nveKey();
$("nve-key").addEventListener("change", () => {
  setNveKey($<HTMLInputElement>("nve-key").value);
  resetGaugeCache();
  if (current) void loadFlowInfo(current.analysis, runId);
});
$("q-src").addEventListener("change", () => {
  $("q-own").hidden = $<HTMLSelectElement>("q-src").value !== "own";
  if (current) showResults();
});
$("q-own").addEventListener("change", () => current && showResults());

function renderFlowInfo() {
  const el = $("flow-info");
  const f = current?.flow;
  if (!current || !f) {
    el.innerHTML = `<p class="hint">Wird geladen …</p>`;
    return;
  }
  const fmtDate = (iso: string) => iso.split("-").reverse().join(".");
  const fmtQ = (q: number) => (q >= 10 ? q.toFixed(0) : q.toFixed(1)).replace(".", ",");
  const lvl = (s: FlowState | null) =>
    s ? `<span class="lvl" style="background:${LEVEL_COLOR[s.label]}">${s.label}</span>` : "–";
  const gm = f.gauge;
  const measured = (d: string, model?: number) => {
    const q = gm?.onDates.get(d);
    if (q !== undefined) return `<b>${fmtQ(q)} m³/s</b>`;
    // Pegel ohne Historie, aber Modell geeicht: Schätzung für den Aufnahmetag
    if (gm?.factor && model !== undefined) return `≈ ${fmtQ(model * gm.factor)} m³/s<br><span class="hint">geschätzt (Modell × ${gm.factor.toFixed(2).replace(".", ",")})</span>`;
    return gm && !hasHistory(gm.gauge.provider) ? "<span class=\"hint\">keine Historie</span>" : "–";
  };
  const rows = f.imagery
    .map(
      (im) =>
        `<tr><td>km ${(im.d0 / 1000).toFixed(1)}–${(im.d1 / 1000).toFixed(1)}</td>` +
        `<td><b>${fmtDate(im.date)}</b><br>${im.provider} · ${im.resolution.toString().replace(".", ",")} m</td>` +
        `<td class="q">${im.flow ? `${fmtQ(im.flow.q)} m³/s<br>${lvl(im.flow)}` : "–"}</td>` +
        (gm ? `<td class="q">${measured(im.date, im.flow?.q)}</td>` : "") +
        `</tr>`,
    )
    .join("");
  const today = f.today || gm?.latest
    ? `<tr><td>heute</td><td><b>${fmtDate(f.today?.date ?? gm!.latest!.time.slice(0, 10))}</b></td><td class="q">${f.today ? `${fmtQ(f.today.q)} m³/s<br>${lvl(f.today)}` : "–"}</td>` +
      (gm ? `<td class="q">${gm.latest ? `<b>${fmtQ(gm.latest.q)} m³/s</b><br><span class="hint">${gm.latest.time.slice(0, 16).replace("T", " ")}${gm.latest.time.endsWith("Z") ? " UTC" : ""}</span>` : "–"}</td>` : "") +
      `</tr>`
    : "";
  const first = f.imagery.find((im) => im.flow);
  // Verhältnis heute ÷ Aufnahmetag: gemessen, wenn möglich – sonst Modell
  const measuredFirst = f.imagery.map((im) => ({ im, q: gm?.onDates.get(im.date) })).find((x) => x.q !== undefined);
  const ratio =
    measuredFirst && gm?.latest
      ? `<p class="hint">Heute fließt laut Pegel etwa <b>${(gm.latest.q / measuredFirst.q!).toFixed(1).replace(".", ",")}×</b> so viel Wasser wie am Aufnahmetag des Luftbilds (${fmtDate(measuredFirst.im.date)}: ${fmtQ(measuredFirst.q!)} m³/s gemessen).</p>`
      : first?.flow && f.today
        ? `<p class="hint">Heute fließt etwa <b>${(f.today.q / first.flow.q).toFixed(1).replace(".", ",")}×</b> so viel Wasser wie am Aufnahmetag des Luftbilds (${fmtDate(first.date)}, Modell). ${gm?.factor ? `Mittlerer Abfluss geeicht: ~${fmtQ(f.mq * gm.factor)} m³/s (Modell allein: ~${fmtQ(f.mq)} m³/s).` : `Mittlerer Abfluss (MQ, Modell): ~${fmtQ(f.mq)} m³/s.`}</p>`
        : "";
  const PROVIDER_LABEL: Record<string, string> = { SMHI: "SMHI (Schweden)", SYKE: "SYKE (Finnland)", NVE: "NVE (Norwegen)", PEGELONLINE: "PEGELONLINE (WSV)", BAFU: "BAFU (Schweiz)", ARSO: "ARSO (Slowenien)", TIROL: "Hydrographischer Dienst Tirol" };
  const cal = gm
    ? `<p class="hint"><b>Offizieller Pegel:</b> <a href="${gm.gauge.url}" target="_blank" rel="noopener">${gm.gauge.name}</a>${gm.gauge.river ? ` (${gm.gauge.river})` : ""} · ${PROVIDER_LABEL[gm.gauge.provider]} · ${gm.gauge.distanceKm < 0.1 ? "an der Strecke" : `${gm.gauge.distanceKm.toFixed(1).replace(".", ",")} km von der Linie`}` +
      `${gm.gauge.note ? ` · ${gm.gauge.note}` : ""}. ` +
      (gm.factor
        ? `Das Modell lag zuletzt um den Faktor ${gm.factor.toFixed(2).replace(".", ",")} daneben${gm.correlation !== null ? ` (Verlauf r = ${gm.correlation.toFixed(2).replace(".", ",")})` : ""} – Wucht-Bewertung und MQ (≈ ${fmtQ(f.mq * gm.factor)} m³/s) sind damit geeicht.`
        : gm.correlation !== null
          ? `Das Modell passt hier schlecht zum Pegel (Verlauf r = ${gm.correlation.toFixed(2).replace(".", ",")}) – die gemessenen Werte sind maßgeblich.`
          : !f.series
            ? "Modellabfluss gerade nicht abrufbar – es zählen die gemessenen Werte."
            : !gm.latest
            ? "Dieser Pegel veröffentlicht keinen Abfluss (nur die Wasserstandsklasse) – die Wucht-Bewertung nutzt deshalb das Modell. Für kleinere oder ausgeleitete Flüsse liegt es oft deutlich zu hoch; bei Bedarf unter „Abfluss für Wucht“ einen eigenen Wert eintragen."
            : "Das Modell lässt sich an diesem Pegel nicht eichen (keine Tageswerte der letzten Wochen) – die gemessenen Werte sind maßgeblich.") +
      `${gm.others.length ? ` Weitere Pegel an der Strecke: ${gm.others.map((o) => `<a href="${o.url}" target="_blank" rel="noopener">${o.name}</a>`).join(", ")}.` : ""}</p>`
    : `<p class="hint">Kein offizieller Pegel mit Abfluss an dieser Strecke gefunden${!nveKey() && current.analysis.profile[0].p[1] > 57.8 && current.analysis.profile[0].p[0] < 31.5 && current.analysis.profile[0].p[0] > 4 ? " – für Norwegen bitte den kostenlosen NVE-Schlüssel unter „Analyse-Parameter“ eintragen" : ""}.</p>`;
  const gauges = (gm ? [] : officialGauges(current.analysis.profile[0].p))
    .map((g) => `<a href="${g.url}" target="_blank" rel="noopener">${g.label}</a>`)
    .join(" · ");
  el.innerHTML =
    (f.imagery.length || today
      ? `<table><tr><th>Strecke</th><th>Luftbild</th><th>Modell*</th>${gm ? "<th>gemessen</th>" : ""}</tr>${rows}${today}</table>`
      : `<p class="hint">Keine Bild- oder Abflussdaten verfügbar${f.error ? ` (${f.error})` : ""}.</p>`) +
    ratio +
    cal +
    `<p class="hint">* Modellabfluss GloFAS (Copernicus, über Open-Meteo), Rasterpunkt ${f.series ? `${f.series.cell.lat.toFixed(3)}, ${f.series.cell.lon.toFixed(3)}` : "–"} (5-km-Raster, auf der Karte als blauer Punkt). ` +
    `Einordnung im Vergleich zu allen Jahren um dieselbe Jahreszeit. Für kleine Flüsse und nahe Mündungen nur grob – mit dem Pegel vor Ort vergleichen${gauges ? `: ${gauges}` : ""}.</p>`;
  src("gauge").setData({
    type: "FeatureCollection",
    features: [
      ...(f.series ? [{ type: "Feature" as const, properties: { kind: "model" }, geometry: { type: "Point" as const, coordinates: [f.series.cell.lon, f.series.cell.lat] } }] : []),
      ...(gm ? [{ type: "Feature" as const, properties: { kind: "gauge", name: gm.gauge.name }, geometry: { type: "Point" as const, coordinates: [gm.gauge.lon, gm.gauge.lat] } }] : []),
    ],
  });
}

/** Zoom für die Detailansicht einzelner Stellen im Luftbild (Blöcke, Stufen erkennbar). */
const DETAIL_ZOOM = 17.5;

/** Alle markierten Stellen (Hotspots, Engstellen, Schluchten) entlang der Strecke zum Durchblättern. */
let tourIndex = -1;
function tourStops() {
  if (!current) return [];
  const a = current.analysis;
  const stops = [
    ...a.hotspots.map((h, i) => ({ d: (h.d0 + h.d1) / 2, label: `H${i + 1} · max. ${h.maxGradient.toFixed(0)} m/km`, go: () => focusHotspot(i) })),
    ...a.steps.map((st, i) => ({ d: (st.d0 + st.d1) / 2, label: `Stufe · ${st.drop.toFixed(0)} m`, go: () => focusStep(i) })),
    ...(current.narrows?.features ?? []).map((f, i) => ({ d: (f.d0 + f.d1) / 2, label: f.title, go: () => focusNarrow(i) })),
  ];
  return stops.sort((x, y) => x.d - y.d);
}
function tour(step: number) {
  const stops = tourStops();
  if (!stops.length) return;
  tourIndex = (tourIndex + step + stops.length) % stops.length;
  const s = stops[tourIndex];
  const base = document.querySelector<HTMLButtonElement>('#basemap button[data-base="esri"]');
  if (map.getLayoutProperty("base-esri", "visibility") === "none") base?.click();
  s.go();
  $("tour-label").textContent = `${tourIndex + 1}/${stops.length} · km ${(s.d / 1000).toFixed(1)} · ${s.label}`;
}
$("tour-prev").addEventListener("click", () => tour(-1));
$("tour-next").addEventListener("click", () => tour(1));

function focusStep(i: number) {
  const st = current?.analysis.steps[i];
  if (!st) return;
  map.flyTo({ center: st.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight((st.d0 + st.d1) / 2);
}

function focusNarrow(i: number) {
  const f = current?.narrows?.features[i];
  if (!f) return;
  map.flyTo({ center: f.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight((f.d0 + f.d1) / 2);
}

function focusHotspot(i: number) {
  if (!current) return;
  const h = current.analysis.hotspots[i];
  map.flyTo({ center: h.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight((h.d0 + h.d1) / 2);
}

// Profil neu zeichnen bei Größenänderung
new ResizeObserver(() => drawChart()).observe($("profile-wrap"));

// Parameter geändert → neu rechnen
["opt-seg", "opt-hot", "opt-dem", "opt-res", "opt-conf", "opt-narrows", "opt-width"].forEach((id) =>
  $(id).addEventListener("change", () => {
    if (lastSection && !busy) void runAnalysis(lastSection.line, lastSection.name, lastSection.source, "", lastSection.literature);
  }),
);

// Popup für Abschnitte
map.on("click", "section", (e) => {
  if (mode !== "idle") return;
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as Record<string, number | string | boolean>;
  new maplibregl.Popup({ closeButton: true })
    .setLngLat(e.lngLat)
    .setHTML(
      `<strong>${Number(p.gradient).toFixed(1)} m/km</strong><br>${p.label}<br>` +
        `km ${(Number(p.d0) / 1000).toFixed(1)}–${(Number(p.d1) / 1000).toFixed(1)} · ${Number(p.z0).toFixed(0)} → ${Number(p.z1).toFixed(0)} m` +
        (p.confined === true || p.confined === "true" ? "<br>Talenge" : ""),
    )
    .addTo(map);
});
map.on("mouseenter", "section", () => mode === "idle" && (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "section", () => mode === "idle" && (map.getCanvas().style.cursor = ""));

// ---------- Modi ----------
document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    resetAll();
    const m = b.dataset.mode;
    setMode(m === "osm" ? "osm-river" : m === "route" ? "route-in" : "draw");
  }),
);
$("reset").addEventListener("click", () => { resetAll(); setMode("idle"); });
$("cancel").addEventListener("click", () => {
  resetAll();
  setMode("idle");
  setStatus("Berechnung abgebrochen. Du kannst sofort eine neue Strecke wählen.");
});

function updateDraft() {
  const features: GeoJSON.Feature[] = drawPts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
  if (drawPts.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: drawPts } });
  src("draft").setData({ type: "FeatureCollection", features });
}

// ---------- Wellen messen ----------

function finishWave() {
  const pts = drawPts.filter((p, i) => i === 0 || p[0] !== drawPts[i - 1][0] || p[1] !== drawPts[i - 1][1]);
  if (pts.length < 3) return setStatus("Mindestens drei Wellenkämme anklicken.", true);
  const gaps = pts.slice(1).map((p, i) => haversine(pts[i], p));
  const lambda = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const spread = Math.max(...gaps) - Math.min(...gaps);
  const v = waveVelocity(lambda);
  const img = $("img-date").textContent?.replace("Bild: ", "") ?? "";
  // Abfluss am Aufnahmetag des Bildes an genau dieser Stelle (Bildstände wechseln entlang der Strecke)
  let imgFlow = "";
  if (current?.flow) {
    const prof = current.analysis.profile;
    const near = prof.reduce((b, q) => (haversine(q.p, pts[0]) < haversine(b.p, pts[0]) ? q : b));
    const st = current.flow.imagery.find((im) => near.d >= im.d0 && near.d <= im.d1);
    if (st?.flow && haversine(near.p, pts[0]) < 500) {
      const measuredQ = current.flow.gauge?.onDates.get(st.date);
      const k = current.flow.gauge?.factor ?? 1;
      imgFlow =
        measuredQ !== undefined
          ? `${measuredQ.toFixed(measuredQ < 10 ? 1 : 0)} (gemessen, Pegel ${current.flow.gauge!.gauge.name})`
          : `${(st.flow.q * k).toFixed(st.flow.q * k < 10 ? 1 : 0)} (${st.flow.label}, ${current.flow.gauge?.factor ? "geeicht" : "Modell"})`;
    }
  }
  const html =
    `<strong>Wellenabstand Ø ${lambda.toFixed(1).replace(".", ",")} m</strong> (${pts.length} Kämme, Streuung ${spread.toFixed(1).replace(".", ",")} m)<br>` +
    `→ Strömung ≈ <b>${v.toFixed(1).replace(".", ",")} m/s</b> (${(v * 3.6).toFixed(0)} km/h)<br>` +
    `Wellenhöhe höchstens ≈ ${(lambda / 7).toFixed(1).replace(".", ",")} m (steilere Wellen brechen)<br>` +
    `<span style="color:var(--muted)">Gilt für stehende Wellen. ${img ? `Bild ${img}` : ""}${imgFlow ? ` · Abfluss am Aufnahmetag ≈ ${imgFlow} m³/s` : ""}</span>`;
  new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(pts[pts.length - 1]).setHTML(html).addTo(map);
  setStatus(`Wellen: Ø ${lambda.toFixed(1)} m Abstand → ca. ${v.toFixed(1)} m/s Strömung.`);
  drawPts = [];
  src("draft").setData(empty);
  setMode("idle");
}
$("wave-btn").addEventListener("click", () => {
  if (busy) return;
  if (mode === "wave") {
    drawPts = [];
    src("draft").setData(empty);
    return setMode("idle");
  }
  drawPts = [];
  src("draft").setData(empty);
  setMode("wave");
  if (map.getZoom() < 17) setStatus("Tipp: für die Wellenmessung weit hineinzoomen (Luftbild 0,25–0,5 m).");
});

async function finishDraw() {
  if (mode === "wave") return finishWave();
  // doppelte Punkte (z. B. durch Doppelklick) entfernen
  const line = drawPts.filter((p, i) => i === 0 || p[0] !== drawPts[i - 1][0] || p[1] !== drawPts[i - 1][1]);
  if (line.length < 2) return setStatus("Mindestens zwei Punkte zeichnen.", true);
  setMode("idle");
  drawPts = [];
  src("draft").setData(empty);
  await runAnalysis(line, "Gezeichnete Strecke", "Eigene Linie + Höhenmodell");
}
$("finish-draw").addEventListener("click", () => void finishDraw());
$("undo-draw").addEventListener("click", () => {
  drawPts.pop();
  updateDraft();
});
map.on("dblclick", (e) => {
  if (mode !== "draw" && mode !== "wave") return;
  e.preventDefault();
  void finishDraw();
});
document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, select, textarea")) return;
  if (e.key === "Escape" && mode === "wave") {
    drawPts = [];
    src("draft").setData(empty);
    setMode("idle");
  } else if (e.key === "Escape" && mode !== "idle" && !busy) {
    resetAll();
    setMode("idle");
  } else if (e.key === "Backspace" && (mode === "draw" || mode === "wave")) {
    drawPts.pop();
    updateDraft();
  }
});

async function loadOsmRiver(p: LngLat) {
  setStatus("Fluss aus OpenStreetMap laden …");
  const r = await loadRiverAt(p);
  riverLine = r.coords;
  riverName = r.name;
  src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r.coords } });
  setStatus(`${r.name}: ${fmtKm(lineLength(r.coords))} geladen (${r.wayIds.length} OSM-Wege).`);
  return r;
}

async function analyzeOsmSection(a: LngLat, b: LngLat, name = riverName): Promise<boolean> {
  if (!riverLine) return false;
  const la = locateOnLine(riverLine, a), lb = locateOnLine(riverLine, b);
  const far = Math.max(la.offset, lb.offset);
  const note = far > 1000 ? `Ein- oder Ausstieg liegt ${(far / 1000).toFixed(1)} km neben der Flusslinie und wurde auf den Fluss gesetzt.` : "";
  let section = sliceLine(riverLine, la.d, lb.d);
  if (la.d > lb.d) section = section.reverse();
  return runAnalysis(section, name, "OpenStreetMap + Höhenmodell", note);
}

map.on("click", async (e) => {
  if (busy) return;
  const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
  switch (mode) {
    case "osm-river": {
      const id = ++runId;
      setBusy(true);
      try {
        await loadOsmRiver(p);
        if (id !== runId) return; // inzwischen zurückgesetzt
        setMode("osm-in");
      } catch (err) {
        if (id !== runId) return;
        setStatus(`${(err as Error).message} Erneut auf den Fluss klicken oder anderen Modus wählen.`, true);
      }
      if (id === runId) setBusy(false);
      break;
    }
    case "osm-in":
      if (!riverLine) return setMode("osm-river");
      putIn = locateOnLine(riverLine, p).point;
      endpointMarker(putIn, "Einstieg", "#2a9d8f");
      setMode("osm-out");
      break;
    case "osm-out": {
      if (!riverLine || !putIn) return setMode("osm-in");
      const from = putIn;
      if (locateOnLine(riverLine, p).d === locateOnLine(riverLine, from).d) return setStatus("Ausstieg muss vom Einstieg verschieden sein.", true);
      setMode("idle");
      if (!(await analyzeOsmSection(from, p)) && !current) {
        // fehlgeschlagen → Ausstieg erneut wählen
        setMode("osm-out");
      }
      break;
    }
    case "route-in":
      putIn = p;
      clearMarkers();
      endpointMarker(p, "Einstieg", "#2a9d8f");
      setMode("route-out");
      break;
    case "route-out": {
      if (!putIn) return setMode("route-in");
      const from = putIn;
      const id = ++runId;
      setMode("idle");
      endpointMarker(p, "Ausstieg", "#264653");
      setBusy(true);
      let sec: { line: LngLat[]; source: string; note: string };
      try {
        sec = await traceSection(from, p, id);
      } catch (err) {
        if (id !== runId || isCancel(err)) return;
        setBusy(false);
        clearMarkers();
        putIn = null;
        setMode("route-in");
        setStatus(`${(err as Error).message} Bitte Einstieg neu wählen.`, true);
        return;
      }
      if (id !== runId) return;
      setBusy(false);
      src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: sec.line } });
      await runAnalysis(sec.line, "Eigene Strecke", sec.source, sec.note);
      break;
    }
    case "draw":
    case "wave":
      drawPts.push(p);
      updateDraft();
      break;
  }
});

// ---------- Referenzstrecken ----------
const presetSel = $<HTMLSelectElement>("preset");
presetSel.innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
const showPresetDesc = () => {
  const pr = PRESETS.find((p) => p.id === presetSel.value);
  $("preset-desc").textContent = pr ? `${pr.description}${pr.literature ? ` Literatur: ${pr.literature}.` : ""}` : "";
};
presetSel.addEventListener("change", showPresetDesc);
showPresetDesc();

$("load-preset").addEventListener("click", async () => {
  const pr = PRESETS.find((p) => p.id === presetSel.value);
  if (!pr) return;
  if (busy) return;
  resetAll();
  setMode("idle");
  const id = runId;
  map.flyTo({ center: pr.seed, zoom: pr.zoom });
  setBusy(true);
  try {
    const sec = await traceSection(pr.putIn, pr.takeOut, id);
    if (id !== runId) return;
    setBusy(false);
    src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: sec.line } });
    fitLine(sec.line);
    await runAnalysis(sec.line, pr.name, sec.source, sec.note, pr.literature);
  } catch (e) {
    if (id !== runId || isCancel(e)) return;
    setBusy(false);
    setStatus(`Laden fehlgeschlagen: ${(e as Error).message}`, true);
  }
});

// ---------- Suche ----------
$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("search").value.trim();
  const list = $("search-results");
  list.innerHTML = "";
  if (!q) return;
  try {
    const res = await geocode(q);
    if (res.length === 0) list.innerHTML = `<li class="hint">Nichts gefunden.</li>`;
    for (const r of res) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.textContent = r.name;
      b.type = "button";
      b.addEventListener("click", () => { map.flyTo({ center: r.p, zoom: 12 }); list.innerHTML = ""; });
      li.appendChild(b);
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="hint">${(err as Error).message}</li>`;
  }
});

// ---------- Export ----------
// Nur ASCII im Dateinamen: Browser verwerfen Namen mit Sonderzeichen (z. B. „č“) teilweise
const fileBase = () =>
  (current?.name ?? "strecke")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "strecke";
$("exp-gpx").addEventListener("click", () => current && download(`${fileBase()}.gpx`, toGpx(current.analysis, current.name, current.narrows), "application/gpx+xml"));
$("exp-csv").addEventListener("click", () => current && download(`${fileBase()}.csv`, toCsv(current.analysis), "text/csv"));
$("exp-geojson").addEventListener("click", () => current && download(`${fileBase()}.geojson`, toGeoJson(current.analysis, current.name, current.narrows), "application/geo+json"));
