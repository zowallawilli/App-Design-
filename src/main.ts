import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { analyzeRiver, monotoneDecreasing, type Analysis } from "./analysis";
import { compositeTileLoader, demStats, ElevationSampler, kartverketBreaker, nearNorway, TERRARIUM_URL, type DemSource } from "./dem";
import { download, shareFile, toCsv, toGeoJson, toGpx, toTourGpx, type PlaceOut } from "./export";
import { loadOsmPlaces, OSM_KIND, osmPlaceText, type OsmPlace } from "./osmPlaces";
import { icon, KIND_ICON, OSM_ICON_NAME } from "./icons";
import { haversine, lineLength, locateOnLine, type LngLat } from "./geo";
import { geocode, overpass, waterwaysInBbox } from "./osm";
import { glacierAreaAround, hikeLayersInBbox, riversInBbox, waterInBbox } from "./vectorWater";
import { findHike, type HikeResult } from "./hike";
import { PRESETS } from "./presets";
import { renderProfile } from "./profileChart";
import { loadEsriTile } from "./esriTiles";
import { traceRiver } from "./route";
import { sentinelPoints, sentinelWater } from "./sentinel";
import { analyzeNarrows, GORGE_FINE, GORGE_GLOBAL, type NarrowKind, type NarrowsResult } from "./narrows";
import { imageryAlong, imageryAt, type ImageryStretch } from "./imagery";
import { officialGauges, riverCell, seriesFor } from "./discharge";
import { assess, captureNote, regimeOf, type Basin, type Conditions, type Glacier, type Regime } from "./weather";
import { catchmentFromRivers, type Catchment } from "./catchment";
import { hasHistory, matchGauge, nveKey, resetGaugeCache, setNveKey, TIROL_ARCHIVE_START, type Gauge, type GaugeMatch, type Reading } from "./gauges";
import { rateAnalysis, streamPower, waveVelocityRange, WAVE_DEPTHS, type RatingMode } from "./power";
import {
  DEFAULT_PARAMS, describeSpots, edgeCandidates, findBreaklines, findSpots, localProfile, type Breakline, orthoSourceFor, sampleStrip, whitewaterProfile,
  type OrthoSource, type WhitewaterBin, type WhitewaterLabel, type WhitewaterParams, type WhitewaterSpot,
  applyLabels, binFeat, modelUsable, GRADES, LABEL_KINDS, labelText, isHazardKind, isPlanKind, modelProb, modelThreshold, gradeName, trainGradeModels, type Grade, type LabelKind, type WwModel,
  imageUsable, SENSITIVITY_DEFAULT, SENSITIVITY_MAX, SENSITIVITY_MIN, tunedParams, typicalWidth, widthFactor,
} from "./whitewater";
import { ghToken, setGhToken, uploadLabels } from "./githubUpload";
import { browserDecoder, exportJson, loadHidden, loadLabels, loadModels, loadParams, saveHidden, mergeLabels, parseImport, saveLabels, saveModels, saveParams } from "./whitewaterStore";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const setStatus = (msg: string, error = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
};
const fmtDate = (iso: string) => iso.split("-").reverse().join(".");
const fmtKm = (m: number) => `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;

// ---------- Karte ----------
const BASEMAPS = {
  esri: {
    // eigenes Protokoll: fehlende feine Stufen werden aus der feinsten vorhandenen Kachel vergrößert (esriTiles.ts)
    tiles: ["esri://tile/{z}/{y}/{x}"],
    attribution: "Bilder © Esri, Vantor/Maxar, Earthstar Geographics u. a.",
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
      Object.entries(BASEMAPS).map(([k, b]) => [
        k,
        // Luftbild auf hochauflösenden Bildschirmen eine Stufe feiner laden (128 statt 256 px je Kachel)
        { type: "raster", tiles: [...b.tiles], tileSize: k === "esri" && window.devicePixelRatio >= 1.5 ? 128 : 256, attribution: b.attribution, maxzoom: b.maxzoom },
      ]),
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
    tour: { type: "geojson", data: empty },
    tribs: { type: "geojson", data: empty },
    "ww-labels": { type: "geojson", data: empty },
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
    // Nebenflüsse (anklicken = analysieren)
    { id: "tribs-hit", type: "line", source: "tribs", paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0 } },
    { id: "tribs", type: "line", source: "tribs", layout: { "line-cap": "round" }, paint: { "line-color": "#00b4d8", "line-width": 3.5, "line-dasharray": [1.2, 1.2] } },
    // weitere Abschnitte der Tour (blass) und Verbindungswege
    { id: "tour-river", type: "line", source: "tour", filter: ["==", ["get", "kind"], "fluss"], layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.9 } },
    { id: "tour-hike-casing", type: "line", source: "tour", filter: ["==", ["get", "kind"], "weg"], layout: { "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": ["match", ["get", "sel"], 2, 7, 1, 5, 3], "line-opacity": ["match", ["get", "sel"], 0, 0.4, 0.9] } },
    { id: "tour-hike", type: "line", source: "tour", filter: ["==", ["get", "kind"], "weg"], layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["match", ["get", "sel"], 2, 4, 1, 3, 2], "line-dasharray": [2, 1], "line-opacity": ["match", ["get", "sel"], 0, 0.55, 1] } },
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
    {
      id: "ww-labels", type: "circle", source: "ww-labels", layout: { visibility: "none" }, // nur beim Markieren sichtbar
      paint: { "circle-radius": 7, "circle-color": ["case", ["get", "gefahr"], "#d62828", ["get", "schwall"], "#00b4d8", "#9e9e9e"], "circle-opacity": ["case", ["get", "show"], 1, 0.55], "circle-stroke-color": ["case", ["get", "show"], "#ffd166", "#fff"], "circle-stroke-width": 2 },
    },
    { id: "cursor", type: "circle", source: "cursor", paint: { "circle-radius": 7, "circle-color": "#ffffff", "circle-stroke-color": "#000000", "circle-stroke-width": 2 } },
  ],
};

maplibregl.addProtocol("esri", async (params, abort) => ({ data: await loadEsriTile(params.url, abort.signal) }));

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

document.querySelectorAll<HTMLButtonElement>("#basemap button[data-base]").forEach((b) =>
  b.addEventListener("click", () => {
    const key = b.dataset.base as BaseKey;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, "visibility", k === key ? "visible" : "none");
    void updateImageDate();
    document.querySelectorAll("#basemap button[data-base]").forEach((x) => x.classList.toggle("on", x === b));
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
// Rundflug als fortlaufende Kamerafahrt (easeTo). Früher setBearing je Bild – damit verschwand in 3D das
// Gelände (nur Route sichtbar, Rest weiß/schwarz), weil die Kacheln nie fertig geladen wurden.
let orbiting = false;
const orbitStep = () => { if (orbiting) map.easeTo({ bearing: map.getBearing() + 40, duration: 5000, easing: (t) => t }); };
function stopOrbit() {
  if (!orbiting) return;
  orbiting = false;
  map.off("moveend", orbitStep);
  map.stop();
  $("rot-orbit").classList.remove("on");
}
function startOrbit() {
  stopOrbit();
  orbiting = true;
  $("rot-orbit").classList.add("on");
  map.on("moveend", orbitStep);
  orbitStep(); // 8° pro Sekunde
}
const rotateBy = (deg: number) => { stopOrbit(); map.easeTo({ bearing: map.getBearing() + deg, duration: 700 }); };
$("rot-left").addEventListener("click", () => rotateBy(-45));
$("rot-right").addEventListener("click", () => rotateBy(45));
$("rot-north").addEventListener("click", () => { stopOrbit(); map.easeTo({ bearing: 0, duration: 700 }); });
$("rot-orbit").addEventListener("click", () => (orbiting ? stopOrbit() : startOrbit()));
// eigene Bedienung der Karte beendet den Rundflug
for (const ev of ["mousedown", "touchstart", "wheel"] as const) map.on(ev, stopOrbit);

// Aufnahmedatum/Auflösung des Luftbilds in der Kartenmitte anzeigen
let imgReq = 0;
async function updateImageDate() {
  const el = $("img-date");
  updateExternalLinks();
  const esriOn = map.getLayoutProperty("base-esri", "visibility") !== "none";
  if (!esriOn || map.getZoom() < 12) return (el.textContent = "");
  const id = ++imgReq;
  const c = map.getCenter();
  try {
    const info = await imageryAt([c.lng, c.lat], Math.round(map.getZoom()) + 1);
    if (id !== imgReq) return;
    const cond = info ? current?.flow?.conditions.get(info.date) : undefined;
    // Esri gibt manche Bilder nur bis zu einer gröberen Stufe heraus – dann wird vergrößert (unscharf)
    const capped = info?.maxLevel !== undefined && info.maxLevel < 19 && map.getZoom() + 1 > info.maxLevel + 0.5;
    el.textContent = info ? `Bild: ${fmtDate(info.date)} · ${info.resolution.toString().replace(".", ",")} m · ${info.provider}${cond ? ` · Wasserstand ${cond.tendency}` : ""}${capped ? " · Esri hier nur vergrößert – schärfer evtl. bei Google/Apple ↗" : ""}` : "";
  } catch {
    if (id === imgReq) el.textContent = "";
  }
}
/** Links zur selben Stelle in Google Maps, Google Earth und Apple Karten (oft feiner aufgelöst als Esri;
 *  dürfen nur angezeigt, nicht eingebunden werden – deshalb als Link in einem neuen Fenster). */
function updateExternalLinks() {
  const c = map.getCenter(), z = map.getZoom();
  const lat = c.lat.toFixed(6), lon = c.lng.toFixed(6);
  const zi = Math.min(21, Math.max(3, Math.round(z + 1)));
  // Kamerahöhe für Google Earth so, dass der Ausschnitt etwa der Karte entspricht
  const dist = Math.round(Math.max(150, (40075016 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** (z + 1) * 1.6));
  $<HTMLAnchorElement>("ext-gmaps").href = `https://www.google.com/maps/@?api=1&map_action=map&center=${lat},${lon}&zoom=${zi}&basemap=satellite`;
  $<HTMLAnchorElement>("ext-gearth").href = `https://earth.google.com/web/@${lat},${lon},0a,${dist}d,35y,0h,0t,0r`;
  $<HTMLAnchorElement>("ext-apple").href = `https://maps.apple.com/?ll=${lat},${lon}&z=${zi}&t=k`;
  $("ext-view").hidden = z < 11;
}
map.on("moveend", () => void updateImageDate());
map.on("load", () => void updateImageDate());

// ---------- Zustand ----------
type Mode = "idle" | "edit" | "hike-a" | "hike-b" | "route-in" | "route-out" | "draw" | "wave" | "ww-label";
let mode: Mode = "idle";
let putIn: LngLat | null = null;
let drawPts: LngLat[] = [];
interface FlowInfo {
  imagery: ImageryStretch[];
  /** offizieller Pegel an der Strecke (gemessene Werte) */
  gauge: GaugeMatch | null;
  /** Hinweise aus Wetter und Jahreszeit je Tag (Aufnahmetage und heute) */
  conditions: Map<string, Conditions>;
  glacier?: Glacier;
  /** Gletscher-, Schneeschmelze- oder Regenfluss */
  regime?: Regime;
  /** Einzugsgebiet oberhalb (Bezugspunkte fürs Wetter) */
  catchment?: Catchment;
  basin?: Basin;
  today: string;
  gaugeErrors: string[];
  error?: string;
  /** „Pegel & Quellen“ aufgeklappt (bleibt beim Neuzeichnen offen) */
  catchOpen?: boolean;
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
/** Stellen aus OpenStreetMap entlang der Strecke */
interface OsmState { status: "loading" | "done" | "error" | "off"; places: OsmPlace[]; message?: string }
type Cur = { analysis: Analysis; name: string; source: string; dem: string; literature?: string; narrows?: NarrowsResult; flow?: FlowInfo; ww?: WwState; osm?: OsmState };
let current: Cur | null = null;
let wwParams: WhitewaterParams = loadParams();
/** aus eigenen Markierungen gelerntes Modell (ersetzt die festen Schwellen, sobald genug Markierungen) */
let wwModels: WwModel[] = loadModels();
/** vom Nutzer gelöschte/verschobene erkannte Stellen (nur Anzeige, nicht fürs Lernen) */
let wwHidden: LngLat[] = loadHidden();
/** „Schwälle anzeigen ab …“ (1 = alle, 2 = ab WW II …), nur in diesem Browser */
const MINGRADE_KEY = "packraft.wwMinGrade";
let wwMinGrade = (() => { try { const v = Number(localStorage.getItem(MINGRADE_KEY)); return v >= 1 && v <= 4 ? v : 1; } catch { return 1; } })();
/** Modell für die gewählte Stufe – nur wenn es nachweislich besser ist als die feste Schwelle */
const activeModel = (): WwModel | null => wwModels.find((m) => (m.minGrade ?? 1) === wwMinGrade && modelUsable(m)) ?? null;
/** Empfindlichkeit der Schwallstellen-Suche (Regler 1–9, nur in diesem Browser) */
const SENS_KEY = "packraft.wwSensitivity";
let wwSensitivity = (() => { try { const v = Number(localStorage.getItem(SENS_KEY)); return v >= SENSITIVITY_MIN && v <= SENSITIVITY_MAX ? v : SENSITIVITY_DEFAULT; } catch { return SENSITIVITY_DEFAULT; } })();
/** wirksame Schwellen: gelernte/Standard-Schwelle × Regler × Flussbreite */
const effParams = (): WhitewaterParams => tunedParams(wwParams, wwSensitivity, current?.ww?.bins ? typicalWidth(current.ww.bins) : null);
let wwLabels: WhitewaterLabel[] = loadLabels();

/** Darstellung der Engstellen-Typen */
export const NARROW_STYLE: Record<NarrowKind, { color: string; letter: string; label: string }> = {
  engstelle: { color: "#ff9f1c", letter: "E", label: "Engstelle (Flussbreite, Sentinel-2)" },
  schlucht: { color: "#8e44ad", letter: "S", label: "Schlucht (Talquerschnitt, Höhenmodell)" },
  // Klammen werden als Schlucht gezeigt; sehr steile, im Bild verdeckte Abschnitte zusätzlich als Gefahrenstelle
  klamm: { color: "#8e44ad", letter: "S", label: "Schlucht (Fluss im Luftbild verdeckt, steile Hänge)" },
};
type Section = { line: LngLat[]; name: string; source: string; literature?: string };
let lastSection: Section | null = null;
let markers: maplibregl.Marker[] = [];
/** Schwallstellen-Marker (im Markier-Modus ziehbar) */
let wwMarkers: maplibregl.Marker[] = [];
/** Symbole der eigenen Stellen (bleiben beim Zurücksetzen der Analyse erhalten) */
let ownMarkers: maplibregl.Marker[] = [];
let lastDragEnd = 0;
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
  "route-in": "Klicke auf den Einstieg am Fluss.",
  "route-out": "Klicke auf den Ausstieg – der Flusslauf dazwischen wird automatisch nachgezogen und als weiterer Abschnitt der Tour angelegt (bisherige Flüsse bleiben erhalten).",
  edit: "Strecke bearbeiten: Punkte ziehen = Strecke anpassen (Ein-/Ausstieg, Zwischenpunkte). Klick auf die Strecke fügt einen Zwischenpunkt ein, Klick auf einen Punkt löscht ihn. Esc oder erneut „Strecke bearbeiten“ beendet.",
  "hike-a": "Verbindungsweg: Klicke auf Fluss A (bzw. den Startpunkt).",
  "hike-b": "Verbindungsweg: Klicke auf Fluss B (bzw. den Zielpunkt) – die App sucht den Weg mit der kürzesten Gehzeit.",
  draw: "Klicke flussabwärts Punkte entlang des Flusses. Doppelklick oder „Zeichnen beenden“ schließt ab, Esc bricht ab.",
  "ww-label": "Eigene Stellen: Klick in die Karte setzt eine Stelle (Art, Grad, Notiz). Stelle anklicken = bearbeiten/löschen, ziehen = verschieben. Klick neben das Fenster schließt es. Gespeichert in diesem Browser, im GPX enthalten. Esc oder erneut „Eigene Stellen“ beendet.",
  wave: "Weit ins Luftbild zoomen und nacheinander die Kämme einer Wellenfolge anklicken (mind. 3) – quer zu den Kämmen, also in Fließrichtung. Doppelklick oder „Messung beenden“ wertet aus, Esc bricht ab.",
};

function setMode(m: Mode) {
  mode = m;
  // eigene Markierungen nur im Markier-Modus zeigen – sonst stören sie bei der Planung (bleiben gespeichert, zählen fürs Lernen)
  // Lern-Markierungen (nicht angezeigt) nur beim Bearbeiten mit eingeschalteter Erkennung zeigen
  if (map.getLayer("ww-labels")) map.setLayoutProperty("ww-labels", "visibility", m === "ww-label" && wwAuto() ? "visible" : "none");
  wwMarkers.forEach((mk) => mk.setDraggable(m === "ww-label"));
  ownMarkers.forEach((mk) => mk.setDraggable(m === "ww-label"));
  if (m !== "ww-label") labelPopup?.remove();
  $("mode-help").textContent = MODE_HELP[m];
  const group = m.startsWith("route") ? "route" : m === "draw" ? "draw" : "";
  document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === group));
  $("finish-draw").hidden = m !== "draw" && m !== "wave";
  $("undo-draw").hidden = m !== "draw" && m !== "wave";
  $("finish-draw").textContent = m === "wave" ? "Messung beenden" : "Zeichnen beenden";
  $("wave-btn").classList.toggle("on", m === "wave");
  $("edit-btn").classList.toggle("on", m === "edit");
  $("edit-opts").hidden = m !== "edit";
  $("hike-btn").classList.toggle("on", m.startsWith("hike"));
  $("hike-opts").hidden = !m.startsWith("hike");
  renderEditHandles();
  $("own-btn").classList.toggle("on", m === "ww-label");
  // Doppelklick beendet im Zeichenmodus die Linie statt zu zoomen
  if (m === "draw" || m === "wave") map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = m === "idle" ? "" : "crosshair";
}

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

/** während Ein-/Ausstieg gezogen wird, die Ergebnisanzeige nicht neu aufbauen (sonst ginge der Zug verloren) */
let endpointDragging = false;
function endpointMarker(p: LngLat, label: string, color: string, draggable = false) {
  const el = document.createElement("div");
  el.className = "endpoint";
  el.style.cssText = `background:${color};color:#fff;font:700 11px system-ui;padding:3px 6px;border-radius:10px;border:2px solid #fff;box-shadow:0 1px 3px #0008${draggable ? ";cursor:grab" : ""}`;
  el.textContent = label;
  if (draggable) el.title = `${label} verschieben: ziehen – die Strecke wird neu berechnet`;
  const m = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -4], draggable }).setLngLat(p).addTo(map);
  if (draggable) {
    m.on("dragstart", () => (endpointDragging = true));
    m.on("dragend", () => { endpointDragging = false; void moveAnchor(nearestAnchor(p), [m.getLngLat().lng, m.getLngLat().lat]); });
  }
  markers.push(m);
  return m;
}

// ---------- Strecke bearbeiten: Ankerpunkte und Teilstücke ----------
/** Bearbeitbare Strecke: Ankerpunkte (Ein-/Ausstieg, Zwischenpunkte) und die Teilstücke dazwischen
 *  (am Fluss nachgezogen oder gerade). */
interface RouteEdit { anchors: LngLat[]; parts: LngLat[][]; traced: boolean[] }
let routeEdit: RouteEdit | null = null;
let editMarkers: maplibregl.Marker[] = [];
const joinParts = (parts: LngLat[][]) => parts.flatMap((q, i) => (i ? q.slice(1) : q));
function setRouteEdit(anchors: LngLat[], parts: LngLat[][], traced: boolean[]) {
  routeEdit = { anchors: anchors.map((a) => [a[0], a[1]] as LngLat), parts: parts.map((q) => q.slice()), traced: traced.slice() };
}
function nearestAnchor(p: LngLat): number {
  if (!routeEdit) return -1;
  let best = 0;
  routeEdit.anchors.forEach((a, i) => { if (haversine(a, p) < haversine(routeEdit!.anchors[best], p)) best = i; });
  return best;
}
const editTrace = () => $<HTMLInputElement>("edit-trace").checked;
async function partBetween(a: LngLat, b: LngLat, traced: boolean, id: number): Promise<LngLat[]> {
  if (!traced || haversine(a, b) < 30) return [a, b];
  const sec = await traceSection(a, b, id);
  // nachgezogene Linie an die gewählten Punkte anschließen (Snapping auf den Fluss)
  return [a, ...sec.line, b];
}
/** Neu rechnen nach einer Änderung der Ankerpunkte (Teilstücke `changed` neu bestimmen) */
async function applyEdit(r: RouteEdit, changed: number[]) {
  if (busy) return;
  const before = { anchors: r.anchors.slice(), parts: r.parts.slice(), traced: r.traced.slice() };
  const id = ++runId;
  setBusy(true);
  try {
    for (const k of changed) {
      if (k < 0 || k >= r.parts.length) continue;
      r.traced[k] = editTrace();
      r.parts[k] = await partBetween(r.anchors[k], r.anchors[k + 1], r.traced[k], id);
    }
  } catch (e) {
    Object.assign(r, before);
    if (id !== runId || isCancel(e)) return;
    setBusy(false);
    setStatus(`Neu berechnen fehlgeschlagen: ${(e as Error).message}`, true);
    if (current) showResults();
    return;
  }
  if (id !== runId) return;
  setBusy(false);
  const line = joinParts(r.parts);
  src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
  const ls = lastSection;
  const src0 = (ls?.source ?? "Eigene Linie + Höhenmodell").replace(/ · von Hand angepasst$/, "");
  await runAnalysis(line, current?.name ?? ls?.name ?? "Eigene Strecke", `${src0} · von Hand angepasst`, "", ls?.literature);
}
async function moveAnchor(i: number, p: LngLat) {
  const r = routeEdit;
  if (!r || i < 0) return;
  if (busy) { if (current) showResults(); return; }
  pushUndo();
  r.anchors[i] = p;
  await applyEdit(r, [i - 1, i]);
}
/** Zwischenpunkt auf der Strecke einfügen (ohne Neuberechnung – erst beim Ziehen) */
function insertAnchor(p: LngLat) {
  const r = routeEdit;
  if (!r) return;
  pushUndo();
  let best = { k: -1, off: Infinity, d: 0, point: p };
  r.parts.forEach((q, k) => {
    const at = locateOnLine(q, p);
    if (at.offset < best.off) best = { k, off: at.offset, d: at.d, point: at.point };
  });
  if (best.k < 0) return;
  const q = r.parts[best.k];
  const cum: number[] = [0];
  for (let i = 1; i < q.length; i++) cum.push(cum[i - 1] + haversine(q[i - 1], q[i]));
  const j = cum.findIndex((c) => c > best.d);
  const cut = j < 0 ? q.length - 1 : j;
  r.parts.splice(best.k, 1, [...q.slice(0, cut), best.point], [best.point, ...q.slice(cut)]);
  r.traced.splice(best.k, 1, r.traced[best.k], r.traced[best.k]);
  r.anchors.splice(best.k + 1, 0, best.point);
  renderEditHandles();
}
async function deleteAnchor(i: number) {
  const r = routeEdit;
  if (!r || i <= 0 || i >= r.anchors.length - 1) return;
  pushUndo();
  r.anchors.splice(i, 1);
  r.parts.splice(i - 1, 2, [r.anchors[i - 1], r.anchors[i]]);
  r.traced.splice(i - 1, 2, editTrace());
  await applyEdit(r, [i - 1]);
}
/** Zwischenpunkte als ziehbare Griffe (nur im Modus „Strecke bearbeiten“) */
function renderEditHandles() {
  editMarkers.forEach((m) => m.remove());
  editMarkers = [];
  if (mode !== "edit" || !routeEdit) return;
  routeEdit.anchors.forEach((a, i) => {
    if (i === 0 || i === routeEdit!.anchors.length - 1) return; // Ein-/Ausstieg haben eigene Schilder
    const el = document.createElement("div");
    el.className = "edit-handle";
    el.title = "Zwischenpunkt: ziehen = verschieben, Klick = löschen";
    const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(a).addTo(map);
    let dragged = false;
    mk.on("dragstart", () => (dragged = true));
    mk.on("dragend", () => { lastDragEnd = Date.now(); void moveAnchor(i, [mk.getLngLat().lng, mk.getLngLat().lat]); });
    el.addEventListener("click", (ev) => { ev.stopPropagation(); if (dragged) { dragged = false; return; } void deleteAnchor(i); });
    editMarkers.push(mk);
  });
}

/** Aktuelle Strecke verwerfen. `all` = auch die Tour (alle Abschnitte und Verbindungswege) löschen. */
function resetAll(all = false) {
  runId++;
  active = -1;
  if (all) trip = [];
  setBusy(false);
  lastSection = null;
  routeEdit = null;
  putIn = null;
  drawPts = [];
  current = null;
  clearMarkers();
  src("river").setData(empty);
  src("section").setData(empty);
  src("narrows").setData(empty);
  src("gauge").setData(empty);
  clearImgMarkers();
  src("draft").setData(empty);
  src("cursor").setData(empty);
  selectedD = null;
  $("results").hidden = true;
  $("profile-wrap").hidden = true;
  src("tribs").setData(empty);
  map.resize();
  setStatus("");
  renderTour();
}

function fitLine(line: LngLat[]) {
  const b = new maplibregl.LngLatBounds(line[0], line[0]);
  line.forEach((p) => b.extend(p));
  map.fitBounds(b, { padding: 60, duration: 800 });
}

// ---------- Tour: mehrere Flussabschnitte und Verbindungswege ----------
interface TourItem {
  kind: "fluss" | "weg";
  cur?: Cur;
  edit?: RouteEdit | null;
  last?: Section | null;
  /** Verbindungsweg: Routen (beste + Alternativen), gewählte, Art der Suche */
  hike?: HikeResult[];
  sel?: number;
  how?: string;
}
let trip: TourItem[] = [];
let active = -1;
const TOUR_COLORS = ["#e07a1f", "#9d4edd", "#2a9d8f", "#d62828"];
const fmtH = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")} h`;
const fmtElev = (m: number) => `${Math.round(m)} m`.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
function itemTitle(t: TourItem, i: number): { title: string; meta: string } {
  if (t.kind === "fluss" && t.cur) {
    const a = t.cur.analysis;
    return { title: `${i + 1} · ${t.cur.name}`, meta: `${fmtKm(a.length)} · ${Math.round(a.profile[0].z)} → ${Math.round(a.profile[a.profile.length - 1].z)} m · Ø ${a.meanGradient.toFixed(1).replace(".", ",")} m/km` };
  }
  if (t.kind === "fluss") return { title: `${i + 1} · ${t.last?.name ?? "Fluss"}`, meta: "noch nicht geladen – anklicken zum Analysieren" };
  const r = t.hike?.[t.sel ?? 0];
  return { title: `${i + 1} · ⇄ Verbindungsweg${t.how ? ` (${t.how})` : ""}`, meta: r ? `${fmtKm(r.lengthM)} · ↑ ${Math.round(r.ascent)} m ↓ ${Math.round(r.descent)} m · ~${fmtH(r.hours)} · höchster Punkt ${fmtElev(r.maxElev)}` : "" };
}
/** Karte: inaktive Abschnitte blass in Gefällefarben, Verbindungswege gestrichelt orange */
function renderTourLayer() {
  const features: GeoJSON.Feature[] = [];
  trip.forEach((t, i) => {
    if (t.kind === "fluss" && t.cur && i !== active)
      for (const sg of t.cur.analysis.segments) features.push({ type: "Feature", properties: { i, kind: "fluss", color: sg.cls.color }, geometry: { type: "LineString", coordinates: sg.coords } });
    if (t.kind === "weg")
      (t.hike ?? []).forEach((r, k) => features.push({ type: "Feature", properties: { i, k, kind: "weg", sel: k === (t.sel ?? 0) && i === active ? 2 : k === (t.sel ?? 0) ? 1 : 0, color: TOUR_COLORS[k % TOUR_COLORS.length] }, geometry: { type: "LineString", coordinates: r.line } }));
  });
  src("tour").setData({ type: "FeatureCollection", features });
  hikeMarkers.forEach((m) => m.remove());
  hikeMarkers = [];
  // Nummern-Schild je Abschnitt (Klick = anzeigen)
  trip.forEach((t, i) => {
    const line = t.kind === "fluss" ? t.cur?.analysis.profile.map((q) => q.p) : t.hike?.[t.sel ?? 0]?.line;
    if (!line?.length || i === active) return;
    const el = document.createElement("button");
    el.className = "trip-tag";
    el.textContent = `${i + 1}${t.kind === "fluss" && t.cur ? ` ${t.cur.name}` : " ⇄"}`;
    el.title = "Abschnitt anzeigen";
    el.addEventListener("click", (ev) => { ev.stopPropagation(); activate(i); });
    hikeMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(line[Math.floor(line.length / 2)]).addTo(map));
  });
  trip.forEach((t, i) => {
    const r = t.kind === "weg" ? t.hike?.[t.sel ?? 0] : undefined;
    if (!r) return;
    const el = document.createElement("div");
    el.className = "pass-marker";
    el.innerHTML = `▲ ${fmtElev(r.maxElev)}`;
    el.title = `Höchster Punkt des Verbindungswegs ${i + 1}`;
    hikeMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(r.pass).addTo(map));
  });
}
let hikeMarkers: maplibregl.Marker[] = [];
function renderTour() {
  renderTourLayer();
  const panel = $("tour-panel");
  panel.hidden = trip.length === 0;
  saveTrip();
  const list = $("tour-list");
  list.innerHTML = "";
  let sumKm = 0, sumH = 0;
  trip.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = i === active ? "active" : "";
    const { title, meta } = itemTitle(t, i);
    const b = document.createElement("button");
    b.className = "tour-item ghost";
    b.innerHTML = `<span><b>${title}</b></span><span class="meta">${meta}</span>`;
    b.addEventListener("click", () => activate(i));
    const del = document.createElement("button");
    del.className = "ghost tour-del";
    del.title = "Aus der Tour entfernen";
    del.textContent = "✕";
    del.addEventListener("click", () => removeItem(i));
    li.append(b, del);
    if (t.kind === "weg" && t.hike && i === active) {
      const alts = document.createElement("ol");
      alts.className = "hike-alts";
      t.hike.forEach((r, k) => {
        const ab = document.createElement("button");
        ab.className = `ghost${k === (t.sel ?? 0) ? " sel" : ""}`;
        ab.innerHTML = `<span class="sw" style="background:${TOUR_COLORS[k % TOUR_COLORS.length]}"></span> ${k ? `Alternative ${k}` : "Beste Route"}: ${fmtKm(r.lengthM)}, ↑ ${Math.round(r.ascent)} m ↓ ${Math.round(r.descent)} m, ~${fmtH(r.hours)}, höchster Punkt ${fmtElev(r.maxElev)}, ${Math.round(r.offTrail * 100)} % weglos${r.steep ? " · <b>nur über Steilgelände (> 33°) möglich</b>" : ""}${r.noPaths ? " · keine OSM-Wege im Ausschnitt" : ""}`;
        ab.addEventListener("click", () => { t.sel = k; renderTour(); });
        const al = document.createElement("li");
        al.appendChild(ab);
        alts.appendChild(al);
      });
      li.appendChild(alts);
    }
    list.appendChild(li);
    if (t.kind === "fluss" && t.cur) sumKm += t.cur.analysis.length;
    const r = t.hike?.[t.sel ?? 0];
    if (r) { sumKm += r.lengthM; sumH += r.hours; }
  });
  $("tour-sum").textContent = trip.length ? `Gesamt ${fmtKm(sumKm)}${sumH ? ` · Fußwege ~${fmtH(sumH)} (DIN 33466, ohne Pausen und Gepäckzuschlag)` : ""}` : "";
}
// ---------- Tour im Browser speichern und beim Neustart wiederherstellen ----------
const TRIP_KEY = "packraft.trip";
const r6 = (p: LngLat): LngLat => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
let restoring = false;
function saveTrip() {
  if (restoring) return;
  const items = trip.flatMap((t): unknown[] => {
    if (t.kind === "fluss") {
      const sec = t.last ?? (t.cur ? { line: t.cur.analysis.profile.map((q) => q.p), name: t.cur.name, source: t.cur.source, literature: t.cur.literature } : null);
      if (!sec) return [];
      return [{ kind: "fluss", name: t.cur?.name ?? sec.name, source: sec.source, literature: sec.literature, line: sec.line.map(r6),
        edit: t.edit ? { anchors: t.edit.anchors.map(r6), parts: t.edit.parts.map((q) => q.map(r6)), traced: t.edit.traced } : null }];
    }
    return [{ kind: "weg", how: t.how, sel: t.sel ?? 0, hike: (t.hike ?? []).map((h) => ({ ...h, line: h.line.map(r6), dist: [], elev: h.elev.map((z) => Math.round(z)) })) }];
  });
  try { localStorage.setItem(TRIP_KEY, JSON.stringify({ v: 1, active, items })); } catch { /* voll oder privater Modus */ }
}
/** gespeicherte Tour neu aufbauen: Flüsse neu analysieren (Höhen/Pegel aktuell), Verbindungswege direkt */
async function restoreTrip() {
  let saved: { active: number; items: ({ kind: "fluss"; name: string; source: string; literature?: string; line: LngLat[]; edit: RouteEdit | null } | { kind: "weg"; how?: string; sel: number; hike: HikeResult[] })[] } | null = null;
  try { saved = JSON.parse(localStorage.getItem(TRIP_KEY) ?? "null"); } catch { saved = null; }
  if (!saved?.items?.length) return;
  restoring = true;
  try {
    for (const [k, it] of saved.items.entries()) {
      setStatus(`Tour wird wiederhergestellt (${k + 1}/${saved.items.length}) …`);
      if (it.kind === "weg") {
        const withDist = (h: HikeResult): HikeResult => {
          const dist = [0];
          for (let i = 1; i < h.line.length; i++) dist.push(dist[i - 1] + haversine(h.line[i - 1], h.line[i]));
          return { ...h, dist };
        };
        trip.push({ kind: "weg", how: it.how, sel: it.sel, hike: it.hike.map(withDist) });
        continue;
      }
      resetAll();
      routeEdit = it.edit ? { anchors: it.edit.anchors, parts: it.edit.parts, traced: it.edit.traced } : null;
      src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: it.line } });
      const ok = await runAnalysis(it.line, it.name, it.source, "", it.literature);
      if (!ok) trip.push({ kind: "fluss", last: { line: it.line, name: it.name, source: it.source, literature: it.literature }, edit: routeEdit }); // später erneut versuchen
    }
  } finally {
    restoring = false;
  }
  const a = Math.min(Math.max(0, saved.active), trip.length - 1);
  if (trip[a]?.cur || trip[a]?.kind === "weg") activate(a);
  else renderTour();
  setStatus(`Tour wiederhergestellt: ${trip.length} Abschnitt${trip.length === 1 ? "" : "e"}. „Zurücksetzen“ löscht sie.`);
}

/** Abschnitt der Tour anzeigen (ohne neu zu rechnen) */
function activate(i: number) {
  const t = trip[i];
  if (!t || busy) return;
  if (t.kind === "fluss" && !t.cur && t.last) {
    // beim Wiederherstellen fehlgeschlagen → jetzt neu analysieren (wird hinten angehängt)
    const sec = t.last;
    trip.splice(i, 1);
    resetAll();
    routeEdit = t.edit ?? null;
    void runAnalysis(sec.line, sec.name, sec.source, "", sec.literature);
    return;
  }
  if (mode !== "idle") setMode("idle");
  runId++;
  active = i;
  clearMarkers();
  if (t.kind === "fluss" && t.cur) {
    current = t.cur;
    routeEdit = t.edit ?? null;
    lastSection = t.last ?? null;
    const line = current.analysis.profile.map((q) => q.p);
    src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
    updateQOptions();
    showResults();
    void updateImageDate();
    fitLine(line);
    renderTour();
    if (!current.flow) void loadFlowInfo(current.analysis, runId);
    if (!current.osm) void loadOsm(current.analysis, runId);
    void loadTribs(current.analysis, runId);
    return;
  }
  current = null;
  routeEdit = null;
  lastSection = null;
  for (const id of ["river", "section", "narrows", "gauge", "tribs", "cursor"]) src(id).setData(empty);
  clearImgMarkers();
  $("results").hidden = true;
  $("profile-wrap").hidden = true;
  map.resize();
  const r = t.hike?.[t.sel ?? 0];
  if (r) fitLine(r.line);
  renderTour();
}
function removeItem(i: number) {
  if (busy) return;
  pushUndo();
  const wasActive = i === active;
  trip.splice(i, 1);
  if (wasActive) { resetAll(); return; }
  if (active > i) active--;
  renderTour();
}

// ---------- Rückgängig (↶, Strg/⌘ + Z) ----------
/** Zustand vor einem Bearbeitungsschritt: eigene Stellen, ausgeblendete Erkennungen, Tour (Abschnitte bleiben
 *  als Objekte erhalten → Rückgängig rechnet nichts neu) */
interface UndoSnap { labels: string; hidden: string; trip: TourItem[]; active: number }
const undoStack: UndoSnap[] = [];
const cloneItem = (t: TourItem): TourItem => ({
  ...t,
  edit: t.edit ? { anchors: t.edit.anchors.map((p) => [p[0], p[1]] as LngLat), parts: t.edit.parts.map((q) => q.slice()), traced: t.edit.traced.slice() } : t.edit,
});
function pushUndo() {
  undoStack.push({ labels: JSON.stringify(wwLabels), hidden: JSON.stringify(wwHidden), trip: trip.map(cloneItem), active });
  if (undoStack.length > 40) undoStack.shift();
  $<HTMLButtonElement>("undo").disabled = false;
}
function undo() {
  if (busy || !undoStack.length) return;
  const s = undoStack.pop()!;
  $<HTMLButtonElement>("undo").disabled = undoStack.length === 0;
  labelPopup?.remove();
  wwLabels = JSON.parse(s.labels);
  wwHidden = JSON.parse(s.hidden);
  saveLabels(wwLabels);
  saveHidden(wwHidden);
  const keep = s.trip;
  resetAll(true);
  trip = keep;
  if (mode === "edit" || mode.startsWith("hike") || mode.startsWith("route") || mode === "draw") setMode("idle");
  renderOwnMarkers();
  renderOwnList();
  const a = Math.min(s.active, trip.length - 1);
  if (a >= 0 && (trip[a].cur || trip[a].kind === "weg")) activate(a);
  else renderTour();
  setStatus("Letzter Schritt rückgängig gemacht.");
}

// ---------- Nebenflüsse: blau gestrichelt, anklicken = analysieren ----------
const latTile = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
/** benannte Flüsse, die die Strecke berühren (Nebenflüsse bzw. der Fluss, in den sie mündet) */
async function loadTribs(a: Analysis, id: number) {
  const line = a.profile.map((q) => q.p);
  const lons = line.map((p) => p[0]), lats = line.map((p) => p[1]);
  const pad = 0.06;
  const bb: [number, number, number, number] = [Math.min(...lons) - pad * 1.5, Math.min(...lats) - pad, Math.max(...lons) + pad * 1.5, Math.max(...lats) + pad];
  // möglichst feine Kacheln (Bäche enthalten die Kacheln erst ab Zoom 13), höchstens ~300 kleine Kacheln
  const tiles = (z: number) => { const n = 2 ** z; return (Math.floor(((bb[2] + 180) / 360) * n) - Math.floor(((bb[0] + 180) / 360) * n) + 1) * (latTile(bb[1], z) - latTile(bb[3], z) + 1); };
  const zoom = tiles(13) <= 300 ? 13 : tiles(12) <= 160 ? 12 : 11;
  const raw = await riversInBbox(bb, fetch, zoom, true).then((r) => r.rivers).catch(() => []);
  const rivers = raw;
  const owner = current?.analysis === a ? current : trip.find((t) => t.cur?.analysis === a)?.cur;
  if (!owner) return;
  const step = Math.max(1, Math.floor(line.length / 400));
  const coarse = line.filter((_, i) => i % step === 0);
  const near = (p: LngLat, m: number) => coarse.some((q) => haversine(p, q) < m);
  // Name des analysierten Flusses: die Linie, die am meisten an der Strecke liegt
  const share = new Map<string, number>();
  for (const r of rivers) if (r.name) share.set(r.name, (share.get(r.name) ?? 0) + r.coords.filter((p) => near(p, 120)).length);
  const main = [...share.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  // Eigene Strecke: Flussname aus OpenStreetMap übernehmen (Titel, Tour-Liste, Dateiname beim Export)
  if (main && (share.get(main) ?? 0) >= 3 && /^(Eigene|Gezeichnete) Strecke$/.test(owner.name)) {
    owner.name = main;
    if (current === owner) $("res-title").textContent = main;
    renderTour();
  }
  if (id !== runId || current !== owner) return;
  src("tribs").setData({ type: "FeatureCollection", features: tribFeatures(line, rivers, main, near) });
  // kleine Bäche fehlen in den Vektorkacheln oft → zusätzlich OpenStreetMap direkt (Overpass) entlang der Strecke
  const extra = await waterwaysAlong(line).catch(() => null);
  if (!extra || id !== runId || current !== owner) return;
  const merged = [...rivers.filter((r) => r.name), ...extra]; // unbenannte Linien aus Overpass sind vollständiger als Kachelstücke
  src("tribs").setData({ type: "FeatureCollection", features: tribFeatures(line, merged, main, near) });
}
/** Zuflüsse (benannt oder ohne Namen), die die Strecke berühren (≤ 500 m), als Kartenlinien mit Mündungspunkt */
function tribFeatures(line: LngLat[], rivers: { name: string; coords: LngLat[] }[], main: string | undefined, near: (p: LngLat, m: number) => boolean): GeoJSON.Feature[] {
  const byName = new Map<string, LngLat[][]>();
  const lenKm = (l: LngLat[]) => l.reduce((a, p, i) => (i ? a + haversine(l[i - 1], p) : 0), 0) / 1000;
  const noName: LngLat[][] = [];
  for (const r of rivers) {
    if (r.name && r.name === main) continue;
    // Nebenarme/Ufer-Linien entlang der Strecke sind keine Zuflüsse
    if (r.coords.filter((p) => near(p, 80)).length > r.coords.length * 0.5) continue;
    if (r.name) byName.set(r.name, [...(byName.get(r.name) ?? []), r.coords]);
    else noName.push(r.coords);
  }
  // unbenannte Zuflüsse: Stücke an der Strecke, plus angrenzende Stücke (Kacheln zerschneiden die Linien) – ab ~1,5 km
  const used = new Set<number>();
  let unnamed = 0;
  const touches = (a: LngLat[], b: LngLat[]) => [b[0], b[b.length - 1]].some((e) => a.some((p) => Math.abs(p[0] - e[0]) < 1.2e-3 && Math.abs(p[1] - e[1]) < 6e-4 && haversine(p, e) < 60));
  noName.forEach((l, i) => {
    if (used.has(i) || !l.some((p) => locateOnLine(line, p).offset < TRIB_CONTACT_M)) return;
    const group = [i];
    used.add(i);
    for (let k = 0; k < group.length && group.length < 40; k++)
      noName.forEach((m, j) => { if (!used.has(j) && (touches(noName[group[k]], m) || touches(m, noName[group[k]]))) { used.add(j); group.push(j); } });
    const parts = group.map((j) => noName[j]);
    if (parts.reduce((a, q) => a + lenKm(q), 0) >= 1.5) byName.set(`Zufluss ohne Namen ${++unnamed}`, parts); // kurze Rinnsale weglassen
  });
  const features: GeoJSON.Feature[] = [];
  for (const [name, parts] of byName) {
    // berührt die Strecke? (Mündung bzw. Zusammenfluss – auch über einen kurzen See/Mündungsbereich)
    let contact: LngLat | null = null, best = Infinity;
    for (const l of parts) for (const p of l) { const at = locateOnLine(line, p); if (at.offset < best) { best = at.offset; contact = at.point; } }
    if (!contact || best > TRIB_CONTACT_M) continue;
    for (const l of parts) features.push({ type: "Feature", properties: { name, cx: contact[0], cy: contact[1] }, geometry: { type: "LineString", coordinates: l } });
  }
  return features;
}
const TRIB_CONTACT_M = 500;
/** alle Gewässerlinien (Fluss, Bach, Kanal), die bis 300 m an die Strecke heranreichen – Overpass, vollständige Wege */
async function waterwaysAlong(line: LngLat[]): Promise<{ name: string; coords: LngLat[] }[]> {
  const step = Math.max(1, Math.ceil(line.length / 70));
  const pts = line.filter((_, i) => i % step === 0 || i === line.length - 1).map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join(",");
  const els = (await overpass(`[out:json][timeout:25];way["waterway"~"^(river|stream|canal)$"](around:300,${pts});out tags geom;`)) as unknown as { tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[];
  return els.filter((e) => e.geometry?.length).map((e) => ({ name: e.tags?.name ?? "", coords: e.geometry!.map((g) => [g.lon, g.lat] as LngLat) }));
}
/** Klick auf einen Nebenfluss: Einstieg an der Klickstelle, Ausstieg an der Mündung → neuer Abschnitt der Tour */
async function analyzeTrib(name: string, at: LngLat, contact: LngLat) {
  if (busy) return;
  pushUndo();
  resetAll();
  const id = runId;
  setBusy(true);
  setStatus(`${name}: Flusslauf bis zur Mündung nachziehen …`);
  try {
    const sec = await traceSection(at, contact, id);
    if (id !== runId) return;
    setBusy(false);
    src("river").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: sec.line } });
    setRouteEdit([sec.line[0], sec.line[sec.line.length - 1]], [sec.line], [true]);
    await runAnalysis(sec.line, name, sec.source, sec.note);
  } catch (e) {
    if (id !== runId || isCancel(e)) return;
    setBusy(false);
    setStatus(`${name}: ${(e as Error).message}`, true);
  }
}

// ---------- Verbindungswege zu Fuß ----------
let hikeA: LngLat | null = null;
const hikeHow = () => ($<HTMLInputElement>("hike-rivers").checked ? "rivers" : "points");
/** benannter Fluss nächst dem Klick (alle Teilstücke mit diesem Namen im Ausschnitt) */
async function riverAt(p: LngLat, bb: [number, number, number, number]): Promise<{ name: string; lines: LngLat[][] } | null> {
  const { rivers } = await riversInBbox(bb, fetch, 11);
  let best: { name: string; d: number } | null = null;
  for (const r of rivers) {
    const d = locateOnLine(r.coords, p).offset;
    if (d < 1000 && (!best || d < best.d)) best = { name: r.name, d };
  }
  return best ? { name: best.name, lines: rivers.filter((r) => r.name === best!.name).map((r) => r.coords) } : null;
}
async function runHike(a: LngLat, b: LngLat) {
  const id = ++runId;
  setBusy(true);
  const progress = progressFor(id);
  try {
    const { hikeBbox } = await import("./hike");
    const bb = hikeBbox(a, b);
    let from: LngLat[][] = [[a]], to: LngLat[][] = [[b]], how = "Punkt → Punkt";
    if (hikeHow() === "rivers") {
      progress("Verbindungsweg: Flüsse an den Klickpunkten suchen …");
      const [ra, rb] = await Promise.all([riverAt(a, bb).catch(() => null), riverAt(b, bb).catch(() => null)]);
      if (ra) from = ra.lines;
      if (rb) to = rb.lines;
      how = `${ra?.name ?? "Punkt"} → ${rb?.name ?? "Punkt"}`;
      if (ra && rb && ra.name === rb.name) throw new Error(`Beide Klicks liegen am selben Fluss (${ra.name}) – bitte zwei verschiedene Flüsse wählen.`);
    }
    const res = await findHike({ from, to, loader: compositeTileLoader("global"), layers: (bbox) => hikeLayersInBbox(bbox), onProgress: progress }, a, b);
    if (id !== runId) return;
    setBusy(false);
    pushUndo();
    resetAll();
    trip.push({ kind: "weg", hike: res, sel: 0, how });
    activate(trip.length - 1);
    setStatus(`Verbindungsweg: ${res.length} Route${res.length > 1 ? "n" : ""} gefunden – Indikator aus Höhenmodell und OSM-Wegen, vor Ort prüfen.`);
  } catch (e) {
    if (id !== runId || isCancel(e)) return;
    setBusy(false);
    if (current) showResults();
    setStatus(`Verbindungsweg: ${(e as Error).message}`, true);
  }
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
    // Tour: neue Strecke als eigener Abschnitt, Bearbeitung/Parameter ersetzen den aktiven Abschnitt
    if (active >= 0 && trip[active]?.kind === "fluss") Object.assign(trip[active], { cur: current, edit: routeEdit, last: lastSection });
    else { trip.push({ kind: "fluss", cur: current, edit: routeEdit, last: lastSection }); active = trip.length - 1; }
    renderTour();
    selectedD = null;
    showResults();
    // Luftbild-Datum und Abfluss parallel laden (blockiert die übrige Analyse nicht)
    void loadFlowInfo(a, id);
    void loadOsm(a, id);
    void loadTribs(a, id);
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
  if (!current || endpointDragging) return;
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
  endpointMarker(a.profile[0].p, "Einstieg", "#2a9d8f", !!routeEdit);
  endpointMarker(a.profile[a.profile.length - 1].p, "Ausstieg", "#264653", !!routeEdit);
  renderEditHandles();
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
    const short = f.detail.replace(/ · \d+ Hinweise: [^·]+?(?= ·|$)/, "").replace(" · Umtragen/Ausstieg prüfen, unbedingt erkunden", " · erkunden");
    b.innerHTML = `<span class="id" style="color:${st.color === "#111111" ? "var(--fg)" : st.color}">${st.letter}</span><span>${f.title}</span><span class="meta">${short}</span>`;
    b.title = f.detail;
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
  // Auf einen Blick nur das Wichtigste; Herkunft der Linie und Höhenmodell eingeklappt
  const steepest = a.segments.reduce((b, x) => (x.gradient > b.gradient ? x : b), a.segments[0]);
  const stats: [string, string][] = [
    ...(current.literature ? ([["Literatur", current.literature]] as [string, string][]) : []),
    ["Länge", fmtKm(a.length)],
    ["Höhe", `${a.zStart.toFixed(0)} → ${a.zEnd.toFixed(0)} m`],
    ["Höhenverlust", `${a.drop.toFixed(0)} m`],
    ["Ø Gefälle", `${a.meanGradient.toFixed(1)} m/km`],
    ["Steilster Abschnitt", steepest
      ? `<button class="linkish" id="go-steepest" title="Auf der Karte zeigen">${a.maxSegmentGradient.toFixed(1)} m/km · km ${(steepest.d0 / 1000).toFixed(1)}–${(steepest.d1 / 1000).toFixed(1)}</button>`
      : `${a.maxSegmentGradient.toFixed(1)} m/km`],
  ];
  $("stats").innerHTML = stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  if (steepest) $("go-steepest").addEventListener("click", () => jumpTo((steepest.d0 + steepest.d1) / 2));
  const more: [string, string][] = [
    ["Flusslinie", source],
    ["Höhenmodell", current.dem],
    ["Talenge", a.confinedLength > 0 ? fmtKm(a.confinedLength) : "–"],
  ];
  $("stats-more").innerHTML = more.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

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
  renderOwnList();
  renderOsm();
  tourIndex = -1;
  $("tour-label").textContent = `${tourStops().length} markierte Stellen im Luftbild ansehen`;
  $("results").hidden = false;
  $("profile-wrap").hidden = false;
  map.resize();
  requestAnimationFrame(drawChart);
}

// ---------- Gefahrenstellen (rote Welle) ----------
/** Gefahrenstelle (Vorgabe des Nutzers 11/2026) nur bei
 *  1. deutlichem Höhenverlust UND im Luftbild deutlicher Abbruchkante bzw. deutlichem Weißwasser (Kombination –
 *     schaltet Fehler im Höhenmodell wie Brücken, Talränder, Kiesbänke aus), oder
 *  2. Fluss wegen starker Verengung im Bild nicht mehr sichtbar (mögliche Klamm) und steil.
 *  Stufen nur im Höhenmodell sind keine Gefahrenstelle mehr. */
interface Hazard { d: number; center: LngLat; kind: "kante" | "stufe-weiss" | "uneinsehbar" | "eigene"; title: string; text: string }
function hazards(): Hazard[] {
  if (!current) return [];
  const a = current.analysis;
  const ww = current.ww?.status === "done" ? current.ww : undefined;
  const out: Hazard[] = [];
  for (const b of ww?.breaks ?? [])
    out.push({ d: b.d, center: b.center, kind: "kante", title: "mögliche Abbruchkante (Wasserfall, Stufe, Wehr)", text: `${breakText(b)} · Erkennung ${b.confidence} – unbedingt vorher besichtigen` });
  // eigene Stelle „Gefahrenstelle“ bzw. „Holz / Baum“ gilt immer (weltweit, ohne Luftbild-Auswertung)
  for (const x of ownOnRoute(OWN_HAZARD_OFF)) {
    if (!isHazardKind(x.l.kind)) continue;
    out.push({ d: x.at.d, center: x.l.p, kind: "eigene", title: `eigene Stelle: ${labelText(x.l)}`, text: x.l.note ?? "von dir markiert" });
  }
  // 1b) Steilstufe im Höhenmodell, an der das Luftbild deutliches Weißwasser zeigt
  for (const st of a.steps) {
    if (out.some((h) => h.d >= st.d0 - 150 && h.d <= st.d1 + 150)) continue;
    const s = (ww?.spots ?? []).find((w) => w.strong && w.d1 >= st.d0 - 50 && w.d0 <= st.d1 + 50);
    if (!s) continue;
    out.push({
      d: s.dPeak, center: s.center, kind: "stufe-weiss", title: "Stufe mit Weißwasser",
      text: `${st.drop.toFixed(0)} m Höhenverlust auf ${Math.round(st.d1 - st.d0)} m im Höhenmodell und im Luftbild deutliches Weißwasser (${Math.round(s.peakFrac * 100)} % der Wasserfläche) – möglicher Katarakt, Wasserfall oder Wehr; vorher besichtigen`,
    });
  }
  // 2) nicht einsehbar: mit offenem Orthofoto nur dort, wo auch das hochaufgelöste Bild kein Wasser zeigt
  const hiddenRuns = (d0: number, d1: number): [number, number][] => {
    const runs: [number, number][] = [];
    let r0 = -1;
    const bins = ww!.bins!.filter((b) => b.d >= d0 - 10 && b.d <= d1);
    bins.forEach((b, i) => {
      const hidden = b.coverage > 0.5 && b.width === null;
      if (hidden && r0 < 0) r0 = b.d;
      if ((!hidden || i === bins.length - 1) && r0 >= 0) { const e = hidden ? b.d + 10 : b.d; if (e - r0 >= 75) runs.push([r0, e]); r0 = -1; }
    });
    return runs;
  };
  for (const f of current.narrows?.features ?? []) {
    if (f.kind !== "klamm") continue;
    const parts = ww?.bins ? hiddenRuns(f.d0, f.d1) : [[f.d0, f.d1] as [number, number]];
    for (const [d0, d1] of parts) {
      if (out.some((h) => h.d >= d0 - 50 && h.d <= d1 + 50)) continue;
      const g = Math.max(0, ...a.segments.filter((sg) => sg.d1 >= d0 && sg.d0 <= d1).map((sg) => sg.gradient));
      const step = a.steps.find((st) => st.d1 >= d0 - 50 && st.d0 <= d1 + 50);
      if (g < 30 && !step) continue;
      const mid = (d0 + d1) / 2;
      const center = a.profile.reduce((b, q) => (Math.abs(q.d - mid) < Math.abs(b.d - mid) ? q : b)).p;
      out.push({
        d: mid, center, kind: "uneinsehbar", title: "nicht einsehbar – mögliche Klamm",
        text: `km ${(d0 / 1000).toFixed(2)}–${(d1 / 1000).toFixed(2)}: Fluss ${ww?.bins ? "auch im hochaufgelösten Luftbild" : "im Satellitenbild"} nicht sichtbar, Tal eng und beidseitig steil, Gefälle bis ${g.toFixed(0)} m/km${step ? `, Stufe ${step.drop.toFixed(0)} m im Höhenmodell` : ""} – Verlauf, Befahrbarkeit, Ausstiege und Umtragen vor Ort klären`,
      });
    }
  }
  return out.sort((x, y) => x.d - y.d);
}

function renderHazards() {
  const list = $("hz-list");
  const hz = hazards();
  list.innerHTML = hz.length ? "" : `<li class="hint">Keine Gefahrenstellen gefunden.</li>`;
  hz.forEach((h, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id ww-id" style="background:#d62828">${WAVE_SVG("#fff", 14)}</span><span>Gefahrenstelle · ${h.title} · km ${(h.d / 1000).toFixed(2)}</span><span class="meta">${h.text}</span>`;
    b.addEventListener("click", () => focusHazard(i));
    li.appendChild(b);
    list.appendChild(li);
    if (h.kind === "eigene") return; // dort steht schon das Symbol der eigenen Stelle
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

// ---------- Stellen aus OpenStreetMap (nicht geprüft) ----------
async function loadOsm(a: Analysis, id: number) {
  if (!current || current.analysis !== a) return;
  if (!$<HTMLInputElement>("opt-osmplaces").checked) {
    current.osm = { status: "off", places: [] };
    return renderOsm();
  }
  current.osm = { status: "loading", places: [] };
  renderOsm();
  try {
    const places = await loadOsmPlaces(a.profile.map((q) => q.p));
    if (id !== runId || current?.analysis !== a) return;
    current.osm = { status: "done", places };
  } catch (e) {
    if (id !== runId || current?.analysis !== a) return;
    current.osm = { status: "error", places: [], message: (e as Error).message };
  }
  showResults();
}
const OSM_ICON = (o: OsmPlace, size = 14) => icon(OSM_ICON_NAME[o.kind], size) + (o.grade ? `<span class="badge">${o.grade}</span>` : "");
const kmTxt = (d: number) => `km ${(d / 1000).toFixed(2)}`;
function renderOsm() {
  const list = $("osm-list");
  const o = current?.osm;
  list.innerHTML = "";
  if (!o || o.status === "loading") list.innerHTML = `<li class="hint">Wird aus OpenStreetMap geladen …</li>`;
  else if (o.status === "off") list.innerHTML = `<li class="hint">Ausgeschaltet (Analyse-Parameter).</li>`;
  else if (o.status === "error") list.innerHTML = `<li class="hint">${o.message ?? "OpenStreetMap nicht erreichbar"} – später erneut versuchen.</li>`;
  else if (!o.places.length) list.innerHTML = `<li class="hint">An dieser Strecke ist in OSM nichts eingetragen (Stromschnelle, Wehr, Wasserfall, Ein-/Ausstieg) – das heißt nicht, dass dort nichts ist.</li>`;
  o?.places.forEach((q, i) => {
    const st = OSM_KIND[q.kind];
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="id ww-id" style="background:${st.color};border-radius:5px;font-size:9px;color:#fff">${OSM_ICON(q)}</span><span>${osmPlaceText(q)} · ${kmTxt(q.d)}</span>` +
      `<span class="meta">aus OSM, nicht geprüft${q.note ? ` · ${escapeHtml(q.note)}` : ""}${q.offset > 60 ? ` · ${Math.round(q.offset)} m neben dem Fluss` : ""}</span>`;
    b.addEventListener("click", () => focusOsm(i));
    li.appendChild(b);
    const ln = document.createElement("a");
    ln.href = `https://www.openstreetmap.org/${q.id}`;
    ln.target = "_blank";
    ln.rel = "noopener";
    ln.className = "hint osm-link";
    ln.textContent = "in OSM ansehen ↗";
    li.appendChild(ln);
    list.appendChild(li);
    const el = document.createElement("button");
    el.className = "osm-marker";
    el.style.background = st.color;
    el.innerHTML = OSM_ICON(q);
    el.setAttribute("aria-label", `${st.text} aus OpenStreetMap`);
    el.title = `${osmPlaceText(q)} · ${kmTxt(q.d)} – aus OpenStreetMap, nicht geprüft${q.note ? ` (${q.note})` : ""}`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); focusOsm(i); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat(q.p).addTo(map));
  });
}
function focusOsm(i: number) {
  const q = current?.osm?.places[i];
  if (!q) return;
  map.flyTo({ center: q.p, zoom: DETAIL_ZOOM, duration: 900 });
  chart?.highlight(q.d);
}
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- Eigene Stellen (Planungswerkzeug, weltweit) ----------
/** eigene Stellen gelten bis zu diesem Abstand als Teil der Strecke (Lager, Zugänge liegen am Ufer) bzw. als Gefahrenstelle */
const OWN_ROUTE_OFF = 500, OWN_HAZARD_OFF = 100;
const wwAuto = () => $<HTMLInputElement>("opt-ww").checked;
const OWN_COLOR = (l: WhitewaterLabel) =>
  isHazardKind(l.kind) ? "#d62828" : l.schwall ? "#0077b6"
    : ({ umtragen: "#6d597a", zugang: "#2a9d8f", lager: "#606c38", notiz: "#5c677d" } as Record<string, string>)[l.kind ?? ""] ?? "#8d99ae";
/** Symbol statt Buchstabe (sprachunabhängig); Grad als kleines Schild */
const OWN_ICON = (l: WhitewaterLabel, size = 14) =>
  icon(KIND_ICON[l.kind ?? (l.schwall ? "schwall" : "sonstiges")] ?? "notiz", size) + (l.grade && isGraded(l.kind ?? (l.schwall ? "schwall" : undefined)) ? `<span class="badge">${l.grade}</span>` : "");
const OWN_SYM: Record<string, string> = { gefahr: "Danger Area", holz: "Danger Area", umtragen: "Trail Head", zugang: "Boat Ramp", lager: "Campground", notiz: "Flag, Blue" };
/** angezeigte eigene Stellen an der aktuellen Strecke (mit Stationierung), flussabwärts sortiert */
function ownOnRoute(maxOff = OWN_ROUTE_OFF): { l: WhitewaterLabel; at: { d: number; offset: number } }[] {
  if (!current) return [];
  const line = current.analysis.profile.map((q) => q.p);
  return wwLabels
    .filter((l) => l.show)
    .map((l) => ({ l, at: locateOnLine(line, l.p) }))
    .filter((x) => x.at.offset <= maxOff)
    .sort((x, y) => x.at.d - y.at.d);
}
/** Symbole aller angezeigten eigenen Stellen – unabhängig von einer Analyse, überall auf der Welt */
function renderOwnMarkers() {
  ownMarkers.forEach((m) => m.remove());
  ownMarkers = [];
  for (const l of wwLabels) {
    if (!l.show) continue;
    const el = document.createElement("button");
    el.className = "own-marker";
    el.style.background = OWN_COLOR(l);
    el.innerHTML = OWN_ICON(l);
    el.setAttribute("aria-label", `Eigene Stelle: ${labelText(l)}`);
    el.title = `Eigene Stelle: ${labelText(l)}${l.note ? ` – ${l.note}` : ""} (anklicken = bearbeiten)`;
    const mk = new maplibregl.Marker({ element: el, draggable: mode === "ww-label" }).setLngLat(l.p).addTo(map);
    let dragged = false;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (dragged) { dragged = false; return; }
      addLabelAt(l.p, { edit: l });
    });
    mk.on("dragstart", () => { dragged = true; labelPopup?.remove(); });
    mk.on("dragend", () => {
      lastDragEnd = Date.now();
      const i = wwLabels.indexOf(l);
      if (i < 0) return;
      pushUndo();
      const to: LngLat = [mk.getLngLat().lng, mk.getLngLat().lat];
      wwLabels[i] = { ...l, p: to, feat: undefined, src: undefined, ...(isPlanKind(l.kind) ? {} : featAt(to)) };
      afterLabelChange();
      addLabelAt(to, { edit: wwLabels[i] });
    });
    ownMarkers.push(mk);
  }
}
/** Liste aller eigenen Stellen in der linken Leiste (auch ohne Analyse): an der Strecke mit km, sonst „abseits“; ✕ löscht */
function renderOwnList() {
  const list = $("own-list");
  const on = ownOnRoute();
  const shown = wwLabels.filter((l) => l.show);
  $("own-panel").hidden = shown.length === 0;
  const rest = shown.filter((l) => !on.some((x) => x.l === l));
  list.innerHTML = "";
  const item = (l: WhitewaterLabel, where: string, d?: number) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "ghost";
    b.innerHTML = `<span class="id ww-id" style="background:${OWN_COLOR(l)};font-size:9px;color:#fff">${OWN_ICON(l)}</span><span>${labelText(l)}${where ? ` · ${where}` : ""}</span>` +
      `<span class="meta">${l.note ? escapeHtml(l.note) : "eigene Stelle"}</span>`;
    b.addEventListener("click", () => { map.flyTo({ center: l.p, zoom: Math.max(map.getZoom(), 15), duration: 900 }); if (d !== undefined) chart?.highlight(d); });
    const del = document.createElement("button");
    del.className = "ghost own-del";
    del.title = "Diese Stelle löschen (rückgängig mit ↶)";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      const i = wwLabels.indexOf(l);
      if (i < 0) return;
      pushUndo();
      wwLabels.splice(i, 1);
      afterLabelChange();
    });
    li.append(b, del);
    list.appendChild(li);
  };
  on.forEach((x) => item(x.l, kmTxt(x.at.d), x.at.d));
  rest.forEach((l) => item(l, current ? "abseits der Strecke" : ""));
  $("own-info").textContent = `${shown.length} eigene Stelle${shown.length === 1 ? "" : "n"}${current ? `, ${on.length} an dieser Strecke` : ""}. Gespeichert in diesem Browser – zur Sicherung „Stellen sichern“.`;
}
/** eigene (ohne die als Gefahrenstelle exportierten) und OSM-Stellen als Wegpunkte */
function exportPlaces(): PlaceOut[] {
  if (!current) return [];
  const own: PlaceOut[] = ownOnRoute()
    .filter((x) => !(isHazardKind(x.l.kind) && x.at.offset <= OWN_HAZARD_OFF))
    .map((x) => ({
      d: x.at.d, center: x.l.p, title: `${labelText(x.l)} ${kmTxt(x.at.d)}`,
      text: `Eigene Stelle: ${labelText(x.l)}${x.l.note ? ` – ${x.l.note}` : ""}`,
      sym: OWN_SYM[x.l.kind ?? ""] ?? "Caution", type: "Eigene Stelle", source: "eigene", kind: x.l.kind ?? (x.l.schwall ? "schwall" : "sonstiges"),
    }));
  const osm: PlaceOut[] = (current.osm?.places ?? []).map((o) => ({
    d: o.d, center: o.p, title: `${OSM_KIND[o.kind].text}${o.grade ? ` WW ${o.grade}` : ""} ${kmTxt(o.d)} (OSM)`,
    text: `${osmPlaceText(o)} – aus OpenStreetMap, nicht geprüft${o.note ? ` (${o.note})` : ""}. Vor Ort prüfen.`,
    sym: OSM_KIND[o.kind].sym, type: "OSM, nicht geprüft", source: "osm", kind: o.kind,
  }));
  return [...own, ...osm].sort((x, y) => x.d - y.d);
}

// ---------- Schwallstellen: Weißwasser im offenen Orthofoto (experimentell) ----------
const WW_STYLE = (s: WhitewaterSpot) => (s.hazard || s.own?.kind === "gefahr" ? "#d62828" : s.own && !s.area ? "#2a9d8f" : "#0077b6");
const breakText = (b: Breakline) =>
  `Weißwasser/Gischt setzt schlagartig ein (${Math.round(b.above * 100)} % → ${Math.round(b.below * 100)} % der Flussmitte), Höhenmodell ${b.drop.toFixed(0)} m Höhenverlust`;
/** Wellensymbol (bewusst ohne Nummer/Stufe – keine Schwierigkeitsangabe) */
export const WAVE_SVG = (color = "#fff", size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">` +
  `<path d="M2 9c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/><path d="M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2 5-1"/></svg>`;
const kmRange = (s: WhitewaterSpot) => `km ${(s.d0 / 1000).toFixed(2)}–${(s.d1 / 1000).toFixed(2)}`;

const OPEN_SOURCES_TEXT = "Ausgewertet werden nur offen lizenzierte Orthofotos: Österreich (basemap.at), Slowenien (GURS DOF 2023), USA (NAIP), Island (NÁTT, nur Teile). Esri, Google, Apple u. a. dürfen nur angezeigt werden; Sentinel-2 ist für Stromschnellen zu grob.";
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
  if (!imageUsable(ww.bins)) return [];
  fillLabelFeatures();
  const steps = (ww.breaks ?? []).map((b) => ({ d0: b.d - 20, d1: b.d + 20 }));
  const par = effParams(), m = activeModel(), thr = modelThreshold(wwSensitivity);
  const accept = m ? (b: WhitewaterBin) => b.width !== null && modelProb(m, b) >= thr : undefined;
  const found = describeSpots(findSpots(ww.bins, par, accept), ww.track, ww.bins, { gradientAt, steps });
  return applyLabels(found, labelsOnLine()).filter((s) => s.own || !wwHidden.some((h) => haversine(h, s.center) < 30));
}

/** eigene Markierungen, die höchstens 60 m neben der aktuellen Flusslinie liegen, mit Stationierung */
function labelsOnLine(): { label: WhitewaterLabel; d: number; p: LngLat }[] {
  if (!current) return [];
  const line = current.analysis.profile.map((q) => q.p);
  return wwLabels.map((label) => ({ label, at: locateOnLine(line, label.p) })).filter((x) => x.at.offset < 60).map((x) => ({ label: x.label, d: x.at.d, p: x.label.p }));
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
  renderSensitivity();
  const ww = current?.ww;
  $("ww-section").hidden = !ww || ww.status === "off";
  const list = $("ww-list"), meta = $("ww-meta");
  $<HTMLElement>("ww-sens").parentElement!.hidden = !(ww?.status === "done" && ww.bins && imageUsable(ww.bins));
  list.innerHTML = "";
  if (!ww || ww.status === "loading") {
    list.innerHTML = `<li class="hint">${ww ? `Wird im Orthofoto (${ww.source?.name}) gesucht …` : "Wird berechnet …"}</li>`;
    meta.textContent = "";
  } else if (ww.status === "off") {
    list.innerHTML = `<li class="hint">Ausgeschaltet (Analyse-Parameter).</li>`;
    meta.textContent = "";
  } else if (ww.status === "none") {
    list.innerHTML = `<li class="hint ww-noimg"><b>Kein auswertbares Luftbild für diese Region</b> – Schwälle bitte selbst im Luftbild prüfen (◀ ▶, „Schärfer ↗“).</li>`;
    meta.textContent = `Das angezeigte Luftbild darf nur angezeigt, nicht ausgewertet werden; Gefälle und Schluchten bleiben als Indikatoren. ${OPEN_SOURCES_TEXT}`;
  } else if (ww.status === "error") {
    list.innerHTML = `<li class="hint">Weißwasser-Suche fehlgeschlagen: ${ww.message}</li>`;
    meta.textContent = "";
  } else if (ww.bins && !imageUsable(ww.bins)) {
    list.innerHTML = `<li class="hint ww-noimg"><b>Offenes Luftbild deckt diese Strecke nicht ab</b> – Schwälle bitte selbst im Luftbild prüfen (◀ ▶, „Schärfer ↗“).</li>`;
    meta.textContent = `${ww.source?.name ?? "Bildquelle"}: ohne Bilddaten an dieser Strecke (z. B. außerhalb des Mosaiks). ${OPEN_SOURCES_TEXT}`;
  } else {
    if (!ww.spots.length) list.innerHTML = `<li class="hint">Keine Stellen über der Schwelle (${effParams().spotDensity.toFixed(1).replace(".", ",")} m² Weißwasser je Flussmeter, Empfindlichkeit ${wwSensitivity}).</li>`;
    ww.spots.forEach((s, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.innerHTML =
        `<span class="id ww-id" style="background:${WW_STYLE(s)}">${WAVE_SVG("#fff", 14)}</span><span>${s.hazard || s.own?.kind === "gefahr" ? "Gefahrenstelle" : "Schwallstelle"} · ${kmRange(s)}${s.own ? " ✓" : ""}</span>` +
        `<span class="meta">${s.area ? `${Math.round(s.area)} m² Weißwasser · ${Math.round(s.peakFrac * 100)} % der Wasserfläche` : "nur eigene Markierung"}${s.notes.length ? ` · ${s.notes.map((n) => n.replace(/ \(~?\d+ % der üblichen Breite\)/, "")).join(" · ")}` : ""}</span>`;
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
  // Marker (im Modus „Stellen markieren“ verschieb- und bearbeitbar)
  wwMarkers = [];
  ww?.spots.forEach((s, i) => {
    if (s.hazard || s.own) return; // dort steht schon die rote Welle (Gefahrenstelle) bzw. das Symbol der eigenen Stelle
    const el = document.createElement("button");
    el.className = "ww-marker";
    el.style.cssText = `background:${WW_STYLE(s)};width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px #0008;padding:0;cursor:pointer;display:grid;place-items:center`;
    el.innerHTML = WAVE_SVG("#fff", 15);
    el.setAttribute("aria-label", s.hazard ? "Gefahrenstelle" : "Schwallstelle");
    el.title = `${s.hazard ? "Gefahrenstelle" : "Schwallstelle"} ${kmRange(s)}: Weißwasser im Luftbild ${Math.round(s.area)} m²${s.notes.length ? `, ${s.notes.join(", ")}` : ""}`;
    const mk = new maplibregl.Marker({ element: el, draggable: mode === "ww-label" }).setLngLat(s.center).addTo(map);
    let dragged = false;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (dragged) { dragged = false; return; }
      if (mode === "ww-label") return addLabelAt(s.own ? s.own.p : s.center, { detected: true });
      focusWw(i);
    });
    mk.on("dragstart", () => { dragged = true; labelPopup?.remove(); });
    mk.on("dragend", () => { lastDragEnd = Date.now(); moveSpot(s, [mk.getLngLat().lng, mk.getLngLat().lat]); });
    markers.push(mk);
    wwMarkers.push(mk);
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
    features: wwLabels.flatMap((l, i) => (l.show ? [] : [{ type: "Feature" as const, properties: { i, schwall: l.schwall, gefahr: l.kind === "gefahr", show: false, text: l.schwall ? (l.grade ?? "") : "✕" }, geometry: { type: "Point" as const, coordinates: l.p } }])),
  });
  const learn = wwLabels.filter((l) => !isPlanKind(l.kind));
  const pos = learn.filter((l) => l.schwall).length, withF = learn.filter((l) => l.feat).length, shown = learn.filter((l) => l.show).length;
  $("ww-learn-info").textContent =
    `${learn.length} eigene Markierung${learn.length === 1 ? "" : "en"} (${pos} Schwall, ${learn.length - pos} kein Schwall; ${withF} mit Luftbild-Merkmalen; ${shown} auch in der Karte angezeigt, übrige nur zum Lernen) · ` +
    (activeModel()
      ? `Erkennung „${gradeName(wwMinGrade)}“ mit gelerntem Modell (${activeModel()!.pos + activeModel()!.neg} Markierungen, Trefferquote ${Math.round(activeModel()!.acc * 100)} % statt ${Math.round((activeModel()!.accFixed ?? 0) * 100)} % mit fester Schwelle, ${fmtDate(activeModel()!.date)}), Empfindlichkeit ${wwSensitivity}. `
      : wwMinGrade > 1 ? `Für „${gradeName(wwMinGrade)}“ gibt es noch kein brauchbares Modell – angezeigt werden alle erkannten Schwälle (feste Schwelle ${effParams().spotDensity.toFixed(1).replace(".", ",")} m²/m). `
      : `Feste Schwelle ${effParams().spotDensity.toFixed(1).replace(".", ",")} m² Weißwasser je Flussmeter (Empfindlichkeit ${wwSensitivity}, Flussbreite); ein gelerntes Modell ersetzt sie erst, wenn es nachweislich besser trifft. `) +
    `Markierungen nur zum Lernen sind nur im Modus „Eigene Stellen“ als Punkte sichtbar; die mit Häkchen „anzeigen“ erscheinen als eigene Stelle bzw. blenden Erkennungen aus. Gespeichert nur in diesem Browser – zur Sicherung exportieren.`;
}

let labelPopup: maplibregl.Popup | null = null;
/** Stelle, die mit „Verschieben“ auf den nächsten Kartenklick wartet */
let movingLabel: WhitewaterLabel | null = null;
/** Grad gibt es nur bei Stromschnelle und Walze (Wehr, Gefahrenstelle: ohne Grad) */
const isGraded = (k?: LabelKind) => k === "schwall" || k === "walze";
/** Fenster ganz in den Kartenausschnitt holen (unten liegt das Höhenprofil, oben die Kopfleiste) */
function keepPopupVisible(p: maplibregl.Popup) {
  requestAnimationFrame(() => {
    const el = p.getElement();
    if (!el) return;
    const r = el.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect();
    const top = m.top + 60, bottom = m.bottom - 10;
    const dy = r.bottom > bottom ? r.bottom - bottom : r.top < top ? r.top - top : 0;
    if (dy) map.panBy([0, dy], { duration: 300 });
  });
}
/** verschobene Stelle übernehmen */
function moveLabelTo(l: WhitewaterLabel, to: LngLat) {
  const i = wwLabels.indexOf(l);
  movingLabel = null;
  map.getCanvas().style.cursor = mode === "idle" ? "" : "crosshair";
  if (i < 0) return;
  pushUndo();
  wwLabels[i] = { ...l, p: to, feat: undefined, src: undefined, ...(isPlanKind(l.kind) ? {} : featAt(to)) };
  afterLabelChange();
  setStatus("Stelle verschoben.");
}
/** zuletzt gewählter Schwierigkeitsgrad bleibt für die nächste Markierung vorausgewählt */
let lastGrade: Grade | undefined;
/** Bildmerkmale an einer Stelle der aktuellen Analyse (für das lernende Modell) */
function featAt(p: LngLat) {
  const ww = current?.ww;
  if (!current || ww?.status !== "done" || !ww.bins || !imageUsable(ww.bins)) return {};
  const at = locateOnLine(current.analysis.profile.map((q) => q.p), p);
  if (at.offset > 60) return {};
  return { src: ww.source?.id, feat: binFeat(ww.bins, at.d) ?? undefined };
}
function addLabelAt(p: LngLat, opts: { detected?: boolean; edit?: WhitewaterLabel } = {}) {
  const auto = wwAuto();
  // vorhandene Stelle in der Nähe → bearbeiten statt doppelt anlegen (ohne Erkennung nur angezeigte eigene Stellen)
  const near = opts.edit
    ? wwLabels.indexOf(opts.edit)
    : wwLabels.findIndex((l) => (auto || l.show) && haversine(l.p, p) < 12 * 2 ** (17 - Math.min(17, map.getZoom())));
  const old = near >= 0 ? wwLabels[near] : undefined;
  const at = old ? old.p : p;
  let grade = old?.grade ?? lastGrade;
  labelPopup?.remove();
  const box = document.createElement("div");
  box.className = "ww-popup";
  const btn = (k: (typeof LABEL_KINDS)[number]) =>
    `<button data-k="${k.id}" class="${k.schwall ? "" : "ghost"}${old?.kind === k.id ? " sel" : ""}" title="${k.text}">${icon(KIND_ICON[k.id], 14, "currentColor")} ${k.text}</button>`;
  const learnKinds = LABEL_KINDS.filter((k) => !k.schwall && !k.plan);
  box.innerHTML =
    `<b>${old ? `Markiert: ${labelText(old)} – ändern` : "Eigene Stelle: Was ist hier?"}</b>` +
    `<div class="lbl-sec">Wildwasser · Grad <span class="lbl-grades">${GRADES.map((g) => `<button data-g="${g}" class="g${grade === g ? " sel" : ""}">${g}</button>`).join("")}</span></div>` +
    `<div class="row wrap">${LABEL_KINDS.filter((k) => k.schwall && isGraded(k.id)).map(btn).join("")}</div>` +
    `<div class="lbl-sec">Planung <span class="hint">(ohne Grad)</span></div><div class="row wrap lbl-plan">${LABEL_KINDS.filter((k) => k.plan || (k.schwall && !isGraded(k.id))).map(btn).join("")}</div>` +
    (auto
      ? `<div class="lbl-sec">kein Schwall <span class="hint">(zum Lernen der Erkennung)</span></div><div class="row wrap">${learnKinds.map(btn).join("")}</div>` +
        `<label class="lbl-show"><input type="checkbox" class="lbl-show-cb"${!old || old.show ? " checked" : ""}> in der Karte anzeigen <span class="hint">(sonst nur zum Lernen)</span></label>`
      : "") +
    `<input class="lbl-note" maxlength="200" placeholder="Notiz (optional, Enter speichert)" value="${escapeHtml(old?.note ?? "")}">` +
    (old ? `<div class="row"><button data-move class="ghost move" title="Danach die neue Position in der Karte anklicken">Verschieben</button><button data-del class="ghost danger">Stelle löschen</button></div>` : "") +
    (opts.detected && !old ? `<div class="row"><button data-hide class="ghost danger" title="Erkannte Stelle aus der Karte entfernen (ohne Bewertung fürs Lernen)">Erkannte Stelle löschen</button></div><p class="hint" style="margin:4px 0 0">Verschieben: Symbol mit der Maus ziehen.</p>` : "");
  box.querySelectorAll<HTMLButtonElement>("button[data-g]").forEach((b) =>
    b.addEventListener("click", () => {
      grade = grade === b.dataset.g ? undefined : (b.dataset.g as Grade);
      lastGrade = grade;
      box.querySelectorAll<HTMLButtonElement>("button[data-g]").forEach((x) => x.classList.toggle("sel", x.dataset.g === grade));
    }),
  );
  const commit = (id: LabelKind) => {
    pushUndo();
    const k = LABEL_KINDS.find((x) => x.id === id)!;
    const note = box.querySelector<HTMLInputElement>(".lbl-note")!.value.trim() || undefined;
    const cb = box.querySelector<HTMLInputElement>(".lbl-show-cb");
    const keepFeat = old?.feat && !k.plan ? { src: old.src, feat: old.feat } : undefined;
    const label: WhitewaterLabel = {
      p: at, schwall: k.schwall, kind: k.id, grade: isGraded(k.id) ? grade : undefined, note,
      show: k.plan || !cb || cb.checked || undefined,
      date: new Date().toISOString().slice(0, 10), ...(k.plan ? {} : keepFeat ?? featAt(at)),
    };
    if (old) wwLabels[near] = label;
    else wwLabels.push(label);
    afterLabelChange();
    labelPopup?.remove();
  };
  box.querySelectorAll<HTMLButtonElement>("button[data-k]").forEach((b) => b.addEventListener("click", () => commit(b.dataset.k as LabelKind)));
  box.querySelector<HTMLInputElement>(".lbl-note")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(old?.kind ?? (old?.schwall ? "schwall" : "notiz"));
  });
  box.querySelector("button[data-del]")?.addEventListener("click", () => {
    pushUndo();
    wwLabels.splice(near, 1);
    afterLabelChange();
    labelPopup?.remove();
  });
  box.querySelector("button[data-move]")?.addEventListener("click", () => {
    movingLabel = old ?? null;
    labelPopup?.remove();
    map.getCanvas().style.cursor = "crosshair";
    setStatus("Stelle verschieben: neue Position in der Karte anklicken (Esc bricht ab).");
  });
  box.querySelector("button[data-hide]")?.addEventListener("click", () => {
    pushUndo();
    wwHidden.push(at);
    saveHidden(wwHidden);
    afterLabelChange();
    labelPopup?.remove();
  });
  labelPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "300px" }).setLngLat(at).setDOMContent(box).addTo(map);
  keepPopupVisible(labelPopup);
}
/** Markierungen ohne Bildmerkmale (ältere Version, oder vor der Analyse gesetzt) an der aktuellen Strecke ergänzen –
 *  bei jeder Auswertung automatisch, damit sie fürs Lernen zählen. */
function fillLabelFeatures() {
  let n = 0;
  for (const l of wwLabels) {
    if (l.feat || isPlanKind(l.kind)) continue;
    const f = featAt(l.p);
    if (f.feat) { Object.assign(l, f); n++; }
  }
  if (n) saveLabels(wwLabels);
}
/** Stelle verschieben: eigene Markierung wandert mit; eine erkannte Stelle wird ausgeblendet und als eigene,
 *  angezeigte Markierung an der neuen Stelle übernommen (danach Auswahlfenster zum Anpassen). */
function moveSpot(s: WhitewaterSpot, to: LngLat) {
  pushUndo();
  const i = s.own ? wwLabels.indexOf(s.own) : -1;
  if (i >= 0) {
    wwLabels[i] = { ...wwLabels[i], p: to, feat: undefined, src: undefined };
    Object.assign(wwLabels[i], featAt(to));
  } else {
    wwHidden.push(s.center);
    saveHidden(wwHidden);
    wwLabels.push({ p: to, schwall: true, kind: "schwall", grade: lastGrade, show: true, date: new Date().toISOString().slice(0, 10), ...featAt(to) });
  }
  afterLabelChange();
  addLabelAt(to);
}
function afterLabelChange() {
  saveLabels(wwLabels);
  renderOwnMarkers();
  renderOwnList();
  if (current) {
    if (current.ww?.bins) current.ww.spots = computeSpots();
    showResults();
  } else renderLabels();
}

$("own-export").addEventListener("click", () => $("ww-export").click());
$("own-import").addEventListener("click", () => $("ww-import").click());
$("hike-btn").addEventListener("click", () => {
  if (busy) return;
  hikeA = null;
  setMode(mode.startsWith("hike") ? "idle" : "hike-a");
});
$("tour-gpx").addEventListener("click", () => {
  const items = trip.flatMap((t, i) => {
    if (t.kind === "fluss" && t.cur) return [{ name: `${i + 1} ${t.cur.name}`, type: "Packrafting", pts: t.cur.analysis.profile.map((q) => ({ p: q.p, z: q.z })) }];
    const r = t.hike?.[t.sel ?? 0];
    return r ? [{ name: `${i + 1} Verbindungsweg${t.how ? ` ${t.how}` : ""}`, type: "Wandern", pts: r.line.map((p, k) => ({ p, z: r.elev[k] })), pass: { p: r.pass, z: r.maxElev, text: `${fmtKm(r.lengthM)}, Aufstieg ${Math.round(r.ascent)} m, Abstieg ${Math.round(r.descent)} m, ca. ${fmtH(r.hours)} (DIN 33466)` } }] : [];
  });
  if (items.length) download(`tour-${new Date().toISOString().slice(0, 10)}.gpx`, toTourGpx(items), "application/gpx+xml");
});
map.on("click", "tribs-hit", (e) => {
  if (mode !== "idle" || busy) return;
  const f = e.features?.[0];
  if (!f) return;
  const pr = f.properties as { name: string; cx: number; cy: number };
  void analyzeTrib(pr.name, [e.lngLat.lng, e.lngLat.lat], [pr.cx, pr.cy]);
});
map.on("mouseenter", "tribs-hit", (e) => {
  if (mode !== "idle") return;
  map.getCanvas().style.cursor = "pointer";
  const name = (e.features?.[0]?.properties as { name?: string } | undefined)?.name;
  if (name) setStatus(`${name}: anklicken = ab hier bis zur Mündung analysieren (wird als weiterer Abschnitt der Tour angelegt).`);
});
map.on("mouseleave", "tribs-hit", () => { if (mode === "idle") map.getCanvas().style.cursor = ""; });
map.on("click", "tour-river", (e) => {
  if (mode !== "idle" || busy) return;
  const i = (e.features?.[0]?.properties as { i?: number } | undefined)?.i;
  if (i !== undefined) activate(i);
});
map.on("click", "tour-hike", (e) => {
  if (mode !== "idle" || busy) return;
  const pr = e.features?.[0]?.properties as { i?: number; k?: number } | undefined;
  if (pr?.i === undefined) return;
  trip[pr.i].sel = pr.k ?? 0;
  activate(pr.i);
});
$("edit-btn").addEventListener("click", () => {
  if (busy) return;
  if (!routeEdit) return setStatus("Erst eine Strecke festlegen (Ein-/Ausstieg, Zeichnen oder Referenzstrecke).", true);
  setMode(mode === "edit" ? "idle" : "edit");
});
$("own-btn").addEventListener("click", () => setMode(mode === "ww-label" ? "idle" : "ww-label"));
const SENS_TEXT = (v: number) => (v <= 2 ? "nur große Schwälle" : v <= 4 ? "eher große" : v === 5 ? "Standard" : v <= 7 ? "auch kleinere" : "auch kleine");
function renderSensitivity() {
  $<HTMLInputElement>("ww-sens").value = String(wwSensitivity);
  const w = current?.ww?.bins ? typicalWidth(current.ww.bins) : null;
  $("ww-sens-out").textContent = `${SENS_TEXT(wwSensitivity)}${w ? ` · Fluss ~${Math.round(w)} m breit${Math.abs(widthFactor(w) - 1) > 0.02 ? ` (Schwelle ×${widthFactor(w).toFixed(2).replace(".", ",")})` : ""}` : ""}`;
}
$<HTMLSelectElement>("ww-mingrade").value = String(wwMinGrade);
$("ww-mingrade").addEventListener("change", (e) => {
  wwMinGrade = Number((e.target as HTMLSelectElement).value);
  try { localStorage.setItem(MINGRADE_KEY, String(wwMinGrade)); } catch { /* privater Modus */ }
  if (current?.ww?.bins) { current.ww.spots = computeSpots(); showResults(); }
  else renderLabels();
});
$("ww-sens").addEventListener("input", (e) => {
  wwSensitivity = Number((e.target as HTMLInputElement).value);
  try { localStorage.setItem(SENS_KEY, String(wwSensitivity)); } catch { /* privater Modus */ }
  if (current?.ww?.bins) { current.ww.spots = computeSpots(); showResults(); }
  renderSensitivity();
});
renderSensitivity();
renderOwnMarkers();
renderOwnList();
$("ww-learn").addEventListener("click", () => {
  // Merkmale für Markierungen der aktuellen Strecke nachtragen (falls beim Markieren noch keine Analyse lief)
  for (const l of wwLabels) if (!l.feat && !isPlanKind(l.kind)) Object.assign(l, featAt(l.p));
  saveLabels(wwLabels);
  const withF = wwLabels.filter((l) => l.feat);
  const res = trainGradeModels(wwLabels);
  wwModels = res.map((r) => r.model).filter((m): m is WwModel => !!m);
  saveModels(wwModels);
  if (current?.ww?.bins) { current.ww.spots = computeSpots(); showResults(); }
  else renderLabels();
  const graded = withF.filter((l) => l.schwall && l.grade).length, ungraded = withF.filter((l) => l.schwall && !l.grade).length;
  const rows = res.map((r) => {
    const m = r.model;
    const head = `<b>${gradeName(r.k)}</b>: ${r.pos} ${r.k === 1 ? "Schwall" : "ab diesem Grad"} / ${r.neg} ${r.k === 1 ? "kein Schwall" : "darunter oder kein Schwall"}`;
    if (!m) return `${head} – zu wenige (je 5 nötig), feste Schwelle`;
    return `${head} – Modell ${Math.round(m.acc * 100)} %, feste Schwelle ${Math.round((m.accFixed ?? 0) * 100)} % → ${modelUsable(m) ? "<b>Modell wird verwendet</b>" : "feste Schwelle bleibt"}`;
  });
  const ok = wwModels.some((m) => modelUsable(m));
  showLearnResult(
    `${ok ? "✓" : "✗"} Verarbeitet: ${withF.length} von ${wwLabels.length} Markierungen mit Luftbild-Merkmalen (${graded} Schwälle mit Grad, ${ungraded} ohne Grad – zählen nur bei „alle Schwälle“).<br>` +
      rows.join("<br>") +
      (wwLabels.length > withF.length ? `<br>${wwLabels.length - withF.length} Markierungen noch ohne Merkmale – die zugehörige Strecke auswerten und erneut lernen.` : "") +
      `<br>Tipp: kleine, unwichtige Schwälle als „Stromschnelle WW I“ markieren statt „kein Schwall“ – dann lernt die App die Stärke.`,
    ok,
  );
  setStatus(ok ? "Modell(e) gelernt – Details unter den Schwallstellen." : "Gelernt, aber noch kein Modell besser als die feste Schwelle – Details unter den Schwallstellen.", !ok);
});
$("ww-reset").addEventListener("click", () => {
  wwParams = { ...DEFAULT_PARAMS };
  saveParams(wwParams);
  wwModels = [];
  saveModels(wwModels);
  if (current?.ww?.bins) current.ww.spots = computeSpots();
  if (current) showResults();
  else renderLabels();
});
// Export: mit GitHub-Schlüssel direkt ins Repo (daten/markierungen/), sonst – oder bei Fehler – als Datei
$("ww-export").addEventListener("click", async () => {
  const json = exportJson(wwLabels, wwParams, wwModels);
  const saveFile = () => download(`schwallstellen-markierungen-${new Date().toISOString().slice(0, 10)}.json`, json, "application/json");
  const token = ghToken();
  if (!token) {
    saveFile();
    return setStatus("Als Datei gespeichert. Für den direkten Upload ins Repo den GitHub-Schlüssel unter „Analyse-Parameter“ eintragen.");
  }
  setStatus(`Lade ${wwLabels.length} Markierungen zu GitHub hoch …`);
  try {
    const r = await uploadLabels(json, token, { count: wwLabels.length });
    showLearnResult(`✓ ${wwLabels.length} Markierungen hochgeladen nach <a href="${r.url}" target="_blank" rel="noopener">${r.path}</a> – bereit für die Auswertung.`, true);
    setStatus(`✓ ${wwLabels.length} Stellen/Markierungen hochgeladen nach ${r.path}.`);
  } catch (e) {
    saveFile();
    setStatus(`Upload fehlgeschlagen (${(e as Error).message}) – stattdessen als Datei gespeichert.`, true);
  }
});
$<HTMLInputElement>("gh-token").value = ghToken();
$("gh-token").addEventListener("change", () => setGhToken($<HTMLInputElement>("gh-token").value));
/** sichtbare Rückmeldung zu Lernen/Upload (bleibt stehen, bis zur nächsten Aktion) */
function showLearnResult(html: string, ok: boolean) {
  const el = $("ww-learn-result");
  el.innerHTML = html;
  el.classList.toggle("bad", !ok);
  el.hidden = false;
}
$("ww-clear").addEventListener("click", () => {
  if (!wwLabels.length) return setStatus("Keine eigenen Markierungen gespeichert.");
  if (!confirm(`Alle ${wwLabels.length} eigenen Markierungen in diesem Browser löschen? Das gelernte Modell bleibt erhalten. Tipp: vorher „Markierungen exportieren“.`)) return;
  wwLabels = [];
  wwHidden = [];
  saveHidden(wwHidden);
  afterLabelChange();
  setStatus("Eigene Markierungen gelöscht.");
});
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
    if (imp.models.length) { wwModels = imp.models; saveModels(wwModels); }
    if (current?.ww?.bins) current.ww.spots = computeSpots();
    if (current) showResults();
    else renderLabels();
    setStatus(`${imp.labels.length} Markierungen importiert${imp.models.length ? " (inkl. gelernter Modelle)" : imp.params ? " (inkl. gelernter Schwelle)" : ""}.`);
  } catch (err) {
    setStatus(`Import fehlgeschlagen: ${(err as Error).message}`, true);
  }
});
map.on("load", () => renderLabels());

/** im Profil angeklickte Stelle (bleibt auf der Karte markiert, bis die Maus wieder übers Profil fährt) */
let selectedD: number | null = null;

function drawChart() {
  if (!current || $("profile-wrap").hidden || $("profile-wrap").classList.contains("collapsed")) return;
  const a = rated() ?? current.analysis;
  const pointAt = (d: number) => a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).p;
  const showCursor = (d: number | null) =>
    src("cursor").setData(d === null ? empty : { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pointAt(d) } });
  const f = current.flow;
  const stretches = (f?.imagery ?? []).map((im, k) => {
    const c = f!.conditions.get(im.date);
    const date = fmtDate(im.date);
    return {
      d0: im.d0, d1: im.d1, color: IMG_COLORS[k % IMG_COLORS.length],
      label: `B${k + 1} · ${date}${c ? ` · ${c.tendency}` : ""}`,
      title: `Luftbild B${k + 1}: aufgenommen ${date}, km ${(im.d0 / 1000).toFixed(1)}–${(im.d1 / 1000).toFixed(1)}` +
        `${c ? ` · Wasserstand laut Wetter/Jahreszeit ${c.tendency}${c.hints.length ? ` (${c.hints.map((h) => h.text).join("; ")})` : ""}` : ""}` +
        " – Klick: Abschnitt auf der Karte und Hinweise zeigen",
    };
  });
  chart = renderProfile($("profile"), a, current.narrows, (d) => showCursor(d ?? selectedD),
    [
      ...(current.ww?.spots ?? []).filter((w) => !w.hazard && !w.own),
      ...ownOnRoute(OWN_HAZARD_OFF).filter((x) => x.l.schwall && !isHazardKind(x.l.kind)).map((x) => ({ d0: x.at.d - 15, d1: x.at.d + 15, strong: false })),
      ...hazards().map((h) => ({ d0: h.d - 20, d1: h.d + 20, strong: true, hazard: true })),
    ],
    {
      stretches,
      onStretch: (k) => {
        selectedD = null;
        focusImageStretch(k);
        document.querySelector(`#flow-info .day[data-sec="${k}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      onSelect: (d) => jumpTo(d),
    });
}

/** Klick ins Höhenprofil: Karte springt zu dieser Stelle der Strecke. Liegt dort eine markierte Stelle
 *  (Gefahren-, Schwallstelle, Schlucht), wird so weit hineingezoomt, dass sie im Luftbild erkennbar ist. */
function jumpTo(d: number) {
  if (!current) return;
  const a = current.analysis;
  selectedD = d;
  const p = a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b)).p;
  src("cursor").setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } });
  const tol = Math.max(60, a.length / 150); // ~ein paar Pixel im Profil
  const marked = tourStops().some((s) => Math.abs(s.d - d) <= tol) ||
    (current.narrows?.features ?? []).some((f) => d >= f.d0 - tol && d <= f.d1 + tol);
  const zoom = marked ? DETAIL_ZOOM : Math.max(map.getZoom(), 15.5);
  map.flyTo({ center: p, zoom, duration: 800 });
}

const TENDENCY_COLOR: Record<string, string> = { "eher niedrig": "#ef8a62", unauffällig: "#4d9221", "eher erhöht": "#4393c3", "eher hoch": "#2166ac" };

async function loadFlowInfo(a: Analysis, _id: number) {
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
    // Wetterabfrage eingefroren (Nutzer 26.11.2026): Hinweise nur aus Jahreszeit, Aufnahmedatum und Regime
    // Wetterabfrage eingefroren (Nutzer 26.11.2026): Hinweise nur aus Jahreszeit, Aufnahmedatum und Regime.
    // (Einzugsgebiet-Anzeige auf Nutzerwunsch 27.11.2026 entfernt – Regime grob aus Gletschern und Höhe oberhalb.)
    const [{ match: gauge0, errors: gaugeErrors }, iceKm2, maxElev] = await Promise.all([
      matchGauge(line, series, dates).catch((e) => ({ match: null, errors: [String(e)] })),
      glacierAreaAround(catchment.points, 8).catch(() => undefined),
      catchmentMaxElevation(line, catchment).catch(() => undefined),
    ]);
    // Pegel nur mit gemessenem Wert am selben Fluss – keine Schätzungen aus Nachbarpegeln
    const sameRiver = (r?: string) => !r || !catchment.river || catchment.fallback || norm(r) === norm(catchment.river) || norm(r).includes(norm(catchment.river)) || norm(catchment.river).includes(norm(r));
    const gauge = gauge0 && !gauge0.gauge.estimate && !(gauge0.unverified && !sameRiver(gauge0.gauge.river)) ? gauge0 : null;
    // Gletschereinfluss: Stammdaten des Pegels (Tirol: vergletscherter Anteil), sonst Gletscher im Gebiet
    const pct = gauge?.gauge.glacierPct ?? gauge?.others.find((o) => o.glacierPct !== undefined)?.glacierPct;
    const glacier: Glacier = pct !== undefined ? { pct } : { areaKm2: iceKm2 };
    // Fläche: Pegel-Stammdaten, sonst aus der Flusslänge geschätzt; Speicher/Ausleitungen oberhalb
    const regulated = [...catchment.reservoirs, ...(gauge?.gauge.note && /Kraftwerksausleitung|Restwasser/.test(gauge.gauge.note) ? ["Ausleitung"] : [])];
    const basin: Basin = { areaKm2: gauge?.gauge.areaKm2 ?? (catchment.fallback ? undefined : catchment.areaKm2), regulated };
    const regime = regimeOf(glacier, maxElev, p0[1]);
    info = { imagery, gauge, gaugeErrors, conditions: new Map([...dates, today].map((d) => [d, assess(d, p0, null, glacier, basin, regime.kind)])), today, glacier, regime, catchment, basin };
  } catch (e) {
    info = { imagery: [], gauge: null, gaugeErrors: [], conditions: new Map(), today: new Date().toISOString().slice(0, 10), error: (e as Error).message };
  }
  // auch für Abschnitte, die inzwischen nicht mehr angezeigt werden (Tour): Pegel und Flussname übernehmen
  const owner = current?.analysis === a ? current : trip.find((t) => t.cur?.analysis === a)?.cur;
  if (!owner) return;
  owner.flow = info;
  // Eigene Strecke: Flussname aus OpenStreetMap übernehmen (Titel, Dateiname beim Export)
  // (Flussname kommt aus loadTribs: Fluss, der am meisten entlang der Strecke liegt – das Einzugsgebiet
  // nennt an Mündungen oft den aufnehmenden Fluss)
  if (current !== owner) return;
  updateQOptions();
  showResults(); // neu einfärben (Wucht-Bewertung braucht den Abfluss)
  void updateImageDate(); // Kartenkopf: Tendenz zum Bilddatum
}

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
/** höchster Punkt im Einzugsgebiet oberhalb (verfolgte Flussläufe, sonst Umkreis) – grobes Höhenmodell genügt */
async function catchmentMaxElevation(line: LngLat[], c: Catchment): Promise<number | undefined> {
  const pts = [...c.lines.flat(), ...c.points, line[0]];
  if (!pts.length) return undefined;
  const step = Math.max(1, Math.floor(pts.length / 150));
  const sample = pts.filter((_, i) => i % step === 0);
  const z = await new ElevationSampler(compositeTileLoader("global"), 10).elevations(sample);
  const ok = z.filter((v) => Number.isFinite(v));
  // Flussläufe enden unterhalb der Gipfel: Talschluss + ~400 m als grober Gebietshöchstwert
  return ok.length ? Math.max(...ok) + 400 : undefined;
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
    if (!c) return `<span class="hint">keine Hinweise</span>`;
    return (
      `<span class="lvl" style="background:${TENDENCY_COLOR[c.tendency]}">${c.tendency}</span>` +
      `<ul class="wx">${c.hints.map((h) => `<li>${h.effect > 0 ? "▲" : h.effect < 0 ? "▼" : "•"} ${esc(h.text)}</li>`).join("")}` +
      `</ul>`
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
    : `<p class="hint">Kein offizieller Pegel mit Abfluss an dieser Strecke gefunden${!nveKey() && current.analysis.profile[0].p[1] > 57.8 && current.analysis.profile[0].p[0] < 31.5 && current.analysis.profile[0].p[0] > 4 ? " – für Norwegen bitte den kostenlosen NVE-Schlüssel unter „Analyse-Parameter“ eintragen" : ""}. Der Wasserstand lässt sich dann nur grob aus Jahreszeit und Regime einschätzen (Spalte „Hinweise“).</p>`;
  const links = (gm ? [] : officialGauges(current.analysis.profile[0].p))
    .map((g) => `<a href="${g.url}" target="_blank" rel="noopener">${g.label}</a>`)
    .join(" · ");
  el.innerHTML =
    (f.regime ? `<p class="regime"><b>Abflussregime:</b> ${esc(f.regime.text)}</p>` : "") +
    (f.imagery.length || gm
      ? `<div class="days">${rows}${today}</div>`
      : `<p class="hint">Keine Bilddaten verfügbar${f.error ? ` (${esc(f.error)})` : ""}.</p>`) +
    ratio +
    // kurz sichtbar: welcher Pegel (bzw. keiner) und Warnungen; alles Weitere eingeklappt
    `<p class="hint">${gm
      ? `Pegel: <a href="${gm.gauge.url}" target="_blank" rel="noopener">${esc(gm.gauge.name)}</a>${gm.others.length ? ` + ${gm.others.length} weitere` : ""}` +
        (gm.unverified ? ` · <span class="stale">Flusszuordnung ungeprüft</span>` : "") +
        (!gm.latest ? " · veröffentlicht keinen Abfluss" : "")
      : `Kein Pegel mit gemessenem Wert an diesem Fluss – Hinweise aus Jahreszeit, Aufnahmedatum und Regime${!nveKey() && current.analysis.profile[0].p[1] > 57.8 && current.analysis.profile[0].p[0] < 31.5 && current.analysis.profile[0].p[0] > 4 ? " (Norwegen: NVE-Schlüssel unter „Analyse-Parameter“ eintragen)" : ""}`}.</p>` +
    `<details class="more"${f.catchOpen ? " open" : ""}><summary>Pegel &amp; Quellen</summary>` +
    cal +
    `<p class="hint">Pegel: nur gemessene Werte offizieller Messstellen am selben Fluss (keine Schätzungen). ` +
    `Hinweise: übliche Jahreszeit der Region am Aufnahmetag und heute, dazu das Regime grob aus Gletschern und Höhe oberhalb (${catchText(f)}); eine Tendenz, keine Abflussmessung. ` +
    `${links ? ` Pegel vor Ort nachsehen: ${links}.` : ""}</p></details>`;
  el.querySelector("details.more")?.addEventListener("toggle", (e) => (f.catchOpen = (e.target as HTMLDetailsElement).open));
  // Abschnittskarten anklicken → Abschnitt auf der Karte zeigen
  el.querySelectorAll<HTMLElement>(".day[data-sec]").forEach((d) => d.addEventListener("click", () => focusImageStretch(Number(d.dataset.sec))));
  drawImageStretches();
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
  if (!c || c.fallback) return "Umkreis von ~15 km um den Einstieg, Fluss nicht weiter verfolgbar";
  const parts = [c.river, ...c.tributaries].filter(Boolean).join(", ");
  return `Einzugsgebiet oberhalb des Einstiegs: ${parts}`;
}

let imgMarkers: maplibregl.Marker[] = [];
function clearImgMarkers() {
  imgMarkers.forEach((m) => m.remove());
  imgMarkers = [];
}
/** Bildabschnitte: nur ein kleines Schild „B1 · Datum“ auf der Karte (keine eigene Linie mehr –
 *  die Ausdehnung zeigt die Leiste unter dem Höhenprofil, Klick dort springt zum Abschnitt). */
function drawImageStretches() {
  clearImgMarkers();
  const f = current?.flow;
  if (!current || !f) return;
  const prof = current.analysis.profile;
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
    ...(current.ww?.spots ?? []).flatMap((w, i) => (w.hazard || w.own ? [] : [{ d: w.dPeak, label: "Schwallstelle", go: () => focusWw(i) }])),
    ...ownOnRoute().flatMap((x) => (isHazardKind(x.l.kind) && x.at.offset <= OWN_HAZARD_OFF ? [] : [{ d: x.at.d, label: `Eigene Stelle · ${labelText(x.l)}`, go: () => { map.flyTo({ center: x.l.p, zoom: DETAIL_ZOOM, duration: 900 }); chart?.highlight(x.at.d); } }])),
    ...(current.osm?.places ?? []).map((o, i) => ({ d: o.d, label: `${osmPlaceText(o)} (OSM, nicht geprüft)`, go: () => focusOsm(i) })),
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
// automatische Schwallstellen-Erkennung ist experimentell: standardmäßig aus, Wahl bleibt in diesem Browser
const WWAUTO_KEY = "packraft.wwAuto";
try { $<HTMLInputElement>("opt-ww").checked = localStorage.getItem(WWAUTO_KEY) === "1"; } catch { /* privater Modus */ }
$("opt-ww").addEventListener("change", (e) => {
  try { localStorage.setItem(WWAUTO_KEY, (e.target as HTMLInputElement).checked ? "1" : "0"); } catch { /* privater Modus */ }
});
["opt-seg", "opt-dem", "opt-res", "opt-conf", "opt-narrows", "opt-width", "opt-ww", "opt-osmplaces"].forEach((id) =>
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
    setMode(m === "route" ? "route-in" : "draw");
  }),
);
$("reset").addEventListener("click", () => {
  const own = wwLabels.filter((l) => l.show).length;
  if ((trip.length || own) && !confirm(`Karte komplett leeren?\n${trip.length} Abschnitt${trip.length === 1 ? "" : "e"} der Tour und ${own} eigene Stelle${own === 1 ? "" : "n"} werden gelöscht.\n(Rückgängig mit ↶ möglich.)`)) return;
  if (trip.length || own) pushUndo();
  wwLabels = wwLabels.filter((l) => !l.show); // nur reine Lern-Markierungen der (eingefrorenen) Erkennung bleiben
  wwHidden = [];
  saveLabels(wwLabels);
  saveHidden(wwHidden);
  labelPopup?.remove();
  resetAll(true);
  renderOwnMarkers();
  renderOwnList();
  setMode("idle");
});
$("undo").addEventListener("click", undo);
$("own-clear").addEventListener("click", () => {
  const n = wwLabels.filter((l) => l.show).length;
  if (!n) return setStatus("Keine eigenen Stellen gespeichert.");
  if (!confirm(`Alle ${n} eigenen Stellen löschen? (Rückgängig mit ↶ möglich.)`)) return;
  pushUndo();
  wwLabels = wwLabels.filter((l) => !l.show); // reine Lern-Markierungen der Erkennung bleiben
  afterLabelChange();
  setStatus(`${n} eigene Stellen gelöscht.`);
});
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
  const vr = waveVelocityRange(lambda);
  const f1 = (x: number) => x.toFixed(1).replace(".", ",");
  const vTxt = vr.max - vr.min < 0.15 ? f1(vr.max) : `${f1(vr.min)}–${f1(vr.max)}`;
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
    `→ Strömung ≈ <b>${vTxt} m/s</b> (${(vr.min * 3.6).toFixed(0)}${vr.max - vr.min < 0.15 ? "" : `–${(vr.max * 3.6).toFixed(0)}`} km/h, je nach Wassertiefe ${f1(WAVE_DEPTHS[0])}–${f1(WAVE_DEPTHS[1])} m)<br>` +
    (vr.shallowMatters ? `<span style="color:var(--muted)">Lange Wellen: bei flachem Wasser eher langsamer (unterer Wert).</span><br>` : "") +
    `Wellenhöhe höchstens ≈ ${(lambda / 7).toFixed(1).replace(".", ",")} m (steilere Wellen brechen)<br>` +
    `<span style="color:var(--muted)">Gilt für stehende Wellen, quer zu den Kämmen gemessen. ${img ? `Bild ${img}` : ""}${imgFlow ? ` · ${imgFlow}` : ""}</span>`;
  new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(pts[pts.length - 1]).setHTML(html).addTo(map);
  setStatus(`Wellen: Ø ${f1(lambda)} m Abstand → ca. ${vTxt} m/s Strömung (je nach Tiefe).`);
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
  pushUndo();
  setMode("idle");
  drawPts = [];
  src("draft").setData(empty);
  setRouteEdit(line, line.slice(1).map((p, i) => [line[i], p]), line.slice(1).map(() => false));
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
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (e.key === "Escape" && movingLabel) {
    movingLabel = null;
    map.getCanvas().style.cursor = mode === "idle" ? "" : "crosshair";
    setStatus("Verschieben abgebrochen.");
    return;
  }
  if (e.key === "Escape" && mode === "wave") {
    drawPts = [];
    src("draft").setData(empty);
    setMode("idle");
  } else if (e.key === "Escape" && (mode === "edit" || mode.startsWith("hike"))) {
    hikeA = null;
    setMode("idle");
    if (current) showResults();
  } else if (e.key === "Escape" && mode === "ww-label") {
    // Markieren: erst Fenster schließen, dann Modus beenden – Analyse bleibt
    if (labelPopup?.isOpen()) { labelPopup.remove(); labelPopup = null; }
    else setMode("idle");
  } else if (e.key === "Escape" && mode !== "idle" && !busy) {
    resetAll();
    setMode("idle");
  } else if (e.key === "Backspace" && (mode === "draw" || mode === "wave")) {
    drawPts.pop();
    updateDraft();
  }
});

map.on("click", async (e) => {
  if (busy) return;
  const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
  if (movingLabel) return moveLabelTo(movingLabel, p);
  switch (mode) {
    case "route-in":
      putIn = p;
      clearMarkers();
      endpointMarker(p, "Einstieg", "#2a9d8f");
      setMode("route-out");
      break;
    case "route-out": {
      if (!putIn) return setMode("route-in");
      pushUndo();
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
      setRouteEdit([sec.line[0], sec.line[sec.line.length - 1]], [sec.line], [true]);
      await runAnalysis(sec.line, "Eigene Strecke", sec.source, sec.note);
      break;
    }
    case "hike-a":
      hikeA = p;
      clearMarkers();
      endpointMarker(p, "A", "#e07a1f");
      setMode("hike-b");
      break;
    case "hike-b": {
      if (!hikeA) return setMode("hike-a");
      const from = hikeA;
      hikeA = null;
      setMode("idle");
      endpointMarker(p, "B", "#e07a1f");
      await runHike(from, p);
      break;
    }
    case "edit":
      if (Date.now() - lastDragEnd < 400) break;
      insertAnchor(p);
      break;
    case "ww-label":
      // Klick neben ein offenes Auswahlfenster schließt es nur (nicht direkt nach dem Ziehen eines Symbols)
      if (Date.now() - lastDragEnd < 400) break;
      if (labelPopup?.isOpen()) { labelPopup.remove(); labelPopup = null; break; }
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

// Höhenprofil einklappen (mehr Platz für die Karte), Wahl bleibt im Browser
const PROFILE_KEY = "packraft.profileCollapsed";
function setProfileCollapsed(c: boolean) {
  $("profile-wrap").classList.toggle("collapsed", c);
  $("profile-toggle").textContent = c ? "▴ Höhenprofil" : "▾ Profil";
  $("profile-toggle").setAttribute("aria-expanded", String(!c));
  try { localStorage.setItem(PROFILE_KEY, c ? "1" : "0"); } catch { /* privater Modus */ }
  map.resize();
  if (!c) requestAnimationFrame(drawChart);
}
$("profile-toggle").addEventListener("click", () => setProfileCollapsed(!$("profile-wrap").classList.contains("collapsed")));
try { if (localStorage.getItem(PROFILE_KEY) === "1") setProfileCollapsed(true); } catch { /* privater Modus */ }

// beim Start: gespeicherte Tour wiederherstellen
if (map.loaded()) void restoreTrip();
else map.once("load", () => void restoreTrip());

$("load-preset").addEventListener("click", async () => {
  const pr = PRESETS.find((p) => p.id === presetSel.value);
  if (!pr) return;
  if (busy) return;
  pushUndo();
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
    setRouteEdit([sec.line[0], sec.line[sec.line.length - 1]], [sec.line], [true]);
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
const gpxOpts = () => ({
  steep: $<HTMLInputElement>("gpx-steep").checked,
  split: $<HTMLInputElement>("gpx-split").checked,
  kmMarks: $<HTMLInputElement>("gpx-km").checked,
});
// Export-Optionen merken (nur in diesem Browser)
for (const id of ["gpx-steep", "gpx-split", "gpx-km"]) {
  const box = $<HTMLInputElement>(id);
  try {
    const v = localStorage.getItem(`packraft.${id}`);
    if (v !== null) box.checked = v === "1";
  } catch { /* ohne Speicher: Standard */ }
  box.addEventListener("change", () => { try { localStorage.setItem(`packraft.${id}`, box.checked ? "1" : "0"); } catch { /* egal */ } });
}
const gpxText = () => (current ? toGpx(current.analysis, current.name, current.narrows, current.ww?.spots.filter((s) => !s.own), hazards(), gpxOpts(), exportPlaces()) : "");
$("exp-gpx").addEventListener("click", () => current && download(`${fileBase()}.gpx`, gpxText(), "application/gpx+xml"));
// Teilen-Menü (Handy, teils Desktop): an GPS-Apps (Gaia GPS, Garmin Explore …), Messenger oder Mail;
// ohne Teilen-Funktion wird die Datei heruntergeladen.
$("exp-share").hidden = false;
$("exp-share").addEventListener("click", async () => {
  if (!current) return;
  try {
    const ok = await shareFile(`${fileBase()}.gpx`, gpxText(), "application/gpx+xml", current.name);
    if (!ok) {
      download(`${fileBase()}.gpx`, gpxText(), "application/gpx+xml");
      setStatus("Teilen wird in diesem Browser nicht unterstützt – GPX wurde heruntergeladen (in der GPS-App über „Importieren“ öffnen).");
    }
  } catch (e) {
    setStatus(`Teilen fehlgeschlagen: ${(e as Error).message}`, true);
  }
});
$("exp-csv").addEventListener("click", () => current && download(`${fileBase()}.csv`, toCsv(current.analysis), "text/csv"));
$("exp-geojson").addEventListener("click", () => current && download(`${fileBase()}.geojson`, toGeoJson(current.analysis, current.name, current.narrows, current.ww?.spots.filter((s) => !s.own), hazards(), exportPlaces()), "application/geo+json"));
