import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { analyzeRiver, monotoneDecreasing, type Analysis } from "./analysis";
import { compositeTileLoader, demStats, ElevationSampler, kartverketBreaker, nearNorway, TERRARIUM_URL, type DemSource } from "./dem";
import { download, toCsv, toGeoJson, toGpx } from "./export";
import { haversine, lineLength, locateOnLine, sliceLine, type LngLat } from "./geo";
import { geocode, loadRiverAt, waterwaysInBbox } from "./osm";
import { glacierAreaAround, riversInBbox, waterInBbox } from "./vectorWater";
import { PRESETS } from "./presets";
import { renderProfile } from "./profileChart";
import { traceRiver } from "./route";
import { sentinelPoints, sentinelWater } from "./sentinel";
import { analyzeNarrows, GORGE_FINE, GORGE_GLOBAL, type NarrowKind, type NarrowsResult } from "./narrows";
import { imageryAlong, imageryAt, type ImageryStretch } from "./imagery";
import { officialGauges, riverCell, seriesFor } from "./discharge";
import { assess, captureNote, isGlacial, weatherBefore, type Basin, type Conditions, type Glacier } from "./weather";
import { catchmentFromRivers, type Catchment } from "./catchment";
import { hasHistory, matchGauge, nveKey, resetGaugeCache, setNveKey, TIROL_ARCHIVE_START, type Gauge, type GaugeMatch, type Reading } from "./gauges";
import { rateAnalysis, streamPower, waveVelocity, type RatingMode } from "./power";
import {
  DEFAULT_PARAMS, describeSpots, edgeCandidates, findBreaklines, findSpots, localProfile, type Breakline, fitParams, labelFeature, orthoSourceFor, sampleStrip, whitewaterProfile,
  type OrthoSource, type WhitewaterBin, type WhitewaterLabel, type WhitewaterParams, type WhitewaterSpot,
} from "./whitewater";
import { browserDecoder, exportJson, loadLabels, loadParams, mergeLabels, parseImport, saveLabels, saveParams } from "./whitewaterStore";

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
  ortho: {
    tiles: ["https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg"],
    attribution: 'Orthofoto: <a href="https://basemap.at">basemap.at</a> (CC BY 4.0)',
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
    "ww-labels": { type: "geojson", data: empty },
    narrows: { type: "geojson", data: empty },
    gauge: { type: "geojson", data: empty },
    imgsec: { type: "geojson", data: empty },
    catch: { type: "geojson", data: empty },
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
    {
      id: "catch-line", type: "line", source: "catch", filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#4a90d9", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.85 },
    },
    {
      id: "catch-pts", type: "circle", source: "catch", filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 5, "circle-color": "rgba(255,255,255,0.15)", "circle-stroke-color": "#4a90d9", "circle-stroke-width": 2 },
    },
    { id: "river", type: "line", source: "river", paint: { "line-color": "#7fd3ff", "line-width": 3, "line-opacity": 0.85 } },
    { id: "section-casing", type: "line", source: "section", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#102027", "line-width": 9, "line-opacity": 0.7 } },
    { id: "section", type: "line", source: "section", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 6 } },
    {
      id: "imgsec", type: "line", source: "imgsec", layout: { "line-cap": "butt" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-offset": -15, "line-opacity": 0.95 },
    },
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
    {
      id: "ww-labels", type: "circle", source: "ww-labels",
      paint: { "circle-radius": 7, "circle-color": ["case", ["get", "schwall"], "#00b4d8", "#9e9e9e"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
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
  $("rot").hidden = !on;
  if (on && map.getPitch() < 30) map.easeTo({ pitch: 55 });
  if (!on) { stopOrbit(); map.easeTo({ pitch: 0, bearing: 0 }); }
});

// Karte drehen (v. a. in 3D, um die Topografie von allen Seiten zu sehen)
let orbit: number | null = null;
function stopOrbit() {
  if (orbit !== null) cancelAnimationFrame(orbit);
  orbit = null;
  $("rot-orbit").classList.remove("on");
}
function startOrbit() {
  stopOrbit();
  $("rot-orbit").classList.add("on");
  let last = performance.now();
  const step = (t: number) => {
    map.setBearing((map.getBearing() + ((t - last) / 1000) * 8) % 360); // 8° pro Sekunde
    last = t;
    orbit = requestAnimationFrame(step);
  };
  orbit = requestAnimationFrame(step);
}
const rotateBy = (deg: number) => { stopOrbit(); map.easeTo({ bearing: map.getBearing() + deg, duration: 700 }); };
$("rot-left").addEventListener("click", () => rotateBy(-45));
$("rot-right").addEventListener("click", () => rotateBy(45));
$("rot-north").addEventListener("click", () => { stopOrbit(); map.easeTo({ bearing: 0, duration: 700 }); });
$("rot-orbit").addEventListener("click", () => (orbit === null ? startOrbit() : stopOrbit()));
// eigene Bedienung der Karte beendet den Rundflug
for (const ev of ["mousedown", "touchstart", "wheel"] as const) map.on(ev, stopOrbit);

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
    const cond = info ? current?.flow?.conditions.get(info.date) : undefined;
    el.textContent = info ? `Bild: ${info.date.split("-").reverse().join(".")} · ${info.resolution.toString().replace(".", ",")} m · ${info.provider}${cond ? ` · Wasserstand ${cond.tendency}` : ""}` : "";
  } catch {
    if (id === imgReq) el.textContent = "";
  }
}
map.on("moveend", () => void updateImageDate());
map.on("load", () => void updateImageDate());

// ---------- Zustand ----------
type Mode = "idle" | "osm-river" | "osm-in" | "osm-out" | "route-in" | "route-out" | "draw" | "wave" | "ww-label";
let mode: Mode = "idle";
let riverLine: LngLat[] | null = null;
let riverName = "";
let putIn: LngLat | null = null;
let drawPts: LngLat[] = [];
interface FlowInfo {
  imagery: ImageryStretch[];
  /** offizieller Pegel an der Strecke (gemessene Werte) */
  gauge: GaugeMatch | null;
  /** Hinweise aus Wetter und Jahreszeit je Tag (Aufnahmetage und heute) */
  conditions: Map<string, Conditions>;
  glacier?: Glacier;
  /** Einzugsgebiet oberhalb (Bezugspunkte fürs Wetter) */
  catchment?: Catchment;
  basin?: Basin;
  today: string;
  gaugeErrors: string[];
  error?: string;
}
/** Weißwasser-Suche im offenen Orthofoto */
interface WwState {
  status: "loading" | "done" | "none" | "error" | "off";
  message?: string;
  source?: OrthoSource;
  bins?: WhitewaterBin[];
  /** Stationierung und Lage der Abtastpunkte (für Kurven/Lage der Stellen) */
  track?: { d: Float64Array; p: LngLat[] };
  coverage?: number;
  spots: WhitewaterSpot[];
  /** Gefahrenstellen: Abbruchkante im Bild + Höhenverlust */
  breaks?: Breakline[];
}
let current: { analysis: Analysis; name: string; source: string; dem: string; literature?: string; narrows?: NarrowsResult; flow?: FlowInfo; ww?: WwState } | null = null;
let wwParams: WhitewaterParams = loadParams();
let wwLabels: WhitewaterLabel[] = loadLabels();

/** Darstellung der Engstellen-Typen */
export const NARROW_STYLE: Record<NarrowKind, { color: string; letter: string; label: string }> = {
  engstelle: { color: "#ff9f1c", letter: "E", label: "Engstelle (Flussbreite, Sentinel-2)" },
  schlucht: { color: "#8e44ad", letter: "S", label: "Schlucht (Talquerschnitt, Höhenmodell)" },
  // Klammen werden als Schlucht gezeigt; sehr steile, im Bild verdeckte Abschnitte zusätzlich als Gefahrenstelle
  klamm: { color: "#8e44ad", letter: "S", label: "Schlucht (Fluss im Luftbild verdeckt, steile Hänge)" },
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
  "ww-label": "Bekannte Stellen im Luftbild anklicken und als „Schwall“ oder „kein Schwall“ bewerten. Klick auf eine vorhandene Markierung löscht sie. Esc oder erneut „Stellen markieren“ beendet.",
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
  $("ww-label").classList.toggle("on", m === "ww-label");
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
  src("imgsec").setData(empty);
  src("catch").setData(empty);
  clearImgMarkers();
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
    hotspotThreshold: 30, // Hotspots werden nicht mehr angezeigt (Gefälle über die Abschnittsfarben)
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
    await runWhitewater(a, id);
    if (id !== runId) return false;
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
        ? `Wucht-Bewertung braucht einen Abfluss (${rq.label}) – bis dahin nach Gefälle.`
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
  renderHazards();

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
    ["Gefahrenstellen", `${hazards().length || "–"}`],
    ["Talenge", a.confinedLength > 0 ? fmtKm(a.confinedLength) : "–"],
    ...(nr ? ([["Engstellen/Schluchten", nr.features.length ? `${nr.features.filter((f) => f.kind === "engstelle").length} E · ${nr.features.filter((f) => f.kind !== "engstelle").length} S` : "–"]] as [string, string][]) : []),
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

  renderFlowInfo();
  renderWhitewater(a);
  tourIndex = -1;
  $("tour-label").textContent = `${tourStops().length} markierte Stellen im Luftbild ansehen`;
  $("results").hidden = false;
  $("profile-wrap").hidden = false;
  map.resize();
  requestAnimationFrame(drawChart);
}

// ---------- Gefahrenstellen (rote Welle) ----------
/** Allgemeine Gefahrenstelle: Abbruchkante (Bild + Höhenmodell), Stufe nur im Höhenmodell oder nicht einsehbarer,
 *  steiler Abschnitt (Fluss im Luftbild verdeckt, enge Klamm). */
interface Hazard { d: number; center: LngLat; kind: "kante" | "uneinsehbar" | "stufe"; title: string; text: string }
function hazards(): Hazard[] {
  if (!current) return [];
  const a = current.analysis;
  const out: Hazard[] = [];
  for (const b of current.ww?.breaks ?? [])
    out.push({ d: b.d, center: b.center, kind: "kante", title: "mögliche Abbruchkante (Wasserfall, Stufe, Wehr)", text: `${breakText(b)} · Erkennung ${b.confidence} – unbedingt vorher besichtigen` });
  for (const f of current.narrows?.features ?? []) {
    if (f.kind !== "klamm") continue;
    if (out.some((h) => h.kind === "kante" && h.d >= f.d0 - 50 && h.d <= f.d1 + 50)) continue;
    const g = Math.max(0, ...a.segments.filter((sg) => sg.d1 >= f.d0 && sg.d0 <= f.d1).map((sg) => sg.gradient));
    const step = a.steps.find((st) => st.d1 >= f.d0 - 50 && st.d0 <= f.d1 + 50);
    if (g < 30 && !step) continue;
    out.push({
      d: (f.d0 + f.d1) / 2, center: f.center, kind: "uneinsehbar", title: "nicht einsehbar – enge Klamm mit viel Gefälle",
      text: `km ${(f.d0 / 1000).toFixed(2)}–${(f.d1 / 1000).toFixed(2)}: Fluss im Luftbild verdeckt, beidseitig steil, Gefälle bis ${g.toFixed(0)} m/km${step ? `, Stufe ${step.drop.toFixed(0)} m im Höhenmodell` : ""} – Befahrbarkeit, Ausstiege und Umtragen vor Ort klären`,
    });
  }
  for (const st of a.steps) {
    const d = (st.d0 + st.d1) / 2;
    if (out.some((h) => Math.abs(h.d - d) < 150 || (h.kind === "uneinsehbar" && st.d1 >= h.d - 300 && st.d0 <= h.d + 300))) continue;
    out.push({ d, center: st.center, kind: "stufe", title: "Stufe im Höhenmodell", text: `${st.drop.toFixed(0)} m Höhenverlust auf ${Math.round(st.d1 - st.d0)} m – möglicher Wasserfall, Katarakt oder Wehr; im Luftbild nicht bestätigt, prüfen` });
  }
  return out.sort((x, y) => x.d - y.d);
}

function renderHazards() {
  const list = $("hz-list");
  const hz = hazards();
  list.innerHTML = hz.length ? "" : `<li class="hint">Keine Gefahrenstellen gefunden (Abbruchkanten, Stufen ≥ 8 m auf 100 m, nicht einsehbare steile Klammen).</li>`;
  hz.forEach((h, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id ww-id" style="background:#d62828">${WAVE_SVG("#fff", 14)}</span><span>Gefahrenstelle · ${h.title} · km ${(h.d / 1000).toFixed(2)}</span><span class="meta">${h.text}</span>`;
    b.addEventListener("click", () => focusHazard(i));
    li.appendChild(b);
    list.appendChild(li);
    const el = document.createElement("button");
    el.className = "hz-marker";
    el.style.cssText = "background:#d62828;width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 2px #d62828,0 1px 4px #0009;padding:0;cursor:pointer;display:grid;place-items:center";
    el.innerHTML = WAVE_SVG("#fff", 16);
    el.setAttribute("aria-label", "Gefahrenstelle");
    el.title = `Gefahrenstelle km ${(h.d / 1000).toFixed(2)}: ${h.title} – ${h.text}`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusHazard(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(h.center).addTo(map));
  });
}

function focusHazard(i: number) {
  const h = hazards()[i];
  if (!h) return;
  map.flyTo({ center: h.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight(h.d);
}

// ---------- Schwallstellen: Weißwasser im offenen Orthofoto ----------
const WW_STYLE = (s: WhitewaterSpot) => (s.hazard ? "#d62828" : "#0077b6");
const breakText = (b: Breakline) =>
  `Weißwasser/Gischt setzt schlagartig ein (${Math.round(b.above * 100)} % → ${Math.round(b.below * 100)} % der Flussmitte), Höhenmodell ${b.drop.toFixed(0)} m Höhenverlust`;
/** Wellensymbol (bewusst ohne Nummer/Stufe – keine Schwierigkeitsangabe) */
export const WAVE_SVG = (color = "#fff", size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">` +
  `<path d="M2 9c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/></svg>`;
const kmRange = (s: WhitewaterSpot) => `km ${(s.d0 / 1000).toFixed(2)}–${(s.d1 / 1000).toFixed(2)}`;

const wwCache = new Map<string, WwState>();
async function runWhitewater(a: Analysis, id: number) {
  if (!current || current.analysis !== a) return;
  if (!$<HTMLInputElement>("opt-ww").checked) {
    current.ww = { status: "off", spots: [] };
    return showResults();
  }
  const line = a.profile.map((p) => p.p);
  const source = orthoSourceFor(line);
  if (!source) {
    current.ww = { status: "none", spots: [] };
    return showResults();
  }
  // gleiche Strecke (z. B. nur Parameter geändert) → Profil wiederverwenden, keine neuen Bildabrufe
  const key = `${source.id}|${line.length}|${line[0].join()}|${line[line.length - 1].join()}|${Math.round(a.length)}`;
  const cached = wwCache.get(key);
  if (cached) {
    current.ww = { ...cached, spots: [] };
    current.ww.spots = computeSpots();
    return showResults();
  }
  current.ww = { status: "loading", source, spots: [] };
  showResults();
  const progress = progressFor(id);
  try {
    const strip = await sampleStrip(line, source, browserDecoder, {
      maxTiles: 6000,
      onProgress: (done, total) => progress(`Weißwasser-Suche im Orthofoto: Bildkacheln ${done}/${total} …`),
    });
    if (id !== runId || current?.analysis !== a) return;
    progress("Weißwasser-Suche: Auswertung …");
    await new Promise((r) => setTimeout(r, 0));
    const prof = whitewaterProfile(strip);
    const zm = monotoneDecreasing(a.profile.map((p) => p.floor));
    const zAt = (d: number) => {
      let lo = 0, hi = a.profile.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a.profile[m].d <= d) lo = m; else hi = m; }
      return Math.abs(a.profile[lo].d - d) <= Math.abs(a.profile[hi].d - d) ? zm[lo] : zm[hi];
    };
    // Abbruchkanten: Kandidaten aus dem Bild, Höhenverlust dort mit feinerem Höhenmodell (Zoom 15)
    const cands = edgeCandidates(strip);
    const fine = new ElevationSampler(compositeTileLoader(demSource()), 15);
    const zf = new Map<number, (d: number) => number>();
    for (const c of cands) {
      progress(`Gefahrenstellen: Höhenverlust an möglicher Kante km ${(c.d / 1000).toFixed(2)} …`);
      zf.set(c.i, await localProfile(strip, c, (pts) => fine.elevations(pts)).catch(() => zAt));
    }
    const breaks = findBreaklines(strip, zAt, undefined, cands, (c, d) => (zf.get(c.i) ?? zAt)(d));
    current.ww = { status: "done", source, bins: prof.bins, track: { d: strip.d, p: strip.p }, coverage: prof.coverage, spots: [], breaks };
    wwCache.set(key, current.ww);
    if (wwCache.size > 6) wwCache.delete(wwCache.keys().next().value!);
    current.ww.spots = computeSpots();
    setStatus("");
  } catch (e) {
    if (isCancel(e)) throw e;
    if (current?.analysis === a) current.ww = { status: "error", source, message: (e as Error).message, spots: [] };
  }
  showResults();
}

/** Schwallstellen aus dem gespeicherten Weißwasserprofil (ohne neue Bildabrufe). */
function computeSpots(): WhitewaterSpot[] {
  const ww = current?.ww;
  if (!current || !ww?.bins || !ww.track) return [];
  const a = current.analysis;
  const gradientAt = (d: number) => (a.segments.find((sg) => d >= sg.d0 && d <= sg.d1) ?? a.segments[a.segments.length - 1]).gradient;
  const steps = (ww.breaks ?? []).map((b) => ({ d0: b.d - 20, d1: b.d + 20 }));
  return describeSpots(findSpots(ww.bins, wwParams), ww.track, ww.bins, { gradientAt, steps });
}

/** Aufnahmetag des ausgewerteten Orthofotos an Stationierung d (über Esri-Metadaten desselben Bildflugs),
 *  dazu – ohne Modellzahlen – gemessener Pegelwert bzw. Tendenz aus Wetter/Jahreszeit. */
function wwImageAt(d: number): { date: string; measured?: number; tendency?: Conditions["tendency"] } | null {
  const f = current?.flow, src0 = current?.ww?.source;
  if (!f || !src0) return null;
  const im = f.imagery.find((x) => d >= x.d0 - 1 && d <= x.d1 + 1 && src0.esriMatch.test(`${x.provider} ${x.name}`));
  return im ? { date: im.date, measured: f.gauge?.onDates.get(im.date), tendency: f.conditions.get(im.date)?.tendency } : null;
}

const WATER_HINT: Record<Conditions["tendency"], string> = {
  "eher niedrig": "Bild vermutlich bei eher niedrigem Wasserstand – bei mehr Wasser können weitere Schwälle entstehen, Blöcke liegen frei.",
  "unauffällig": "Wasserstand beim Bildflug laut Wetter und Jahreszeit unauffällig.",
  "eher erhöht": "Bild vermutlich bei eher erhöhtem Wasserstand – Weißwasser eher ausgeprägt.",
  "eher hoch": "Bild vermutlich bei hohem Wasserstand – Weißwasser stark ausgeprägt, bei Normalwasser ruhiger.",
};

function renderWhitewater(a: Analysis) {
  const ww = current?.ww;
  const list = $("ww-list"), meta = $("ww-meta");
  list.innerHTML = "";
  const fmtDate = (iso: string) => iso.split("-").reverse().join(".");
  if (!ww || ww.status === "loading") {
    list.innerHTML = `<li class="hint">${ww ? `Wird im Orthofoto (${ww.source?.name}) gesucht …` : "Wird berechnet …"}</li>`;
    meta.textContent = "";
  } else if (ww.status === "off") {
    list.innerHTML = `<li class="hint">Ausgeschaltet (Analyse-Parameter).</li>`;
    meta.textContent = "";
  } else if (ww.status === "none") {
    list.innerHTML = `<li class="hint">Für diese Strecke gibt es kein offenes, auswertbares Orthofoto – keine Weißwasser-Suche möglich. Bitte im Luftbild selbst prüfen (Stellen-Tour ◀ ▶).</li>`;
    meta.textContent = "Ausgewertet werden nur offen lizenzierte Orthofotos (derzeit Österreich: basemap.at, Slowenien: GURS DOF 2023). Esri, Google, Apple u. a. dürfen nur angezeigt werden.";
  } else if (ww.status === "error") {
    list.innerHTML = `<li class="hint">Weißwasser-Suche fehlgeschlagen: ${ww.message}</li>`;
    meta.textContent = "";
  } else {
    if (!ww.spots.length) list.innerHTML = `<li class="hint">Keine Stellen über der Schwelle (${wwParams.spotDensity.toFixed(1).replace(".", ",")} m² Weißwasser je Flussmeter).</li>`;
    ww.spots.forEach((s, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      const img = wwImageAt((s.d0 + s.d1) / 2);
      b.innerHTML =
        `<span class="id ww-id" style="background:${WW_STYLE(s)}">${WAVE_SVG("#fff", 14)}</span><span>${s.hazard ? "Gefahrenstelle" : "Schwallstelle"} · ${kmRange(s)}</span>` +
        `<span class="meta">Weißwasser ${Math.round(s.area)} m² auf ${Math.round(s.d1 - s.d0)} m · ${Math.round(s.peakFrac * 100)} % der Wasserfläche${s.notes.length ? ` · ${s.notes.join(" · ")}` : ""}` +
        `${img ? ` · Bild ${fmtDate(img.date)}${img.measured !== undefined ? ` (Pegel ${fmtQ1(img.measured)} m³/s)` : img.tendency ? ` (Wasserstand ${img.tendency})` : ""}` : ""}</span>`;
      b.addEventListener("click", () => focusWw(i));
      li.appendChild(b);
      list.appendChild(li);
    });
    const img = wwImageAt(a.length / 2) ?? wwImageAt(0);
    meta.innerHTML =
      `Quelle: ${ww.source!.name} (${ww.source!.license}, ${ww.source!.attribution}), Bilddaten für ${Math.round((ww.coverage ?? 0) * 100)} % der Strecke. ` +
      (img
        ? `Aufnahmetag ${fmtDate(img.date)} (laut Metadaten desselben Bildflugs)${img.measured !== undefined ? `, am Pegel gemessen ${fmtQ1(img.measured)} m³/s` : ""}. ` +
          (img.tendency ? `${WATER_HINT[img.tendency]} ` : "")
        : current?.flow ? "Aufnahmetag unbekannt – Wasserstand beim Bildflug nicht bestimmbar. " : "") +
      `Weißwasser hängt stark vom Abfluss ab; markiert werden helle, körnige Flächen im Wasser (auch Wehre). Ein Indikator, keine Schwierigkeitsbewertung – Stellen vor Ort besichtigen.`;
  }
  // Marker
  ww?.spots.forEach((s, i) => {
    if (s.hazard) return; // dort steht schon die rote Welle (Gefahrenstelle)
    const el = document.createElement("button");
    el.className = "ww-marker";
    el.style.cssText = `background:${WW_STYLE(s)};width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px #0008;padding:0;cursor:pointer;display:grid;place-items:center`;
    el.innerHTML = WAVE_SVG("#fff", 15);
    el.setAttribute("aria-label", s.hazard ? "Gefahrenstelle" : "Schwallstelle");
    el.title = `${s.hazard ? "Gefahrenstelle" : "Schwallstelle"} ${kmRange(s)}: Weißwasser im Luftbild ${Math.round(s.area)} m²${s.notes.length ? `, ${s.notes.join(", ")}` : ""}`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusWw(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(s.center).addTo(map));
  });
  renderLabels();
}

function focusWw(i: number) {
  const s = current?.ww?.spots[i];
  if (!s) return;
  map.flyTo({ center: s.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight(s.dPeak);
}

// --- eigene Markierungen ---
function renderLabels() {
  src("ww-labels").setData({
    type: "FeatureCollection",
    features: wwLabels.map((l, i) => ({ type: "Feature", properties: { i, schwall: l.schwall }, geometry: { type: "Point", coordinates: l.p } })),
  });
  $("ww-learn-info").textContent =
    `${wwLabels.length} eigene Markierung${wwLabels.length === 1 ? "" : "en"} (${wwLabels.filter((l) => l.schwall).length} Schwall, ${wwLabels.filter((l) => !l.schwall).length} kein Schwall) · ` +
    `Schwelle ${wwParams.spotDensity.toFixed(1).replace(".", ",")} m² Weißwasser je Flussmeter${wwParams.spotDensity !== DEFAULT_PARAMS.spotDensity ? ` (gelernt, Standard ${DEFAULT_PARAMS.spotDensity.toString().replace(".", ",")})` : " (Standard)"}. Gespeichert nur in diesem Browser – zur Sicherung exportieren.`;
}

let labelPopup: maplibregl.Popup | null = null;
function addLabelAt(p: LngLat) {
  // vorhandene Markierung in der Nähe → löschen
  const near = wwLabels.findIndex((l) => haversine(l.p, p) < 12 * 2 ** (17 - Math.min(17, map.getZoom())));
  if (near >= 0) {
    wwLabels.splice(near, 1);
    saveLabels(wwLabels);
    return renderLabels();
  }
  labelPopup?.remove();
  const box = document.createElement("div");
  box.className = "ww-popup";
  box.innerHTML = `<b>Diese Stelle ist …</b><div class="row"><button data-v="1">Schwall</button><button data-v="0" class="ghost">kein Schwall</button></div>`;
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      wwLabels.push({ p, schwall: b.dataset.v === "1", date: new Date().toISOString().slice(0, 10) });
      saveLabels(wwLabels);
      labelPopup?.remove();
      renderLabels();
    }),
  );
  labelPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false }).setLngLat(p).setDOMContent(box).addTo(map);
}

$("ww-label").addEventListener("click", () => setMode(mode === "ww-label" ? "idle" : "ww-label"));
$("ww-learn").addEventListener("click", () => {
  const ww = current?.ww;
  if (!current || !ww?.bins) return setStatus("Erst eine Strecke mit Weißwasser-Suche auswerten.", true);
  const line = current.analysis.profile.map((p) => p.p);
  const samples = wwLabels
    .map((l) => ({ l, at: locateOnLine(line, l.p) }))
    .filter((x) => x.at.offset < 60)
    .map((x) => ({ f: labelFeature(ww.bins!, x.at.d), schwall: x.l.schwall }));
  if (!samples.length) return setStatus("Keine eigenen Markierungen an dieser Strecke (max. 60 m neben der Flusslinie).", true);
  const before = wwParams.spotDensity;
  wwParams = fitParams(samples, wwParams);
  saveParams(wwParams);
  ww.spots = computeSpots();
  showResults();
  const hit = samples.filter((x) => (x.f >= wwParams.spotDensity) === x.schwall).length;
  const f1 = (x: number) => x.toFixed(1).replace(".", ",");
  setStatus(`Gelernt aus ${samples.length} Markierung${samples.length === 1 ? "" : "en"}: Schwelle ${f1(before)} → ${f1(wwParams.spotDensity)} m²/m; ${hit} von ${samples.length} Markierungen werden damit richtig erkannt.`);
});
$("ww-reset").addEventListener("click", () => {
  wwParams = { ...DEFAULT_PARAMS };
  saveParams(wwParams);
  if (current?.ww?.bins) current.ww.spots = computeSpots();
  if (current) showResults();
  else renderLabels();
});
$("ww-export").addEventListener("click", () => download(`schwallstellen-markierungen-${new Date().toISOString().slice(0, 10)}.json`, exportJson(wwLabels, wwParams), "application/json"));
$("ww-import").addEventListener("click", () => $<HTMLInputElement>("ww-file").click());
$("ww-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const imp = parseImport(await file.text());
    wwLabels = mergeLabels(wwLabels, imp.labels);
    saveLabels(wwLabels);
    if (imp.params) { wwParams = imp.params; saveParams(wwParams); }
    if (current?.ww?.bins) current.ww.spots = computeSpots();
    if (current) showResults();
    else renderLabels();
    setStatus(`${imp.labels.length} Markierungen importiert${imp.params ? " (inkl. gelernter Schwelle)" : ""}.`);
  } catch (err) {
    setStatus(`Import fehlgeschlagen: ${(err as Error).message}`, true);
  }
});
map.on("load", () => renderLabels());

function drawChart() {
  if (!current || $("profile-wrap").hidden) return;
  const a = rated() ?? current.analysis;
  chart = renderProfile($("profile"), a, current.narrows, (d) => {
    if (d === null) return src("cursor").setData(empty);
    const p = a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
    src("cursor").setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p.p } });
  }, [...(current.ww?.spots ?? []).filter((w) => !w.hazard), ...hazards().map((h) => ({ d0: h.d - 20, d1: h.d + 20, strong: true, hazard: true }))]);
}

const TENDENCY_COLOR: Record<string, string> = { "eher niedrig": "#ef8a62", unauffällig: "#4d9221", "eher erhöht": "#4393c3", "eher hoch": "#2166ac" };

async function loadFlowInfo(a: Analysis, id: number) {
  const pts = a.profile.map((p) => ({ d: p.d, p: p.p }));
  const line = a.profile.map((p) => p.p);
  let info: FlowInfo;
  try {
    // GloFAS-Modell nur noch intern: hilft beim Auswählen des richtigen Pegels (gleicher Fluss,
    // kein Seitenbach) – angezeigt wird es nicht, dafür ist es zu ungenau.
    const [imagery, cell] = await Promise.all([imageryAlong(pts).catch(() => []), riverCell(line).catch(() => null)]);
    const series = cell ? await seriesFor(cell).catch(() => null) : null;
    const dates = [...new Set(imagery.map((im) => im.date))];
    const today = new Date().toISOString().slice(0, 10);
    // Wetter im Einzugsgebiet oberhalb des Einstiegs: Fluss + Zubringer flussaufwärts verfolgen
    const p0 = line[0];
    const catchment = await riversInBbox([p0[0] - 0.9, p0[1] - 0.6, p0[0] + 0.9, p0[1] + 0.6])
      .then(({ rivers, waterNames }) => catchmentFromRivers(line, rivers, waterNames))
      .catch(() => catchmentFromRivers(line, []));
    const [{ match: gauge, errors: gaugeErrors }, windows, iceKm2] = await Promise.all([
      matchGauge(line, series, dates).catch((e) => ({ match: null, errors: [String(e)] })),
      Promise.all([...dates, today].map(async (d) => [d, await weatherBefore(catchment.points, d).catch(() => null)] as const)),
      glacierAreaAround(catchment.points, 8).catch(() => undefined),
    ]);
    // Gletschereinfluss: Stammdaten des Pegels (Tirol: vergletscherter Anteil), sonst Gletscher im Gebiet
    const pct = gauge?.gauge.glacierPct ?? gauge?.others.find((o) => o.glacierPct !== undefined)?.glacierPct;
    const glacier: Glacier = pct !== undefined ? { pct } : { areaKm2: iceKm2 };
    // Fläche: Pegel-Stammdaten, sonst aus der Flusslänge geschätzt; Speicher/Ausleitungen oberhalb
    const regulated = [...catchment.reservoirs, ...(gauge?.gauge.note && /Kraftwerksausleitung|Restwasser/.test(gauge.gauge.note) ? ["Ausleitung"] : [])];
    const basin: Basin = { areaKm2: gauge?.gauge.areaKm2 ?? (catchment.fallback ? undefined : catchment.areaKm2), regulated };
    info = { imagery, gauge, gaugeErrors, conditions: new Map(windows.map(([d, w]) => [d, assess(d, p0, w, glacier, basin)])), today, glacier, catchment, basin };
  } catch (e) {
    info = { imagery: [], gauge: null, gaugeErrors: [], conditions: new Map(), today: new Date().toISOString().slice(0, 10), error: (e as Error).message };
  }
  if (id !== runId && current?.analysis !== a) return;
  if (current?.analysis !== a) return;
  current.flow = info;
  updateQOptions();
  showResults(); // neu einfärben (Wucht-Bewertung braucht den Abfluss)
  void updateImageDate(); // Kartenkopf: Tendenz zum Bilddatum
}

// ---------- Wucht-Bewertung ----------
const rateMode = () => $<HTMLSelectElement>("rate-mode").value as RatingMode;

/** Abfluss für die Wucht-Bewertung: nur gemessene (oder aus Pegeln geschätzte) bzw. selbst eingetragene Werte. */
function ratingQ(): { q: number | null; label: string } {
  const f = current?.flow;
  const src = $<HTMLSelectElement>("q-src").value;
  if (src === "own") {
    const v = Number($<HTMLInputElement>("q-own").value.replace(",", "."));
    return v > 0 ? { q: v, label: `eigener Wert ${v} m³/s` } : { q: null, label: "eigenen Abfluss eingeben" };
  }
  const g = f?.gauge;
  if (src === "image" && g) {
    const im = f!.imagery.find((x) => g.onDates.has(x.date));
    if (im) {
      const q = g.onDates.get(im.date)!;
      return { q, label: `am Aufnahmetag ${im.date.split("-").reverse().join(".")} ${g.gauge.estimate ? "≈" : "gemessen"} ${fmtQ1(q)} m³/s (Pegel ${g.gauge.name})` };
    }
    return { q: null, label: "kein Pegelwert am Aufnahmetag" };
  }
  if (g?.latest)
    return {
      q: g.latest.q,
      label: g.gauge.estimate
        ? `heute ≈ ${fmtQ1(g.latest.q)} m³/s am Pegel ${g.gauge.name} (${g.gauge.estimate.label})`
        : `heute gemessen am Pegel ${g.gauge.name}: ${fmtQ1(g.latest.q)} m³/s`,
    };
  return { q: null, label: f ? "kein Pegel – eigenen Abfluss eintragen" : "Pegel werden gesucht" };
}

function fmtQ1(q: number) {
  return (q >= 10 ? q.toFixed(0) : q.toFixed(1)).replace(".", ",");
}

function updateQOptions() {
  const opt = $<HTMLSelectElement>("q-src").querySelector<HTMLOptionElement>('option[value="image"]');
  const g = current?.flow?.gauge;
  if (opt) opt.hidden = !(g && current!.flow!.imagery.some((im) => g.onDates.has(im.date)));
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

/** Stand eines Pegelwerts (Ortszeit) und ob er veraltet ist (> 26 h) */
function stamp(time: string) {
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return { text: time, stale: false };
  const d = new Date(t);
  const text = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}. ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { text, stale: Date.now() - t > 26 * 3600e3 };
}

/** Aktueller Pegelwert als Text: Abfluss, sonst Wasserstand in cm; veraltete Werte markiert */
function valueText(g: Gauge, r: Reading | null, withTime = false): string {
  const fmt = (q: number) => (q >= 10 ? q.toFixed(0) : q.toFixed(1)).replace(".", ",");
  const st = (time: string) => {
    const s = stamp(time);
    return s.stale ? ` <span class="stale">veraltet, Stand ${s.text}</span>` : withTime ? ` <span class="hint">(${s.text})</span>` : "";
  };
  if (r) return `${g.estimate ? "≈ " : ""}<b>${fmt(r.q)} m³/s</b>${st(r.time)}`;
  if (g.levelCm) return `<b>${fmt(g.levelCm.cm)} cm</b> <span class="hint">Wasserstand, kein Abfluss veröffentlicht</span>${st(g.levelCm.time)}`;
  return `<span class="hint">kein aktueller Wert</span>`;
}

function renderFlowInfo() {
  const el = $("flow-info");
  const f = current?.flow;
  if (!current || !f) {
    el.innerHTML = `<p class="hint">Wird geladen …</p>`;
    return;
  }
  const fmtDate = (iso: string) => iso.split("-").reverse().join(".");
  const fmtQ = (q: number) => (q >= 10 ? q.toFixed(0) : q.toFixed(1)).replace(".", ",");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const gm = f.gauge;
  const est = gm?.gauge.estimate;
  const estHint = est ? `<br><span class="hint">${{ oberhalb: "geschätzt aus Pegeln oberhalb", unterhalb: "geschätzt aus Pegel unterhalb", zwischen: "geschätzt aus Pegeln ober- und unterhalb" }[est.method]}</span>` : "";
  const measured = (d: string) => {
    const q = gm?.onDates.get(d);
    if (q !== undefined) return `${est ? "≈ " : ""}<b>${fmtQ(q)} m³/s</b>${estHint}`;
    if (!gm) return `<span class="hint">kein Pegel</span>`;
    if (gm.gauge.provider === "TIROL") return `<span class="hint">kein Wert (Tiroler Archiv erst ab ${fmtDate(TIROL_ARCHIVE_START)})</span>`;
    return `<span class="hint">${hasHistory(gm.gauge.provider) ? "kein Wert für diesen Tag" : "Anbieter hat keine Werte der Vergangenheit"}</span>`;
  };
  const hints = (d: string) => {
    const c = f.conditions.get(d);
    if (!c) return `<span class="hint">Wetterdaten nicht abrufbar</span>`;
    return (
      `<span class="lvl" style="background:${TENDENCY_COLOR[c.tendency]}">${c.tendency}</span>` +
      `<ul class="wx">${c.hints.map((h) => `<li>${h.effect > 0 ? "▲" : h.effect < 0 ? "▼" : "•"} ${esc(h.text)}</li>`).join("")}` +
      `${c.weather ? "" : "<li>• Wetterdaten gerade nicht abrufbar – Tendenz nur aus der Jahreszeit.</li>"}</ul>`
    );
  };
  const day = (title: string, sub: string, gauge: string, d: string, k?: number) =>
    `<div class="day"${k !== undefined ? ` data-sec="${k}" title="Auf der Karte zeigen"` : ""}><div class="day-head">` +
    `${k !== undefined ? `<span class="sec-chip" style="background:${IMG_COLORS[k % IMG_COLORS.length]}">B${k + 1}</span> ` : ""}<b>${title}</b> <span class="hint">${sub}</span></div>` +
    `<div class="day-row"><span class="k">Pegel</span><span class="q">${gauge}</span></div>` +
    `<div class="day-row"><span class="k">Hinweise</span><span>${hints(d)}</span></div></div>`;
  const rows = f.imagery
    .map((im, k) =>
      day(
        `Luftbild ${fmtDate(im.date)}`,
        `km ${(im.d0 / 1000).toFixed(1)}–${(im.d1 / 1000).toFixed(1)} · ${esc(captureNote(im.provider, im.name))} · ${esc(im.provider)} · ${im.resolution.toString().replace(".", ",")} m`,
        measured(im.date),
        im.date,
        k,
      ),
    )
    .join("");
  const today = day(
    `Heute ${fmtDate(f.today)}`,
    "",
    gm ? `${valueText(gm.gauge, gm.latest, true)}${gm.latest ? estHint : ""}` : `<span class="hint">kein Pegel</span>`,
    f.today,
  );
  // Verhältnis heute ÷ Aufnahmetag nur aus gemessenen Werten
  const measuredFirst = f.imagery.map((im) => ({ im, q: gm?.onDates.get(im.date) })).find((x) => x.q !== undefined);
  const ratio =
    measuredFirst && gm?.latest
      ? `<p class="hint">Heute fließt laut Pegel etwa <b>${(gm.latest.q / measuredFirst.q!).toFixed(1).replace(".", ",")}×</b> so viel Wasser wie am Aufnahmetag des Luftbilds (${fmtDate(measuredFirst.im.date)}: ${fmtQ(measuredFirst.q!)} m³/s ${est ? "geschätzt aus Nachbarpegeln" : "gemessen"}).</p>`
      : "";
  const PROVIDER_LABEL: Record<string, string> = { SMHI: "SMHI (Schweden)", SYKE: "SYKE (Finnland)", NVE: "NVE (Norwegen)", PEGELONLINE: "PEGELONLINE (WSV)", BAFU: "BAFU (Schweiz)", ARSO: "ARSO (Slowenien)", TIROL: "Hydrographischer Dienst Tirol", HUBEAU: "Hub'Eau (Frankreich)", BZ: "Hydrographisches Amt Südtirol" };
  const cal = gm
    ? `<p class="hint"><b>Offizieller Pegel:</b> <a href="${gm.gauge.url}" target="_blank" rel="noopener">${esc(gm.gauge.name)}</a>${gm.gauge.river ? ` (${esc(gm.gauge.river)})` : ""} · ${PROVIDER_LABEL[gm.gauge.provider]} · ${gm.gauge.distanceKm < 0.1 ? "an der Strecke" : `${gm.gauge.distanceKm.toFixed(1).replace(".", ",")} km von der Linie`}` +
      `${gm.gauge.note ? ` · ${esc(gm.gauge.note)}` : ""}.` +
      (gm.unverified ? ` <span class="stale">Flusszuordnung ungeprüft (Vergleichsdaten nicht abrufbar) – Gewässername prüfen.</span>` : "") +
      (!gm.latest ? " Dieser Pegel veröffentlicht keinen Abfluss (nur die Wasserstandsklasse) – für die Wucht-Bewertung bitte einen eigenen Wert eintragen." : "") +
      `${gm.others.length ? ` Weitere Pegel an der Strecke: ${gm.others.map((o, i) => `<a href="${o.url}" target="_blank" rel="noopener">${esc(o.name)}</a>${o.river && o.river !== gm.gauge.river ? ` (${esc(o.river)})` : ""} ${valueText(o, gm.othersLatest[i])}`).join(", ")}.` : ""}</p>`
    : `<p class="hint">Kein offizieller Pegel mit Abfluss an dieser Strecke gefunden${!nveKey() && current.analysis.profile[0].p[1] > 57.8 && current.analysis.profile[0].p[0] < 31.5 && current.analysis.profile[0].p[0] > 4 ? " – für Norwegen bitte den kostenlosen NVE-Schlüssel unter „Analyse-Parameter“ eintragen" : ""}. Der Wasserstand lässt sich dann nur grob aus Wetter und Jahreszeit einschätzen (Spalte „Hinweise“).</p>`;
  const links = (gm ? [] : officialGauges(current.analysis.profile[0].p))
    .map((g) => `<a href="${g.url}" target="_blank" rel="noopener">${g.label}</a>`)
    .join(" · ");
  el.innerHTML =
    (f.imagery.length || gm
      ? `<div class="days">${rows}${today}</div>`
      : `<p class="hint">Keine Bilddaten verfügbar${f.error ? ` (${esc(f.error)})` : ""}.</p>`) +
    ratio +
    cal +
    `<p class="hint">Pegel: nur gemessene Werte offizieller Messstellen („≈“ = aus Nachbarpegeln geschätzt). ` +
    `Hinweise: ${catchText(f)} – Regen, Schnee und Temperatur der Tage davor (Open-Meteo, Wetter-Reanalyse ERA5) und übliche Jahreszeit; eine Tendenz, keine Abflussmessung. ` +
    `${f.glacier && isGlacial(f.glacier) ? `Gletscherfluss: ${f.glacier.pct !== undefined ? `${fmtQ(f.glacier.pct)} % des Einzugsgebiets vergletschert (Pegel-Stammdaten)` : `~${Math.round(f.glacier.areaKm2 ?? 0)} km² Gletscher im Umkreis von 20 km`}.` : ""}` +
    `${links ? ` Pegel vor Ort nachsehen: ${links}.` : ""}</p>`;
  // Abschnittskarten anklicken → Abschnitt auf der Karte zeigen
  el.querySelectorAll<HTMLElement>(".day[data-sec]").forEach((d) => d.addEventListener("click", () => focusImageStretch(Number(d.dataset.sec))));
  drawImageStretches();
  src("catch").setData({
    type: "FeatureCollection",
    features: [
      ...(f.catchment?.lines ?? []).map((l) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: l } })),
      ...(f.catchment?.points ?? []).map((p) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: p } })),
    ],
  });
  src("gauge").setData({
    type: "FeatureCollection",
    features: gm ? [{ type: "Feature" as const, properties: { kind: "gauge", name: gm.gauge.name }, geometry: { type: "Point" as const, coordinates: [gm.gauge.lon, gm.gauge.lat] } }] : [],
  });
}

/** Farben der Bildabschnitte B1, B2 … (Karte und Panel) */
const IMG_COLORS = ["#e76f51", "#2a9d8f", "#e9c46a", "#9b5de5", "#f15bb5", "#00bbf9"];

/** Wo gilt das Wetter? Kurzer Text für die Fußnote. */
function catchText(f: FlowInfo): string {
  const c = f.catchment;
  if (!c || c.fallback) return "Wetter im Umkreis von ~15 km um den Einstieg (Fluss nicht weiter verfolgbar)";
  const parts = [c.river, ...c.tributaries].filter(Boolean).join(", ");
  return `Wetter im Einzugsgebiet oberhalb des Einstiegs (${parts}; ${c.points.length} Bezugspunkte, auf der Karte ○, Gebiet gestrichelt)`;
}

let imgMarkers: maplibregl.Marker[] = [];
function clearImgMarkers() {
  imgMarkers.forEach((m) => m.remove());
  imgMarkers = [];
}
/** Bildabschnitte als farbiges Band neben der Strecke plus Schild „B1 · Datum“ am Beginn */
function drawImageStretches() {
  clearImgMarkers();
  const f = current?.flow;
  if (!current || !f) return src("imgsec").setData(empty);
  const prof = current.analysis.profile;
  const feats = f.imagery.map((im, k) => ({
    type: "Feature" as const,
    properties: { color: IMG_COLORS[k % IMG_COLORS.length] },
    geometry: { type: "LineString" as const, coordinates: prof.filter((p) => p.d >= im.d0 && p.d <= im.d1).map((p) => p.p) },
  }));
  src("imgsec").setData({ type: "FeatureCollection", features: feats.filter((x) => x.geometry.coordinates.length > 1) });
  f.imagery.forEach((im, k) => {
    // Schild in der Mitte des Abschnitts (am Beginn läge es auf dem Einstieg-Schild)
    const start = prof.find((p) => p.d >= (im.d0 + im.d1) / 2)?.p;
    if (!start) return;
    const el = document.createElement("div");
    el.className = "img-marker";
    el.style.background = IMG_COLORS[k % IMG_COLORS.length];
    const c = f.conditions.get(im.date);
    el.textContent = `B${k + 1} · ${im.date.split("-").reverse().join(".")}${c ? ` · ${c.tendency}` : ""}`;
    el.title = "Bildabschnitt – Klick zeigt die Hinweise";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelector(`#flow-info .day[data-sec="${k}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusImageStretch(k);
    });
    imgMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom-left", offset: [4, -4] }).setLngLat(start).addTo(map));
  });
}
function focusImageStretch(k: number) {
  const im = current?.flow?.imagery[k];
  if (!current || !im) return;
  const pts = current.analysis.profile.filter((p) => p.d >= im.d0 && p.d <= im.d1).map((p) => p.p);
  if (pts.length < 2) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: 60, duration: 800, maxZoom: 15 });
  document.querySelectorAll("#flow-info .day").forEach((d) => d.classList.toggle("active", d.getAttribute("data-sec") === String(k)));
  chart?.highlight((im.d0 + im.d1) / 2);
}

/** Zoom für die Detailansicht einzelner Stellen im Luftbild (Blöcke, Stufen erkennbar). */
const DETAIL_ZOOM = 17.5;

/** Alle markierten Stellen (Gefahren-, Schwallstellen, Engstellen, Schluchten) entlang der Strecke zum Durchblättern. */
let tourIndex = -1;
function tourStops() {
  if (!current) return [];
  const stops = [
    ...hazards().map((h, i) => ({ d: h.d, label: `Gefahrenstelle · ${h.title}`, go: () => focusHazard(i) })),
    ...(current.narrows?.features ?? []).map((f, i) => ({ d: (f.d0 + f.d1) / 2, label: f.title, go: () => focusNarrow(i) })),
    ...(current.ww?.spots ?? []).flatMap((w, i) => (w.hazard ? [] : [{ d: w.dPeak, label: "Schwallstelle", go: () => focusWw(i) }])),
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

function focusNarrow(i: number) {
  const f = current?.narrows?.features[i];
  if (!f) return;
  map.flyTo({ center: f.center, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight((f.d0 + f.d1) / 2);
}


// Profil neu zeichnen bei Größenänderung
new ResizeObserver(() => drawChart()).observe($("profile-wrap"));

// Parameter geändert → neu rechnen
["opt-seg", "opt-dem", "opt-res", "opt-conf", "opt-narrows", "opt-width", "opt-ww"].forEach((id) =>
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
    if (st && haversine(near.p, pts[0]) < 500) {
      const measuredQ = current.flow.gauge?.onDates.get(st.date);
      const c = current.flow.conditions.get(st.date);
      imgFlow =
        measuredQ !== undefined
          ? `Abfluss am Aufnahmetag ${current.flow.gauge!.gauge.estimate ? "≈" : ""} ${measuredQ.toFixed(measuredQ < 10 ? 1 : 0)} m³/s (${current.flow.gauge!.gauge.estimate ? "geschätzt aus Nachbarpegeln" : "gemessen"}, Pegel ${current.flow.gauge!.gauge.name})`
          : c
            ? `kein Pegelwert am Aufnahmetag – Wasserstand laut Wetter/Jahreszeit ${c.tendency}`
            : "";
    }
  }
  const html =
    `<strong>Wellenabstand Ø ${lambda.toFixed(1).replace(".", ",")} m</strong> (${pts.length} Kämme, Streuung ${spread.toFixed(1).replace(".", ",")} m)<br>` +
    `→ Strömung ≈ <b>${v.toFixed(1).replace(".", ",")} m/s</b> (${(v * 3.6).toFixed(0)} km/h)<br>` +
    `Wellenhöhe höchstens ≈ ${(lambda / 7).toFixed(1).replace(".", ",")} m (steilere Wellen brechen)<br>` +
    `<span style="color:var(--muted)">Gilt für stehende Wellen. ${img ? `Bild ${img}` : ""}${imgFlow ? ` · ${imgFlow}` : ""}</span>`;
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
    case "ww-label":
      addLabelAt(p);
      break;
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
$("exp-gpx").addEventListener("click", () => current && download(`${fileBase()}.gpx`, toGpx(current.analysis, current.name, current.narrows, current.ww?.spots, hazards()), "application/gpx+xml"));
$("exp-csv").addEventListener("click", () => current && download(`${fileBase()}.csv`, toCsv(current.analysis), "text/csv"));
$("exp-geojson").addEventListener("click", () => current && download(`${fileBase()}.geojson`, toGeoJson(current.analysis, current.name, current.narrows, current.ww?.spots, hazards()), "application/geo+json"));
