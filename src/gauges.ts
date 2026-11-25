// Gemessene Abflüsse von offiziellen Pegeln (geeichte Messstellen der Behörden).
// Je Anbieter: Stationsliste mit Koordinaten, aktueller Wert und – wo angeboten – Tageswerte
// der Vergangenheit (z. B. für den Aufnahmetag eines Luftbilds).
//
//   Anbieter     Land        Schlüssel  aktuell  Historie            Abruf aus dem Browser
//   SMHI         Schweden    nein       ja       ab ~1900 bis gestern  ja (CORS)
//   SYKE         Finnland    nein       ja       Jahrzehnte           ja
//   NVE HydAPI   Norwegen    ja (kostenlos, persönlich)  ja  Jahrzehnte  ja
//   PEGELONLINE  Deutschland nein       ja       31 Tage              ja (nur Bundeswasserstraßen)
//   BAFU         Schweiz     nein       ja       –                    ja (über api.existenz.ch)
//   ARSO         Slowenien   nein       ja       –                    ja
//   HD Tirol     Österreich  nein       ja       –                    über Spiegel (GitHub Action,
//                (Tirol)                                              alle 30 min, Branch "pegeldaten")
//
// RiverApp, Rivermap & Co. beziehen ihre Daten ebenfalls von diesen Behörden; eine offene
// Schnittstelle bieten sie nicht an.

import type { LngLat } from "./geo";

export type Provider = "SMHI" | "SYKE" | "NVE" | "PEGELONLINE" | "BAFU" | "ARSO" | "TIROL";

export interface Gauge {
  provider: Provider;
  id: string;
  name: string;
  river?: string;
  lon: number;
  lat: number;
  /** Seite des Anbieters zum Nachsehen */
  url: string;
  /** zusätzliche Angaben des Anbieters (z. B. Hochwasserstufen bei ARSO) */
  note?: string;
}

export interface Reading {
  time: string;
  q: number;
}

interface ProviderImpl {
  /** Gebiet [W, S, O, N], in dem der Anbieter Pegel hat */
  bbox: [number, number, number, number];
  stations(fetchFn: typeof fetch): Promise<Gauge[]>;
  latest(g: Gauge, fetchFn: typeof fetch): Promise<Reading | null>;
  /** Tagesmittel (YYYY-MM-DD → m³/s) im Zeitraum; leer, wenn der Anbieter keine Historie hat */
  daily(g: Gauge, from: string, to: string, fetchFn: typeof fetch): Promise<Map<string, number>>;
}

// ---------------------------------------------------------------------------
// NVE-Schlüssel: persönlich und kostenlos (https://hydapi.nve.no/Users). Er bleibt im Browser.
const NVE_KEY_STORE = "packraft.nveKey";
export function nveKey(): string {
  try {
    return localStorage.getItem(NVE_KEY_STORE) ?? "";
  } catch {
    return "";
  }
}
export function setNveKey(k: string) {
  try {
    if (k) localStorage.setItem(NVE_KEY_STORE, k.trim());
    else localStorage.removeItem(NVE_KEY_STORE);
  } catch {
    /* privates Fenster o. ä. */
  }
}

/** „LISJÖBÄCKEN ÖVRE“ → „Lisjöbäcken Övre“ (Unicode-sicher) */
export const titleCase = (t: string) =>
  t.toLowerCase().split(/([\s-]+)/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

const json = async (r: Response) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const dayOf = (iso: string) => iso.slice(0, 10);

// ---------------------------------------------------------------------------
const SMHI = "https://opendata-download-hydroobs.smhi.se/api/version/1.0/parameter/1";
const smhiCsv = new Map<string, Promise<string>>();
const smhi: ProviderImpl = {
  bbox: [10.5, 55.0, 24.5, 69.5],
  async stations(f) {
    const d = (await json(await f(`${SMHI}.json`))) as {
      station: { key: string; name: string; latitude: number; longitude: number; active: boolean; catchmentName?: string }[];
    };
    return d.station
      .filter((s) => s.active)
      .map((s) => ({
        provider: "SMHI" as const,
        id: s.key,
        name: titleCase(s.name),
        river: s.catchmentName ? s.catchmentName.charAt(0) + s.catchmentName.slice(1).toLowerCase() : undefined,
        lon: s.longitude,
        lat: s.latitude,
        url: `https://vattenwebb.smhi.se/station/?station=${s.key}`,
      }));
  },
  async latest(g, f) {
    const d = (await json(await f(`${SMHI}/station/${g.id}/period/latest-day/data.json`))) as { value?: { date: number; value: number }[] };
    const v = d.value?.at(-1);
    return v ? { time: new Date(v.date).toISOString(), q: v.value } : null;
  },
  async daily(g, from, to, f) {
    // Archiv als CSV (Tageswerte bis gestern; „O“ = noch ungeprüft) – einmal je Station laden
    let p = smhiCsv.get(g.id);
    if (!p) {
      p = f(`${SMHI}/station/${g.id}/period/corrected-archive/data.csv`).then((r) => r.text());
      p.catch(() => smhiCsv.delete(g.id));
      smhiCsv.set(g.id, p);
    }
    const text = await p;
    const out = new Map<string, number>();
    for (const line of text.split("\n")) {
      const m = /^(\d{4}-\d{2}-\d{2});([\d.]+);/.exec(line);
      if (m && m[1] >= from && m[1] <= to) out.set(m[1], Number(m[2]));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
const SYKE = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata";
/** SYKE-Koordinaten „622536“ = 62°25′36″ */
const dms = (s: string) => {
  const t = s.padStart(6, "0");
  return Number(t.slice(0, t.length - 4)) + Number(t.slice(-4, -2)) / 60 + Number(t.slice(-2)) / 3600;
};
const syke: ProviderImpl = {
  bbox: [19.0, 59.5, 31.6, 70.1],
  async stations(f) {
    const out: Gauge[] = [];
    let url: string | undefined = `${SYKE}/Paikka?$filter=Suure_Id eq 2 and Tila_Id eq 1&$select=Paikka_Id,Nimi,KoordLat,KoordLong,PaaVesalNimi`;
    for (let guard = 0; url && guard < 20; guard++) {
      const d = (await json(await f(url))) as {
        value: { Paikka_Id: number; Nimi: string; KoordLat: string; KoordLong: string; PaaVesalNimi?: string }[];
        "odata.nextLink"?: string;
      };
      for (const s of d.value)
        if (s.KoordLat && s.KoordLong)
          out.push({
            provider: "SYKE",
            id: String(s.Paikka_Id),
            name: s.Nimi.trim(),
            river: s.PaaVesalNimi,
            lat: dms(s.KoordLat),
            lon: dms(s.KoordLong),
            url: "https://wwwi2.ymparisto.fi/i2/index_en.html",
          });
      url = d["odata.nextLink"];
    }
    return out;
  },
  async latest(g, f) {
    const d = (await json(await f(`${SYKE}/Virtaama?$filter=Paikka_Id eq ${g.id}&$orderby=Aika desc&$top=1`))) as { value: { Aika: string; Arvo: string }[] };
    const v = d.value[0];
    return v ? { time: v.Aika, q: Number(v.Arvo) } : null;
  },
  async daily(g, from, to, f) {
    const out = new Map<string, number>();
    let url: string | undefined = `${SYKE}/Virtaama?$filter=Paikka_Id eq ${g.id} and Aika ge datetime'${from}T00:00:00' and Aika le datetime'${to}T23:59:59'&$orderby=Aika`;
    for (let guard = 0; url && guard < 20; guard++) {
      const d = (await json(await f(url))) as { value: { Aika: string; Arvo: string }[]; "odata.nextLink"?: string };
      for (const v of d.value) out.set(dayOf(v.Aika), Number(v.Arvo));
      url = d["odata.nextLink"];
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
const NVE = "https://hydapi.nve.no/api/v1";
const nveFetch = (f: typeof fetch, url: string) => f(url, { headers: { "X-API-Key": nveKey(), Accept: "application/json" } });
const nve: ProviderImpl = {
  bbox: [4.0, 57.8, 31.5, 71.4],
  async stations(f) {
    if (!nveKey()) return [];
    const d = (await json(await nveFetch(f, `${NVE}/Stations?Active=1`))) as {
      data: { stationId: string; stationName: string; riverName?: string; latitude: number; longitude: number; seriesList?: { parameter: number }[] }[];
    };
    return d.data
      .filter((s) => s.seriesList?.some((x) => x.parameter === 1001))
      .map((s) => ({
        provider: "NVE" as const,
        id: s.stationId,
        name: s.stationName,
        river: s.riverName,
        lat: s.latitude,
        lon: s.longitude,
        url: `https://sildre.nve.no/station/${s.stationId}`,
      }));
  },
  async latest(g, f) {
    const d = (await json(await nveFetch(f, `${NVE}/Observations?StationId=${g.id}&Parameter=1001&ResolutionTime=0`))) as {
      data: { observations: { time: string; value: number | null }[] }[];
    };
    const v = d.data[0]?.observations.filter((o) => o.value !== null).at(-1);
    return v ? { time: v.time, q: v.value! } : null;
  },
  async daily(g, from, to, f) {
    const d = (await json(
      await nveFetch(f, `${NVE}/Observations?StationId=${g.id}&Parameter=1001&ResolutionTime=1440&ReferenceTime=${from}/${to}T23:59:59`),
    )) as { data: { observations: { time: string; value: number | null }[] }[] };
    const out = new Map<string, number>();
    for (const o of d.data[0]?.observations ?? []) if (o.value !== null) out.set(dayOf(o.time), o.value);
    return out;
  },
};

// ---------------------------------------------------------------------------
const PO = "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations";
const pegelonline: ProviderImpl = {
  bbox: [5.8, 47.2, 15.1, 55.1],
  async stations(f) {
    const d = (await json(await f(`${PO}.json?includeTimeseries=true`))) as {
      uuid: string; shortname: string; latitude?: number; longitude?: number; water: { longname: string }; timeseries?: { shortname: string }[];
    }[];
    return d
      .filter((s) => s.latitude && s.longitude && s.timeseries?.some((t) => t.shortname === "Q"))
      .map((s) => ({
        provider: "PEGELONLINE" as const,
        id: s.uuid,
        name: s.shortname,
        river: s.water.longname.charAt(0) + s.water.longname.slice(1).toLowerCase(),
        lat: s.latitude!,
        lon: s.longitude!,
        url: `https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=${s.uuid}`,
      }));
  },
  async latest(g, f) {
    const d = (await json(await f(`${PO}/${g.id}/Q/currentmeasurement.json`))) as { timestamp: string; value: number };
    return { time: d.timestamp, q: d.value };
  },
  async daily(g, from, to, f) {
    const m = (await json(await f(`${PO}/${g.id}/Q/measurements.json?start=P31D`))) as { timestamp: string; value: number }[];
    const acc = new Map<string, number[]>();
    for (const x of m) {
      const d = dayOf(x.timestamp);
      if (d >= from && d <= to) (acc.get(d) ?? acc.set(d, []).get(d)!).push(x.value);
    }
    return new Map([...acc].filter(([, v]) => v.length >= 12).map(([d, v]) => [d, v.reduce((a, b) => a + b, 0) / v.length]));
  },
};

// ---------------------------------------------------------------------------
const EXISTENZ = "https://api.existenz.ch/apiv1/hydro";
const bafu: ProviderImpl = {
  bbox: [5.9, 45.8, 10.5, 47.9],
  async stations(f) {
    const d = (await json(await f(`${EXISTENZ}/locations`))) as {
      payload: Record<string, { details: { id: string; name: string; "water-body-name": string; "water-body-type": string; lat: number; lon: number } }>;
    };
    return Object.values(d.payload)
      .map((x) => x.details)
      .filter((x) => x["water-body-type"] === "river")
      .map((x) => ({
        provider: "BAFU" as const,
        id: x.id,
        name: x.name,
        river: x["water-body-name"],
        lat: x.lat,
        lon: x.lon,
        url: `https://www.hydrodaten.admin.ch/de/seen-und-fluesse/stationen-und-daten/${x.id}`,
      }));
  },
  async latest(g, f) {
    const d = (await json(await f(`${EXISTENZ}/latest?locations=${g.id}&parameters=flow`))) as { payload: { timestamp: number; val: number }[] };
    const v = d.payload[0];
    return v ? { time: new Date(v.timestamp * 1000).toISOString(), q: v.val } : null;
  },
  async daily() {
    return new Map();
  },
};

// ---------------------------------------------------------------------------
const ARSO_XML = "https://www.arso.gov.si/xml/vode/hidro_podatki_zadnji.xml";
let arsoDoc: Promise<Document | null> | null = null;
function arsoXml(f: typeof fetch) {
  if (!arsoDoc) {
    arsoDoc = f(ARSO_XML)
      .then((r) => r.text())
      .then((t) => (typeof DOMParser !== "undefined" ? new DOMParser().parseFromString(t, "application/xml") : null));
    arsoDoc.catch(() => (arsoDoc = null));
  }
  return arsoDoc;
}
const arso: ProviderImpl = {
  bbox: [13.3, 45.4, 16.7, 46.9],
  async stations(f) {
    const doc = await arsoXml(f);
    if (!doc) return [];
    return [...doc.querySelectorAll("postaja")]
      .filter((p) => p.querySelector("pretok")?.textContent)
      .map((p) => {
        const t = (sel: string) => p.querySelector(sel)?.textContent?.trim() ?? "";
        const vv = t("prvi_vv_pretok");
        return {
          provider: "ARSO" as const,
          id: p.getAttribute("sifra") ?? "",
          name: t("merilno_mesto"),
          river: t("reka"),
          lat: Number(p.getAttribute("wgs84_sirina")),
          lon: Number(p.getAttribute("wgs84_dolzina")),
          url: "https://www.arso.gov.si/vode/podatki/",
          note: [t("pretok_znacilni"), vv ? `1. Hochwasserstufe ab ${vv} m³/s` : ""].filter(Boolean).join(" · "),
        };
      });
  },
  async latest(g, f) {
    const doc = await arsoXml(f);
    const p = doc ? [...doc.querySelectorAll("postaja")].find((x) => x.getAttribute("sifra") === g.id) : null;
    const q = p?.querySelector("pretok")?.textContent;
    return p && q ? { time: (p.querySelector("datum")?.textContent ?? "").replace(" ", "T"), q: Number(q) } : null;
  },
  async daily() {
    return new Map();
  },
};

// ---------------------------------------------------------------------------
// Hydrographischer Dienst Tirol: hydro.tirol.gv.at sendet keinen CORS-Header. Eine GitHub Action
// (.github/workflows/pegel-tirol.yml) spiegelt die Abflusspegel alle 30 min nach
// raw.githubusercontent.com, das jeder Browser abrufen darf. Manche Pegel (z. B. Inn bei Imst)
// veröffentlichen nur eine Wasserstandsklasse, keinen Abfluss.
export const TIROL_MIRROR = "https://raw.githubusercontent.com/zowallawilli/App-Design-/pegeldaten/tirol.json";
interface TirolStation {
  id: string; name: string; river: string | null; lat: number; lon: number;
  q: number | null; time: string | null; dayMean: number | null;
  nnq: number | null; nqt: number | null; hhq: number | null; level: string | null;
}
let tirolDoc: Promise<{ fetched: string; stations: TirolStation[] }> | null = null;
function tirolData(f: typeof fetch) {
  if (!tirolDoc) {
    tirolDoc = f(TIROL_MIRROR).then(json) as Promise<{ fetched: string; stations: TirolStation[] }>;
    tirolDoc.catch(() => (tirolDoc = null));
  }
  return tirolDoc;
}
const fmtNum = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace(".", ",");
const tirol: ProviderImpl = {
  bbox: [10.0, 46.6, 12.97, 47.75],
  async stations(f) {
    const d = await tirolData(f);
    return d.stations.map((s) => ({
      provider: "TIROL" as const,
      id: s.id,
      name: s.name,
      river: s.river ?? undefined,
      lat: s.lat,
      lon: s.lon,
      url: "https://hydro.tirol.gv.at/",
      note: [
        s.q === null ? "kein Abfluss veröffentlicht" : "",
        s.level && s.level !== "keine Klassifizierung" ? `Wasserstand ${s.level}` : "",
        s.nqt !== null ? `NQT ${fmtNum(s.nqt)} m³/s` : "",
        s.hhq !== null ? `HHQ ${fmtNum(s.hhq)} m³/s` : "",
      ].filter(Boolean).join(" · "),
    }));
  },
  async latest(g, f) {
    const s = (await tirolData(f)).stations.find((x) => x.id === g.id);
    return s && s.q !== null && s.time ? { time: s.time, q: s.q } : null;
  },
  async daily() {
    return new Map();
  },
};

const PROVIDERS: Record<Provider, ProviderImpl> = { SMHI: smhi, SYKE: syke, NVE: nve, PEGELONLINE: pegelonline, BAFU: bafu, ARSO: arso, TIROL: tirol };

const stationCache = new Map<Provider, Promise<Gauge[]>>();
function stationsOf(p: Provider, f: typeof fetch): Promise<Gauge[]> {
  let s = stationCache.get(p);
  if (!s) {
    s = PROVIDERS[p].stations(f);
    s.catch(() => stationCache.delete(p));
    stationCache.set(p, s);
  }
  return s;
}
/** NVE-Stationen nach Eingabe eines neuen Schlüssels neu laden */
export function resetGaugeCache() {
  stationCache.clear();
  tirolDoc = null;
  arsoDoc = null;
}

const distKm = (a: LngLat, b: LngLat) => {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * k);
  return Math.hypot(x, b[1] - a[1]) * 111.2;
};

export interface NearGauge extends Gauge {
  /** Abstand zur Flusslinie (km) */
  distanceKm: number;
}

/**
 * Pegel an der Strecke: Stationen höchstens `maxKm` von der Flusslinie entfernt (Pegel stehen
 * am Fluss – größere Abstände bedeuten meist einen anderen Fluss), nächste zuerst.
 */
export async function gaugesAlong(line: LngLat[], maxKm = 2, fetchFn: typeof fetch = fetch): Promise<{ gauges: NearGauge[]; errors: string[] }> {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of line) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const pts = line.filter((_, i) => i % 4 === 0 || i === line.length - 1);
  const errors: string[] = [];
  const found: NearGauge[] = [];
  await Promise.all(
    (Object.keys(PROVIDERS) as Provider[])
      .filter((p) => {
        const b = PROVIDERS[p].bbox;
        return e >= b[0] && w <= b[2] && n >= b[1] && s <= b[3];
      })
      .map(async (p) => {
        try {
          for (const g of await stationsOf(p, fetchFn)) {
            const d = Math.min(...pts.map((q) => distKm([g.lon, g.lat], q)));
            if (d <= maxKm) found.push({ ...g, distanceKm: d });
          }
        } catch (err) {
          errors.push(`${p}: ${(err as Error).message}`);
        }
      }),
  );
  found.sort((a, b) => a.distanceKm - b.distanceKm);
  return { gauges: found, errors };
}

export function latestReading(g: Gauge, fetchFn: typeof fetch = fetch): Promise<Reading | null> {
  return PROVIDERS[g.provider].latest(g, fetchFn);
}

export function dailyValues(g: Gauge, from: string, to: string, fetchFn: typeof fetch = fetch): Promise<Map<string, number>> {
  return PROVIDERS[g.provider].daily(g, from, to, fetchFn);
}

/** Hat der Anbieter Tageswerte der Vergangenheit (für den Aufnahmetag eines Luftbilds)? */
export const hasHistory = (p: Provider) => p === "SMHI" || p === "SYKE" || p === "NVE";

// ---------------------------------------------------------------------------
// Passenden Pegel wählen und das Modell daran eichen

export interface GaugeMatch {
  gauge: NearGauge;
  latest: Reading | null;
  /** gemessen ÷ Modell (letzte 45 Tage); null, wenn nicht bestimmbar */
  factor: number | null;
  correlation: number | null;
  /** gemessene Tageswerte an gewünschten Tagen (z. B. Aufnahmetage) */
  onDates: Map<string, number>;
  /** weitere Pegel an der Strecke (zur Auswahl/Info) */
  others: NearGauge[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Pegel an der Strecke suchen und den zum Fluss passenden wählen: Bei mehreren Kandidaten
 * gewinnt der, dessen Tagesverlauf am besten zum Modellabfluss passt (gleicher Fluss);
 * Seitenbäche mit ganz anderer Wassermenge werden verworfen.
 */
export async function matchGauge(
  line: LngLat[],
  model: { time: string[]; q: (number | null)[] } | null,
  dates: string[],
  fetchFn: typeof fetch = fetch,
): Promise<{ match: GaugeMatch | null; errors: string[] }> {
  const { gauges, errors } = await gaugesAlong(line, 1.5, fetchFn);
  if (!gauges.length) return { match: null, errors };
  const to = iso(new Date(Date.now() - 864e5));
  const from = iso(new Date(Date.now() - 45 * 864e5));
  const modelAt = (d: string) => {
    if (!model) return null;
    const i = model.time.indexOf(d);
    return i >= 0 ? model.q[i] : null;
  };
  type Cand = { g: NearGauge; r: number | null; factor: number | null; latest: Reading | null; score: number };
  const cands: Cand[] = [];
  for (const g of gauges.slice(0, 4)) {
    try {
      const [latest, recent] = await Promise.all([latestReading(g, fetchFn).catch(() => null), dailyValues(g, from, to, fetchFn).catch(() => new Map<string, number>())]);
      const pairs: [number, number][] = [];
      for (const [d, q] of recent) {
        const m = modelAt(d);
        if (m !== null && m > 0) pairs.push([q, m]);
      }
      let r: number | null = null, factor: number | null = null;
      if (pairs.length >= 10) {
        const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
        let sxy = 0, sxx = 0, syy = 0;
        for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
        r = sxy / Math.sqrt(sxx * syy || 1);
        factor = mx / my;
      } else if (latest && model) {
        // ohne Historie: nur Größenordnung mit dem heutigen Modellwert vergleichen
        const m = modelAt(latest.time.slice(0, 10)) ?? modelAt(to);
        if (m && m > 0) factor = latest.q / m;
      }
      // Pegel direkt auf der Linie (< 300 m) gilt immer – das Modell kann für kleine Flüsse um
      // ein Vielfaches danebenliegen (Oulankajoki: Modell 1–7 m³/s, gemessen 16–20 m³/s)
      const plausible = g.distanceKm < 0.3 || factor === null || (factor > 0.2 && factor < 5);
      // Pegel ohne aktuellen Wert und ohne Historie (nur Wasserstandsklasse) nur notfalls wählen
      const empty = !latest && !recent.size ? 2 : 0;
      const score = (plausible ? 0 : 10) + empty + (r === null ? 1 : 1 - r) + g.distanceKm / 5;
      cands.push({ g, r, factor: plausible ? factor : null, latest, score });
    } catch (e) {
      errors.push(`${g.provider} ${g.name}: ${(e as Error).message}`);
    }
  }
  if (!cands.length) return { match: null, errors };
  cands.sort((a, b) => a.score - b.score);
  const best = cands[0];
  if (best.score >= 10 && model) return { match: null, errors: [...errors, `Pegel ${best.g.name} passt nicht zum Fluss (andere Wassermenge)`] };
  // gemessene Werte an den gewünschten Tagen (nur Anbieter mit Historie)
  const onDates = new Map<string, number>();
  if (hasHistory(best.g.provider))
    for (const d of [...new Set(dates)]) {
      const v = await dailyValues(best.g, d, d, fetchFn).catch(() => new Map<string, number>());
      const q = v.get(d);
      if (q !== undefined) onDates.set(d, q);
    }
  return {
    match: {
      gauge: best.g,
      latest: best.latest,
      factor: best.r === null || best.r >= 0.6 ? best.factor : null,
      correlation: best.r,
      onDates,
      others: gauges.filter((g) => g !== best.g).slice(0, 4),
    },
    errors,
  };
}
