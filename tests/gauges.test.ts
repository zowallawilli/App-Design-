import { describe, expect, it } from "vitest";
import { matchGauge, titleCase, TIROL_MIRROR, resetGaugeCache } from "../src/gauges";
import { officialGauges } from "../src/discharge";

const SMHI = "https://opendata-download-hydroobs.smhi.se/api/version/1.0/parameter/1";
const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - i) * 864e5).toISOString().slice(0, 10));

/** Fake-SMHI: Station 1 = Bach (0,3 m³/s), Station 2 = Fluss (~50 m³/s, folgt dem Modell) */
function fakeFetch(model: Map<string, number>): typeof fetch {
  return (async (url: string) => {
    const ok = (body: unknown, text = false) => new Response(text ? (body as string) : JSON.stringify(body), { status: 200 });
    if (url === `${SMHI}.json`)
      return ok({
        station: [
          { key: "1", name: "LISJÖBÄCKEN", latitude: 60.0005, longitude: 13.1, active: true, catchmentName: "KLARÄLVEN" },
          { key: "2", name: "EDSFORSEN", latitude: 60.001, longitude: 13.1, active: true, catchmentName: "KLARÄLVEN" },
        ],
      });
    const m = /station\/(\d)\/period\/(latest-day\/data\.json|corrected-archive\/data\.csv)/.exec(url);
    if (!m) return new Response("", { status: 404 });
    const st = m[1];
    if (m[2].startsWith("latest")) return ok({ value: [{ date: Date.now(), value: st === "1" ? 0.3 : 52 }] });
    const lines = [...model].map(([d, q], i) => `${d};${st === "1" ? (0.3 + (i % 3) * 0.01).toFixed(2) : (q * 1.3).toFixed(1)};G;;`);
    lines.push("2019-09-08;61.5;G;;");
    return ok(`Datum;Vattenföring;Kvalitet\n${lines.join("\n")}`, true);
  }) as unknown as typeof fetch;
}

describe("Pegel", () => {
  it("Namen Unicode-sicher in Titelschreibweise", () => {
    expect(titleCase("LISJÖBÄCKEN ÖVRE")).toBe("Lisjöbäcken Övre");
  });

  it("wählt den Pegel am Fluss (passt zum Modell), nicht den Bach daneben", async () => {
    const t = days(40);
    const model = new Map(t.map((d, i) => [d, 30 + 10 * Math.sin(i / 4)]));
    const series = { time: [...model.keys()], q: [...model.values()] };
    const line: [number, number][] = [[13.1, 59.99], [13.1, 60.0], [13.1, 60.01]];
    const { match } = await matchGauge(line, series, ["2019-09-08"], fakeFetch(model));
    expect(match?.gauge.name).toBe("Edsforsen");
    expect(match?.factor).toBeCloseTo(1.3, 1); // Modell 30 % zu niedrig
    expect(match?.correlation).toBeGreaterThan(0.99);
    expect(match?.onDates.get("2019-09-08")).toBe(61.5); // gemessen am Aufnahmetag
    expect(match?.latest?.q).toBe(52);
  });

  it("kein Pegel weiter als 1,5 km von der Linie", async () => {
    const model = new Map(days(20).map((d) => [d, 10]));
    const { match } = await matchGauge([[14.0, 61.0], [14.01, 61.0]], { time: [...model.keys()], q: [...model.values()] }, [], fakeFetch(model));
    expect(match).toBeNull();
  });
});

describe("Pegel Tirol (Spiegel)", () => {
  const mirror = {
    fetched: new Date().toISOString(),
    stations: [
      { id: "202036", name: "Landeck Bruggen", river: "Sanna", lat: 47.14338, lon: 10.5628, q: 4.872, time: "2026-11-25T12:00:00.000Z", dayMean: 5.12, nnq: 1.88, nqt: 3.38, hhq: 491, level: "niedrig" },
      { id: "201319", name: "Imst (Bahnhof)", river: "Inn", lat: 47.1437, lon: 10.5528, q: null, time: null, dayMean: null, nnq: 2.44, nqt: 16.2, hhq: 1085, level: "niedrig" },
    ],
  };
  const f = (async (url: string) =>
    url === TIROL_MIRROR ? new Response(JSON.stringify(mirror), { status: 200 }) : new Response("", { status: 404 })) as unknown as typeof fetch;

  it("nimmt den gemessenen Pegel an der Strecke, auch wenn das Modell 10× daneben liegt", async () => {
    resetGaugeCache();
    const t = days(10);
    const model = { time: t, q: t.map(() => 49) };
    const line: [number, number][] = [[10.54, 47.14], [10.5628, 47.1434]];
    const { match } = await matchGauge(line, model, [], f);
    expect(match?.gauge.name).toBe("Landeck Bruggen");
    expect(match?.latest?.q).toBe(4.872);
    expect(match?.gauge.note).toContain("NQT 3,4 m³/s");
  });

  it("Pegel ohne Abfluss (nur Wasserstandsklasse) wird angezeigt, wenn kein anderer da ist", async () => {
    resetGaugeCache();
    const { match } = await matchGauge([[10.55, 47.1437], [10.553, 47.1437]], null, [], (async (url: string) =>
      new Response(JSON.stringify({ ...mirror, stations: [mirror.stations[1]] }), { status: url === TIROL_MIRROR ? 200 : 404 })) as unknown as typeof fetch);
    expect(match?.gauge.name).toBe("Imst (Bahnhof)");
    expect(match?.latest).toBeNull();
    expect(match?.gauge.note).toContain("kein Abfluss veröffentlicht");
  });

  it("Länderlinks: Sanna (Tirol) zeigt Tirol und eHYD, nicht nur BAFU", () => {
    const labels = officialGauges([10.49, 47.12]).map((x) => x.label);
    expect(labels[0]).toBe("Hydrographischer Dienst Tirol");
    expect(labels).toContain("eHYD (Österreich)");
    expect(officialGauges([7.5, 46.9]).map((x) => x.label)).toEqual(["BAFU Hydrodaten (Schweiz)"]);
  });
});

describe("Neue Quellen", () => {
  const days10 = days(12);
  it("Tirol: Tageswerte aus dem Archiv → Verlauf und Eichfaktor", async () => {
    resetGaugeCache();
    const st = { id: "202036", name: "Landeck Bruggen", river: "Sanna", lat: 47.14338, lon: 10.5628, area: 727, km: 0.1, alt: 775, q: 5, time: "2026-11-25T12:00:00.000Z", dayMean: 5, nnq: 1, nqt: 3, hhq: 491, level: "niedrig" };
    const arch = { dm: Object.fromEntries(days10.map((d, i) => [d, 4 + i * 0.5])), s: {} };
    const f = (async (url: string) =>
      url === TIROL_MIRROR ? new Response(JSON.stringify({ fetched: "", stations: [st] }))
        : url.endsWith("/tirol-archiv/202036.json") ? new Response(JSON.stringify(arch))
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    const model = { time: days10, q: days10.map((_, i) => 40 + i * 5) };
    const { match } = await matchGauge([[10.54, 47.14], [10.5628, 47.1434]], model, [days10[3]], f);
    expect(match?.correlation).toBeGreaterThan(0.99);
    expect(match?.factor).toBeCloseTo(0.1, 1);
    expect(match?.onDates.get(days10[3])).toBe(5.5);
  });

  it("Hub'Eau: l/s → m³/s, Tagesmittel QmnJ", async () => {
    resetGaugeCache();
    const H = "https://hubeau.eaufrance.fr/api/v2/hydrometrie";
    const f = (async (url: string) => {
      if (url.startsWith(`${H}/referentiel/stations`))
        return new Response(JSON.stringify({ data: [{ code_station: "V123521001", libelle_station: "Le Fier à Vallières", libelle_cours_eau: "Le Fier", longitude_station: 5.95, latitude_station: 45.9 }] }));
      if (url.startsWith(`${H}/observations_tr`)) return new Response(JSON.stringify({ data: [{ date_obs: "2026-11-25T15:30:00Z", resultat_obs: 2230 }] }));
      if (url.startsWith(`${H}/obs_elab`)) return new Response(JSON.stringify({ data: [{ date_obs_elab: "2019-07-01", resultat_obs_elab: 347 }] }));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { match } = await matchGauge([[5.949, 45.9], [5.951, 45.9]], null, ["2019-07-01"], f);
    expect(match?.gauge.provider).toBe("HUBEAU");
    expect(match?.latest?.q).toBeCloseTo(2.23);
    expect(match?.onDates.get("2019-07-01")).toBeCloseTo(0.347);
  });

  it("Südtirol: Stationen mit Q-Sensor, Fluss aus dem Namen, Tagesmittel aus 10-min-Werten", async () => {
    resetGaugeCache();
    const B = "https://geoservices.buergernetz.bz.it/services/meteo/v1";
    const rows = Array.from({ length: 144 }, (_, i) => ({ DATE: `2019-07-05T${String(Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00CEST`, VALUE: 130 }));
    const f = (async (url: string) => {
      if (url === `${B}/sensors?sensor_code=Q`) return new Response(JSON.stringify([{ SCODE: "19850PG", DATE: "2026-11-25T16:20:00CET", VALUE: 39.8 }]));
      if (url === `${B}/stations`)
        return new Response(JSON.stringify({ features: [
          { properties: { SCODE: "19850PG", NAME_D: "ETSCH BEI SPONDINIG", LAT: 46.64, LONG: 10.6 } },
          { properties: { SCODE: "00390SF", NAME_D: "SCHLANDERS", LAT: 46.62, LONG: 10.77 } },
        ] }));
      if (url.startsWith(`${B}/timeseries?station_code=19850PG`)) return new Response(JSON.stringify(rows));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { match } = await matchGauge([[10.599, 46.64], [10.601, 46.64]], null, ["2019-07-05"], f);
    expect(match?.gauge.provider).toBe("BZ");
    expect(match?.gauge.river).toBe("Etsch");
    expect(match?.latest).toEqual({ time: "2026-11-25T16:20:00+01:00", q: 39.8 });
    expect(match?.onDates.get("2019-07-05")).toBe(130);
  });
});

describe("Pegel abseits der Strecke", () => {
  const PO = "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations";
  const mk = (stations: { uuid: string; name: string; water: string; lon: number; q: number }[]) =>
    (async (url: string) => {
      if (url.startsWith(`${PO}.json`))
        return new Response(JSON.stringify(stations.map((s) => ({ uuid: s.uuid, shortname: s.name, latitude: 50.0, longitude: s.lon, water: { longname: s.water }, timeseries: [{ shortname: "Q" }] }))));
      const m = /stations\/([^/]+)\/Q\/currentmeasurement/.exec(url);
      if (m) return new Response(JSON.stringify({ timestamp: "2026-11-25T12:00:00+01:00", value: stations.find((s) => s.uuid === m[1])!.q }));
      return new Response("[]");
    }) as unknown as typeof fetch;
  // Strecke 8,00–8,10 °O (~7 km) auf 50° N, flussabwärts nach Osten
  const line: [number, number][] = Array.from({ length: 11 }, (_, i) => [8.0 + i * 0.01, 50.0]);

  it("Pegel ober- und unterhalb am selben Fluss → nach Lage interpoliert", async () => {
    resetGaugeCache();
    const f = mk([
      { uuid: "a", name: "Oben", water: "LAHN", lon: 7.97, q: 10 }, // ~2,1 km oberhalb
      { uuid: "b", name: "Unten", water: "LAHN", lon: 8.14, q: 20 }, // ~2,9 km unterhalb
    ]);
    const { match } = await matchGauge(line, null, [], f);
    expect(match?.gauge.estimate?.method).toBe("zwischen");
    const L = 7.15, u = 2.14, d = 2.86, wd = (u + L / 2) / (u + L + d);
    expect(match?.latest?.q).toBeCloseTo(10 * (1 - wd) + 20 * wd, 0);
  });

  it("einzelner Pegel abseits nur, wenn er zur Wassermenge des Modells passt", async () => {
    resetGaugeCache();
    const t = days(12);
    const f = mk([{ uuid: "c", name: "Bach", water: "KLEINBACH", lon: 7.97, q: 0.4 }]);
    const { match } = await matchGauge(line, { time: t, q: t.map(() => 30) }, [], f);
    expect(match).toBeNull();
    resetGaugeCache();
    const { match: m2 } = await matchGauge(line, { time: t, q: t.map(() => 30) }, [], mk([{ uuid: "c", name: "Oben", water: "LAHN", lon: 7.97, q: 25 }]));
    expect(m2?.gauge.note).toContain("oberhalb des Einstiegs");
  });
});
