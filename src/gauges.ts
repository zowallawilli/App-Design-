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
//   HD Tirol     Österreich  nein       ja       eigenes Archiv der   über Spiegel (GitHub Action,
//                (Tirol)                        Tagesmittel ab 11/2026 alle 30 min, Branch "pegeldaten")
//   Hub'Eau      Frankreich  nein       ja       Tagesmittel (QmnJ),  ja
//                                                Jahrzehnte
//   Südtirol     Italien     nein       ja       10-min-Werte, Jahre  ja
//                (Prov. Bozen)
//
// RiverApp, Rivermap & Co. beziehen ihre Daten ebenfalls von diesen Behörden; eine offene
// Schnittstelle bieten sie nicht an.

import type { LngLat } from "./geo";
import { applyEstimate, estimateFromNeighbours, type Estimate } from "./estimate";

export type Provider = "SMHI" | "SYKE" | "NVE" | "PEGELONLINE" | "BAFU" | "ARSO" | "TIROL" | "HUBEAU" | "BZ";

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
  /** Abfluss nicht gemessen, sondern aus Nachbarpegeln geschätzt */
  estimate?: Estimate;
  /** Wasserstand (cm) – vor allem für Pegel ohne veröffentlichten Abfluss */
  levelCm?: { cm: number; time: string };
  /** vergletscherter Anteil des Einzugsgebiets (%) laut Pegel-Stammdaten */
  glacierPct?: number;
  /** Einzugsgebiet (km²) laut Pegel-Stammdaten */
  areaKm2?: number;
  /** virtueller Pegel: gewichtete Summe dieser Pegel (Gewichte in estimate.terms) */
  parts?: Gauge[];
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
      .filter((p) => p.querySelector("pretok")?.textContent || p.querySelector("vodostaj")?.textContent)
      .map((p) => {
        const t = (sel: string) => p.querySelector(sel)?.textContent?.trim() ?? "";
        const vv = t("prvi_vv_pretok");
        const cm = Number(t("vodostaj"));
        return {
          provider: "ARSO" as const,
          id: p.getAttribute("sifra") ?? "",
          name: t("merilno_mesto"),
          river: t("reka"),
          lat: Number(p.getAttribute("wgs84_sirina")),
          lon: Number(p.getAttribute("wgs84_dolzina")),
          url: "https://www.arso.gov.si/vode/podatki/",
          note: [t("pretok") ? "" : "kein Abfluss veröffentlicht", t("pretok_znacilni"), vv ? `1. Hochwasserstufe ab ${vv} m³/s` : ""].filter(Boolean).join(" · "),
          levelCm: t("vodostaj") && cm > 0 ? { cm, time: t("datum").replace(" ", "T") } : undefined,
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
// raw.githubusercontent.com, das jeder Browser abrufen darf, und legt dort auch ein Archiv der
// Tagesmittel an (tirol-archiv/<id>.json, seit 11/2026). Manche Pegel (z. B. Inn bei Imst)
// veröffentlichen nur eine Wasserstandsklasse – dort wird der Abfluss aus Nachbarpegeln geschätzt.
const MIRROR_BASE = "https://raw.githubusercontent.com/zowallawilli/App-Design-/pegeldaten";
export const TIROL_MIRROR = `${MIRROR_BASE}/tirol.json`;
/** erster Tag im Tiroler Archiv (Beginn der Aufzeichnung durch die Action) */
export const TIROL_ARCHIVE_START = "2026-11-24";
export const tirolArchiveUrl = (id: string) => `${MIRROR_BASE}/tirol-archiv/${id}.json`;
interface TirolStation {
  id: string; name: string; river: string | null; lat: number; lon: number;
  area?: number | null; km?: number | null; alt?: number | null;
  glacier?: number | null; w?: number | null; wTime?: string | null;
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
/** Archiv eines Pegels: Tag → Tagesmittel (offiziell, sonst aus ≥ 24 Halbstunden-Abrufen) */
const tirolArchive = new Map<string, Promise<Map<string, number>>>();
function tirolDaily(id: string, f: typeof fetch) {
  let p = tirolArchive.get(id);
  if (!p) {
    p = f(tirolArchiveUrl(id)).then(async (r) => {
      const out = new Map<string, number>();
      if (r.status === 404) return out; // (noch) kein Archiv
      const a = (await json(r)) as { dm?: Record<string, number | null>; s?: Record<string, [number, number]> };
      for (const [d, [m, n]] of Object.entries(a.s ?? {})) if (n >= 24) out.set(d, m);
      for (const [d, v] of Object.entries(a.dm ?? {})) if (typeof v === "number") out.set(d, v);
      return out;
    });
    p.catch(() => tirolArchive.delete(id));
    tirolArchive.set(id, p);
  }
  return p;
}
const fmtNum = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace(".", ",");
const tirolEstimate = (s: TirolStation, all: TirolStation[]) =>
  s.q === null ? estimateFromNeighbours({ ...s, area: s.area ?? null, km: s.km ?? null }, all.map((x) => ({ ...x, area: x.area ?? null, km: x.km ?? null }))) : null;
const tirol: ProviderImpl = {
  bbox: [10.0, 46.6, 12.97, 47.75],
  async stations(f) {
    const d = await tirolData(f);
    return d.stations.map((s) => {
      const est = tirolEstimate(s, d.stations);
      return {
        provider: "TIROL" as const,
        id: s.id,
        name: s.name,
        river: s.river ?? undefined,
        lat: s.lat,
        lon: s.lon,
        url: "https://hydro.tirol.gv.at/",
        levelCm: s.w !== null && s.w !== undefined && s.wTime ? { cm: s.w, time: s.wTime } : undefined,
        glacierPct: s.glacier ?? undefined,
        areaKm2: s.area ?? undefined,
        estimate: est ?? undefined,
        note: [
          s.q === null ? (est ? `kein Abfluss veröffentlicht – ${est.label}` : "kein Abfluss veröffentlicht") : "",
          est?.note ?? "",
          s.level && s.level !== "keine Klassifizierung" ? `Wasserstand ${s.level}` : "",
          s.nqt !== null ? `NQT ${fmtNum(s.nqt)} m³/s` : "",
          s.hhq !== null ? `HHQ ${fmtNum(s.hhq)} m³/s` : "",
        ].filter(Boolean).join(" · "),
      };
    });
  },
  async latest(g, f) {
    const all = (await tirolData(f)).stations;
    if (g.estimate) {
      const src = g.estimate.terms.map((t) => all.find((x) => x.id === t.id));
      const q = applyEstimate(g.estimate, (id) => all.find((x) => x.id === id)?.q);
      const times = src.map((s) => s?.time).filter((t): t is string => !!t).sort();
      return q !== null && times.length ? { time: times[0], q } : null;
    }
    const s = all.find((x) => x.id === g.id);
    return s && s.q !== null && s.time ? { time: s.time, q: s.q } : null;
  },
  async daily(g, from, to, f) {
    const pick = (m: Map<string, number>) => new Map([...m].filter(([d]) => d >= from && d <= to));
    if (!g.estimate) return pick(await tirolDaily(g.id, f));
    const series = await Promise.all(g.estimate.terms.map(async (t) => [t.id, await tirolDaily(t.id, f)] as const));
    const byId = new Map(series);
    const out = new Map<string, number>();
    for (const d of series[0]?.[1].keys() ?? []) {
      const q = applyEstimate(g.estimate, (id) => byId.get(id)?.get(d));
      if (q !== null) out.set(d, q);
    }
    return pick(out);
  },
};

// ---------------------------------------------------------------------------
// Frankreich: Hub'Eau Hydrométrie (Eaufrance, offene Daten, Licence Ouverte Etalab 2.0).
// Abfluss in l/s; Echtzeit (observations_tr, ~1 Monat) und Tagesmittel QmnJ (obs_elab, Jahrzehnte).
const HUBEAU = "https://hubeau.eaufrance.fr/api/v2/hydrometrie";
const hubeau: ProviderImpl = {
  bbox: [-5.2, 41.3, 9.6, 51.1],
  async stations(f) {
    const d = (await json(
      await f(`${HUBEAU}/referentiel/stations?format=json&en_service=true&size=10000&fields=code_station,libelle_station,libelle_cours_eau,longitude_station,latitude_station`),
    )) as { data: { code_station: string; libelle_station: string; libelle_cours_eau?: string; longitude_station: number | null; latitude_station: number | null }[] };
    return d.data
      .filter((s) => s.longitude_station !== null && s.latitude_station !== null)
      .map((s) => ({
        provider: "HUBEAU" as const,
        id: s.code_station,
        name: s.libelle_station,
        river: s.libelle_cours_eau ?? undefined,
        lon: s.longitude_station!,
        lat: s.latitude_station!,
        url: `https://www.hydro.eaufrance.fr/stationhydro/${s.code_station}/fiche`,
      }));
  },
  async latest(g, f) {
    const d = (await json(await f(`${HUBEAU}/observations_tr?code_entite=${g.id}&grandeur_hydro=Q&size=1&sort=desc&fields=date_obs,resultat_obs`))) as {
      data: { date_obs: string; resultat_obs: number }[];
    };
    const v = d.data[0];
    return v ? { time: v.date_obs, q: v.resultat_obs / 1000 } : null;
  },
  async daily(g, from, to, f) {
    const d = (await json(
      await f(`${HUBEAU}/obs_elab?code_entite=${g.id}&grandeur_hydro_elab=QmnJ&date_debut_obs_elab=${from}&date_fin_obs_elab=${to}&size=20000&fields=date_obs_elab,resultat_obs_elab`),
    )) as { data: { date_obs_elab: string; resultat_obs_elab: number | null }[] };
    const out = new Map<string, number>();
    for (const v of d.data) if (v.resultat_obs_elab !== null) out.set(v.date_obs_elab, v.resultat_obs_elab / 1000);
    return out;
  },
};

// ---------------------------------------------------------------------------
// Südtirol: Amt für Hydrologie und Stauanlagen, Open-Data-Webservice der Provinz Bozen
// (geoservices.buergernetz.bz.it, CORS offen). Aktuelle Werte aller Q-Sensoren in einer Abfrage,
// Zeitreihen in 10-min-Schritten über Jahre (daraus Tagesmittel).
const BZ = "https://geoservices.buergernetz.bz.it/services/meteo/v1";
let bzLatest: Promise<{ SCODE: string; DATE: string; VALUE: number }[]> | null = null;
function bzSensors(f: typeof fetch) {
  if (!bzLatest) {
    bzLatest = f(`${BZ}/sensors?sensor_code=Q`).then(json) as Promise<{ SCODE: string; DATE: string; VALUE: number }[]>;
    bzLatest.catch(() => (bzLatest = null));
  }
  return bzLatest;
}
/** „2026-11-25T16:20:00CET“ → ISO mit Versatz */
const bzTime = (t: string) => t.replace(/CEST$/, "+02:00").replace(/CET$/, "+01:00");
const bz: ProviderImpl = {
  bbox: [10.38, 46.21, 12.48, 47.1],
  async stations(f) {
    const [sensors, st] = await Promise.all([
      bzSensors(f),
      f(`${BZ}/stations`).then(json) as Promise<{ features: { properties: { SCODE: string; NAME_D: string; LAT: number; LONG: number } }[] }>,
    ]);
    const withQ = new Set(sensors.map((s) => s.SCODE));
    return st.features
      .map((x) => x.properties)
      .filter((p) => withQ.has(p.SCODE))
      .map((p) => {
        const [river, place] = p.NAME_D.split(/ BEI | AN DER | IN /);
        return {
          provider: "BZ" as const,
          id: p.SCODE,
          name: titleCase(p.NAME_D),
          river: place ? titleCase(river) : undefined,
          lat: p.LAT,
          lon: p.LONG,
          url: "https://weather.province.bz.it/en/gauging-stations/",
        };
      });
  },
  async latest(g, f) {
    const v = (await bzSensors(f)).find((s) => s.SCODE === g.id);
    return v ? { time: bzTime(v.DATE), q: v.VALUE } : null;
  },
  async daily(g, from, to, f) {
    const ymd = (d: string) => d.replace(/-/g, "");
    const next = new Date(Date.parse(to) + 864e5).toISOString().slice(0, 10);
    const rows = (await json(
      await f(`${BZ}/timeseries?station_code=${g.id}&sensor_code=Q&output_format=JSON&date_from=${ymd(from)}&date_to=${ymd(next)}`),
    )) as { DATE: string; VALUE: number | null }[];
    const acc = new Map<string, number[]>();
    for (const r of rows) {
      const d = r.DATE.slice(0, 10);
      if (r.VALUE !== null && d >= from && d <= to) (acc.get(d) ?? acc.set(d, []).get(d)!).push(r.VALUE);
    }
    // nur Tage mit mindestens halber Abdeckung (144 Werte/Tag)
    return new Map([...acc].filter(([, v]) => v.length >= 72).map(([d, v]) => [d, v.reduce((a, b) => a + b, 0) / v.length]));
  },
};

const PROVIDERS: Record<Provider, ProviderImpl> = { SMHI: smhi, SYKE: syke, NVE: nve, PEGELONLINE: pegelonline, BAFU: bafu, ARSO: arso, TIROL: tirol, HUBEAU: hubeau, BZ: bz };

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
  tirolArchive.clear();
  arsoDoc = null;
  bzLatest = null;
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

export async function latestReading(g: Gauge, fetchFn: typeof fetch = fetch): Promise<Reading | null> {
  if (g.parts && g.estimate) {
    const rs = await Promise.all(g.parts.map((p) => latestReading(p, fetchFn).catch(() => null)));
    const q = applyEstimate(g.estimate, (id) => rs[g.parts!.findIndex((p) => p.id === id)]?.q);
    const times = rs.map((r) => r?.time).filter((t): t is string => !!t).sort();
    return q !== null && times.length ? { time: times[0], q } : null;
  }
  return PROVIDERS[g.provider].latest(g, fetchFn);
}

export async function dailyValues(g: Gauge, from: string, to: string, fetchFn: typeof fetch = fetch): Promise<Map<string, number>> {
  if (g.parts && g.estimate) {
    const ms = await Promise.all(g.parts.map((p) => dailyValues(p, from, to, fetchFn).catch(() => new Map<string, number>())));
    const out = new Map<string, number>();
    for (const d of ms[0]?.keys() ?? []) {
      const q = applyEstimate(g.estimate, (id) => ms[g.parts!.findIndex((p) => p.id === id)]?.get(d));
      if (q !== null) out.set(d, q);
    }
    return out;
  }
  return PROVIDERS[g.provider].daily(g, from, to, fetchFn);
}

const norm = (r?: string) => (r ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^(le |la |l'|les )/, "").trim();
const fmt1 = (v: number) => v.toFixed(1).replace(".", ",");

/**
 * Kein Pegel an der Strecke: Pegel bis `maxKm` oberhalb des Einstiegs bzw. unterhalb des Ausstiegs
 * suchen (Linie läuft flussabwärts). Pegel auf beiden Seiten am selben Fluss → nach Lage
 * interpolieren; sonst der nächste einzelne Pegel (muss dann zur Wassermenge des Modells passen).
 */
export async function gaugesBeyondEnds(line: LngLat[], maxKm = 5, fetchFn: typeof fetch = fetch): Promise<{ gauges: NearGauge[]; virtual: boolean; errors: string[] }> {
  const { gauges, errors } = await gaugesAlong(line, maxKm, fetchFn);
  const start = line[0], end = line[line.length - 1];
  let len = 0;
  for (let i = 1; i < line.length; i++) len += distKm(line[i - 1], line[i]);
  const beyond = (g: NearGauge, p: LngLat) => {
    const d = distKm([g.lon, g.lat], p);
    return d - g.distanceKm < 0.3 && g.distanceKm > 1.5 ? d : null; // nächster Linienpunkt ist das Ende
  };
  const up = gauges.map((g) => ({ g, d: beyond(g, start) })).filter((x) => x.d !== null).sort((a, b) => a.d! - b.d!)[0];
  const down = gauges.map((g) => ({ g, d: beyond(g, end) })).filter((x) => x.d !== null).sort((a, b) => a.d! - b.d!)[0];
  if (up && down && up.g.provider === down.g.provider && norm(up.g.river) && norm(up.g.river) === norm(down.g.river)) {
    const wd = (up.d! + len / 2) / (up.d! + len + down.d!);
    const estimate: Estimate = {
      method: "zwischen",
      terms: [{ id: up.g.id, name: up.g.name, w: 1 - wd }, { id: down.g.id, name: down.g.name, w: wd }],
      label: `geschätzt zwischen den Pegeln ${up.g.name} (${fmt1(up.d!)} km oberhalb) und ${down.g.name} (${fmt1(down.d!)} km unterhalb), nach Lage gewichtet`,
    };
    const v: NearGauge = {
      ...up.g,
      id: `${up.g.id}+${down.g.id}`,
      name: `${up.g.name} / ${down.g.name}`,
      estimate,
      parts: [up.g, down.g],
      distanceKm: Math.min(up.g.distanceKm, down.g.distanceKm),
      note: [estimate.label, up.g.note ? `${up.g.name}: ${up.g.note}` : "", down.g.note ? `${down.g.name}: ${down.g.note}` : ""].filter(Boolean).join(" · "),
    };
    return { gauges: [v], virtual: true, errors };
  }
  const single = [up, down].filter(Boolean).sort((a, b) => a!.d! - b!.d!).map((x) => ({
    ...x!.g,
    note: [`${fmt1(x!.d!)} km ${x === up ? "oberhalb des Einstiegs" : "unterhalb des Ausstiegs"} – Zubringer dazwischen nicht enthalten`, x!.g.note].filter(Boolean).join(" · "),
  }));
  return { gauges: single, virtual: false, errors };
}

/** Hat der Anbieter Tageswerte der Vergangenheit (für den Aufnahmetag eines Luftbilds)? */
export const hasHistory = (p: Provider) => p !== "PEGELONLINE" && p !== "BAFU" && p !== "ARSO";

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
  /** Zuordnung zum Fluss ungeprüft: mehrere Pegel an verschiedenen Gewässern, aber keine Vergleichsdaten */
  unverified: boolean;
  /** aktuelle Werte der weiteren Pegel (gleiche Reihenfolge wie others) */
  othersLatest: (Reading | null)[];
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
  let { gauges, errors } = await gaugesAlong(line, 1.5, fetchFn);
  let virtual = false;
  if (!gauges.length) {
    const b = await gaugesBeyondEnds(line, 5, fetchFn);
    ({ gauges, virtual } = b);
    errors = [...errors, ...b.errors];
    // einzelner Pegel abseits der Strecke nur, wenn das Modell zum Vergleich da ist
    if (!virtual && !model) gauges = [];
  }
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
      const plausible = g.distanceKm < 0.3 || virtual || (factor === null ? g.distanceKm <= 1.5 : factor > 0.2 && factor < 5);
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
  const others = gauges.filter((g) => g !== best.g).slice(0, 4);
  const onDates = new Map<string, number>();
  if ((best.g.parts ?? [best.g]).every((p) => hasHistory(p.provider)))
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
      others,
      unverified: !model && new Set(gauges.slice(0, 4).map((g) => (g.river ?? "").toLowerCase())).size > 1,
      othersLatest: await Promise.all(others.map((g) => latestReading(g, fetchFn).catch(() => null))),
    },
    errors,
  };
}
