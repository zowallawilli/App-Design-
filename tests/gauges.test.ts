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
