// Abfluss (m³/s) aus dem globalen Hochwassermodell GloFAS (Copernicus), abgefragt über die
// freie Open-Meteo Flood API: Tageswerte seit 1984 plus Vorhersage, Raster ~5 km.
// Damit lässt sich einordnen, bei welchem Wasserstand ein Luftbild aufgenommen wurde und wie
// der Fluss heute im Vergleich dazu läuft. Modellwerte – für kleine Flüsse nur grob.

import type { LngLat } from "./geo";

const API = "https://flood-api.open-meteo.com/v1/flood";

export interface DischargeCell {
  lat: number;
  lon: number;
  /** Mittel der letzten 30 Tage, zur Auswahl der Flusszelle */
  recentMean: number;
}

export interface DischargeSeries {
  cell: DischargeCell;
  time: string[];
  q: (number | null)[];
}

export interface FlowState {
  date: string;
  q: number;
  /** Anteil der Tage (gesamt), an denen weniger Wasser floss (0–100) */
  percentile: number;
  /** wie percentile, aber nur Tage ±15 Tage um dasselbe Kalenderdatum */
  seasonalPercentile: number;
  label: string;
}

/**
 * Flusszelle wählen: Stichproben im mittleren Teil der Strecke; es gewinnt
 * die Zelle mit dem größten mittleren Abfluss der letzten 30 Tage.
 */
export async function riverCell(line: LngLat[], fetchFn: typeof fetch = fetch): Promise<DischargeCell | null> {
  const n = line.length;
  const pts: LngLat[] = [];
  // mittlerer Teil der Strecke (15–75 %): am Anfang können Seitenbäche, am Ende ein
  // größerer Fluss an der Mündung in der Nachbarzelle liegen
  const from = Math.floor(n * 0.15), upto = Math.max(from + 1, Math.floor(n * 0.75));
  const step = Math.max(1, Math.floor((upto - from) / 12));
  for (let i = from; i < upto; i += step) pts.push(line[i]);
  let best = await bestCell(pts, fetchFn);
  // Auffällig wenig Wasser (z. B. Isar: 0,7 statt ~50 m³/s): Die nächsten Rasterzellen liegen am
  // Hang. Dann auch die Nachbarzellen (±1 Zelle ≈ 5 km) um die Streckenmitte prüfen.
  if (!best || best.recentMean < 5) {
    const mid = line[Math.floor(n / 2)];
    const ring: LngLat[] = [];
    for (const dy of [-0.05, 0, 0.05]) for (const dx of [-0.05, 0, 0.05]) ring.push([mid[0] + dx, mid[1] + dy]);
    const alt = await bestCell(ring, fetchFn);
    if (alt && (!best || alt.recentMean > best.recentMean)) best = alt;
  }
  return best;
}

async function bestCell(pts: LngLat[], fetchFn: typeof fetch): Promise<DischargeCell | null> {
  const lat = pts.map((p) => p[1].toFixed(4)).join(",");
  const lon = pts.map((p) => p[0].toFixed(4)).join(",");
  const res = await fetchFn(`${API}?latitude=${lat}&longitude=${lon}&daily=river_discharge&past_days=30&forecast_days=1`);
  if (!res.ok) throw new Error(`Abflussdaten HTTP ${res.status}`);
  const json = await res.json();
  const list = (Array.isArray(json) ? json : [json]) as { latitude: number; longitude: number; daily: { river_discharge: (number | null)[] } }[];
  let best: DischargeCell | null = null;
  for (const x of list) {
    const v = x.daily.river_discharge.filter((q): q is number => q !== null);
    if (!v.length) continue;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    if (!best || m > best.recentMean) best = { lat: x.latitude, lon: x.longitude, recentMean: m };
  }
  return best;
}

/** Mittlerer Abfluss in den Sommermonaten Juni–August (Paddelsaison im Norden, Gletscherschmelze). */
export function summerMean(series: DischargeSeries): number {
  const v = series.q.filter((q, i): q is number => q !== null && /-0[678]-/.test(series.time[i]));
  return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
}

const cache = new Map<string, Promise<DischargeSeries>>();

/** Komplette Tagesreihe seit 1984 bis heute (+ 7 Tage Vorhersage) für eine Zelle. */
export function seriesFor(cell: DischargeCell, fetchFn: typeof fetch = fetch): Promise<DischargeSeries> {
  const key = `${cell.lat},${cell.lon}`;
  let p = cache.get(key);
  if (!p) {
    const end = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    p = fetchFn(`${API}?latitude=${cell.lat}&longitude=${cell.lon}&daily=river_discharge&start_date=1984-01-01&end_date=${end}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Abflussdaten HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { daily: { time: string[]; river_discharge: (number | null)[] } }) => ({ cell, time: d.daily.time, q: d.daily.river_discharge }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

const doy = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);
};

export function classify(percentile: number): string {
  if (percentile < 10) return "sehr niedrig";
  if (percentile < 33) return "niedrig";
  if (percentile < 66) return "mittel";
  if (percentile < 90) return "hoch";
  return "sehr hoch";
}

/** Wasserstand an einem Tag einordnen (null, wenn kein Wert vorliegt). */
export function flowOn(series: DischargeSeries, date: string): FlowState | null {
  const i = series.time.indexOf(date);
  const q = i >= 0 ? series.q[i] : null;
  if (q === null || q === undefined) return null;
  const today = new Date().toISOString().slice(0, 10);
  const past = series.time.map((t, k) => [t, series.q[k]] as const).filter(([t, v]) => v !== null && t <= today) as [string, number][];
  const below = (vals: number[]) => (vals.filter((v) => v < q).length / Math.max(1, vals.length)) * 100;
  const target = doy(date);
  const seasonal = past.filter(([t]) => {
    const dd = Math.abs(doy(t) - target);
    return Math.min(dd, 365 - dd) <= 15;
  });
  const percentile = below(past.map(([, v]) => v));
  const seasonalPercentile = below(seasonal.map(([, v]) => v));
  return { date, q, percentile, seasonalPercentile, label: classify(seasonalPercentile) };
}

/** Mittlerer Abfluss (MQ) über alle vergangenen Tage. */
export function meanFlow(series: DischargeSeries): number {
  const today = new Date().toISOString().slice(0, 10);
  const v = series.q.filter((q, k): q is number => q !== null && series.time[k] <= today);
  return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
}

/** Letzter verfügbarer Wert bis heute. */
export function latestDate(series: DischargeSeries): string | null {
  const today = new Date().toISOString().slice(0, 10);
  for (let k = series.time.length - 1; k >= 0; k--) if (series.time[k] <= today && series.q[k] !== null) return series.time[k];
  return null;
}

/** Links zu offiziellen Pegeln (gemessene Werte) je Land. */
export function officialGauges(p: LngLat): { label: string; url: string }[] {
  const [lon, lat] = p;
  if (lat > 63 && lat < 67 && lon > -25 && lon < -13) return [{ label: "Veðurstofa Íslands (Pegel Island)", url: "https://en.vedur.is/hydrology/stations/" }];
  if (lat > 55 && lon > 4 && lon < 31.6)
    return [
      { label: "NVE Sildre (Norwegen)", url: "https://sildre.nve.no/" },
      { label: "SMHI Vattenwebb (Schweden)", url: "https://vattenwebb.smhi.se/" },
      { label: "SYKE (Finnland)", url: "https://wwwi2.ymparisto.fi/i2/index_en.html" },
    ];
  if (lat > 45.4 && lat < 46.9 && lon > 13.3 && lon < 16.6) return [{ label: "ARSO Pegel (Slowenien)", url: "https://www.arso.gov.si/vode/podatki/" }];
  // Schweiz und Österreich überlappen im Rechteck (Graubünden ↔ Vorarlberg/Tirol): beide Links zeigen
  const out: { label: string; url: string }[] = [];
  const at = lat > 46.3 && lat < 49.1 && lon > 9.5 && lon < 17.2;
  const ch = lat > 45.8 && lat < 47.9 && lon > 5.9 && lon < 10.5;
  if (at && lon > 10.0 && lon < 12.97 && lat > 46.6 && lat < 47.75) out.push({ label: "Hydrographischer Dienst Tirol", url: "https://hydro.tirol.gv.at/" });
  if (at) out.push({ label: "eHYD (Österreich)", url: "https://ehyd.gv.at/" });
  if (ch) out.push({ label: "BAFU Hydrodaten (Schweiz)", url: "https://www.hydrodaten.admin.ch/" });
  if (lat > 46.2 && lat < 47.1 && lon > 10.38 && lon < 12.48) out.push({ label: "Hydrographisches Amt Südtirol", url: "https://weather.province.bz.it/en/gauging-stations/" });
  if (lat > 47.25 && lat < 50.6 && lon > 8.95 && lon < 13.9) out.push({ label: "GKD Bayern", url: "https://www.gkd.bayern.de/de/fluesse/abfluss" });
  if (lat > 41.3 && lat < 51.1 && lon > -5.2 && lon < 7.7 && !ch) out.push({ label: "Hydroportail (Frankreich)", url: "https://www.hydro.eaufrance.fr/" });
  return out;
}
