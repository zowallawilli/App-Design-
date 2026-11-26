import { describe, expect, it } from "vitest";
import { assess, captureNote, isGlacial, responseDays, seasonHint, weatherHints, type WeatherWindow } from "../src/weather";

const win = (rain: number[], opts: { snow?: number[]; temp?: number; snowfall?: number[]; elevation?: number; end?: string } = {}): WeatherWindow => {
  const n = rain.length;
  const end = Date.parse(`${opts.end ?? "2023-09-14"}T12:00:00Z`);
  const time = Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
  const pt = { rain, snowfall: opts.snowfall ?? rain.map(() => 0), temp: rain.map(() => opts.temp ?? 12), snow: opts.snow ?? rain.map(() => 0), elevation: opts.elevation ?? 1500 };
  return { time, points: [pt, pt] };
};
const OETZ: [number, number] = [10.91, 47.16]; // Ötztaler Ache bei Tumpen

describe("Hinweise aus Wetter und Jahreszeit", () => {
  it("kräftiger Regen vor der Aufnahme", () => {
    const h = weatherHints(win([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 40, 32]));
    expect(h[0]).toMatchObject({ effect: 2 });
    expect(h[0].text).toMatch(/^Kräftiger Regen verbreitet im Gebiet/);
  });
  it("zwei Wochen trocken → eher niedrig", () => {
    const c = assess("2023-09-14", [10.5, 47.1], win(Array(14).fill(0.2)));
    expect(c.tendency).toBe("eher niedrig");
    expect(c.hints.some((h) => /fast trocken/.test(h.text))).toBe(true);
  });
  it("schrumpfende Schneedecke bei Plusgraden → Schneeschmelze, eher hoch", () => {
    const snow = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35];
    const c = assess("2023-05-14", [10.5, 47.1], win(Array(14).fill(1), { snow, temp: 6, end: "2023-05-14" }));
    expect(c.hints.some((h) => /^Schneeschmelze/.test(h.text))).toBe(true);
    expect(c.tendency).toBe("eher hoch");
  });
  it("Tauwetter im Gebirge im Frühjahr, auch ohne Schnee im groben Raster", () => {
    const c = assess("2023-04-20", [10.5, 47.1], win(Array(14).fill(1), { temp: 12, elevation: 1000, end: "2023-04-20" }));
    expect(c.hints.some((h) => /Tauwetter bis ~2000 m/.test(h.text))).toBe(true);
  });
  it("Starkregen 9 Tage vorher (Sanna, Aug. 2023)", () => {
    const h = weatherHints(win([15, 10, 40, 35, 25, 4, 1, 1, 0, 0, 0, 0, 0, 0]));
    expect(h.some((x) => /^Starkregen 9 Tage davor/.test(x.text))).toBe(true);
  });
  it("Hinweise sind kurz", () => {
    const c = assess("2023-05-14", [10.5, 47.1], win([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 40, 32], { temp: 8, end: "2023-05-14" }));
    for (const h of c.hints) expect(h.text.length).toBeLessThan(90);
  });
  it("Jahreszeit je Region", () => {
    expect(seasonHint([9.4, 61.7], "2019-06-10")?.text).toContain("vårflom");
    expect(seasonHint([10.5, 47.1], "2023-01-10")?.effect).toBe(-1);
    expect(seasonHint([-19, 63.8], "2023-07-10")?.text).toContain("Gletscherflüsse");
  });
  it("Bildart kurz", () => {
    expect(captureNote("Vantor", "Vivid")).toBe("Satellitenbild");
    expect(captureNote("Land Tirol - data.gv.at", "Land Tirol")).toBe("Orthofoto");
  });
});

describe("Gletscherflüsse (Ötz)", () => {
  const glacier = { pct: 9.3 }; // Tumpen laut HD Tirol
  it("erkennt Gletscherfluss aus Stammdaten oder Gletscherfläche im Umkreis", () => {
    expect(isGlacial(glacier)).toBe(true);
    expect(isGlacial({ pct: 0.5 })).toBe(false);
    expect(isGlacial({ areaKm2: 40 })).toBe(true);
    expect(isGlacial({ areaKm2: 1 })).toBe(false);
  });
  it("Hochsommer + Hitze im Hochgebirge → eher hoch, auch ohne Regen", () => {
    // Talpunkt 1200 m, 22 °C → ~10 °C auf 3000 m
    const c = assess("2023-07-20", OETZ, win(Array(14).fill(0.3), { temp: 22, elevation: 1200, end: "2023-07-20" }), glacier);
    expect(c.hints.some((h) => /Gletscherfluss im Sommer/.test(h.text))).toBe(true);
    expect(c.hints.some((h) => /starke Gletscherschmelze/.test(h.text))).toBe(true);
    expect(c.hints.some((h) => /trocken/.test(h.text))).toBe(false); // Trockenheit senkt Gletscherflüsse nicht
    expect(c.tendency).toBe("eher hoch");
  });
  it("Kälteeinbruch im Sommer bremst die Schmelze", () => {
    const c = assess("2023-07-20", OETZ, win(Array(14).fill(2), { temp: 6, elevation: 1200, end: "2023-07-20" }), glacier);
    expect(c.hints.some((h) => /Gletscherschmelze gebremst/.test(h.text))).toBe(true);
  });
  it("ohne Gletscher: Hochsommer neutral", () => {
    const c = assess("2023-07-20", OETZ, win(Array(14).fill(2), { temp: 22, elevation: 1200, end: "2023-07-20" }), { pct: 0 });
    expect(c.hints.some((h) => /Gletscher/.test(h.text))).toBe(false);
  });
});

describe("Einzugsgebiet: Fläche und Reaktionszeit", () => {
  it("Gewitter an nur einem Bezugspunkt zählt als örtlich, nicht als Hochwasser", () => {
    const n = 14;
    const end = Date.parse("2023-07-20T12:00:00Z");
    const time = Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
    const dry = { rain: Array(n).fill(0.5), snowfall: Array(n).fill(0), temp: Array(n).fill(15), snow: Array(n).fill(0), elevation: 1200 };
    const storm = { ...dry, rain: [...Array(n - 1).fill(0.5), 60] };
    const h = weatherHints({ time, points: [storm, dry, dry, dry, dry, dry] });
    expect(h[0]).toMatchObject({ effect: 1 });
    expect(h[0].text).toMatch(/^Örtlich kräftiger Regen/);
  });
  it("großes Gebiet reagiert länger", () => {
    expect(responseDays(200).now).toBeLessThan(responseDays(5000).now);
    expect(responseDays(5000).until).toBeGreaterThanOrEqual(responseDays(200).until);
  });
  it("Speicher oberhalb → Hinweis auf gedämpfte Wirkung", () => {
    const c = assess("2023-07-20", [10.5, 47.1], null, null, { regulated: ["Gepatschspeicher"] });
    expect(c.hints.some((h) => /Speicher\/Kraftwerke oberhalb \(Gepatschspeicher\)/.test(h.text))).toBe(true);
  });
});

describe("Regime: Gletscher-, Schneeschmelze oder Regen", async () => {
  const { regimeOf, seasonHint, snowElevation } = await import("../src/weather");
  it("erkennt Gletscher vor Schnee vor Regen", () => {
    expect(regimeOf({ pct: 9.3 }, 3700, 47).kind).toBe("gletscher");
    expect(regimeOf({ areaKm2: 0 }, 2400, 46.3).kind).toBe("schnee");
    expect(regimeOf({ areaKm2: 0 }, 700, 49.8).kind).toBe("regen");
    expect(regimeOf(null, 700, 61).kind).toBe("schnee"); // im Norden liegt auch tief Schnee
    expect(regimeOf(null, undefined, 47).kind).toBe("regen");
    expect(regimeOf({ areaKm2: 0 }, 2400, 46.3).text).toMatch(/2\.400 m/);
    expect(snowElevation(-45)).toBe(snowElevation(45));
  });
  it("Jahreszeit nach Regime, Südhalbkugel versetzt", () => {
    expect(seasonHint([75, 42], "2026-05-10", false, "schnee")?.effect).toBe(1); // Tian Shan im Mai
    expect(seasonHint([75, 42], "2026-12-10", false, "schnee")?.effect).toBe(-1);
    expect(seasonHint([170, -44], "2026-11-10", false, "schnee")?.effect).toBe(1); // Neuseeland im November = Mai
    expect(seasonHint([11, 47.8], "2026-05-10", false, "regen")).toBeNull(); // Voralpenfluss: keine Schneeschmelze
  });
});
