import { describe, expect, it } from "vitest";
import { assess, captureNote, seasonHint, weatherHints, type WeatherWindow } from "../src/weather";

const win = (rain: number[], opts: { snow?: number[]; temp?: number; snowfall?: number[] } = {}): WeatherWindow => {
  const n = rain.length;
  const time = Array.from({ length: n }, (_, i) => `2023-09-${String(i + 1).padStart(2, "0")}`);
  const pt = { rain, snowfall: opts.snowfall ?? rain.map(() => 0), temp: rain.map(() => opts.temp ?? 12), snow: opts.snow ?? rain.map(() => 0), elevation: 1500 };
  return { time, points: [pt, pt] };
};

describe("Hinweise aus Wetter und Jahreszeit", () => {
  it("kräftiger Regen vor der Aufnahme → eher hoch", () => {
    const w = win([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 40, 32]);
    const h = weatherHints(w);
    expect(h[0].effect).toBe(2);
    expect(h[0].text).toContain("Kräftiger Regen");
    expect(assess("2023-09-14", [10.5, 47.1], w).tendency).toBe("eher erhöht"); // Herbst neutral → +2
  });
  it("zwei Wochen trocken → eher niedrig", () => {
    const c = assess("2023-09-14", [10.5, 47.1], win(Array(14).fill(0.2)));
    expect(c.tendency).toBe("eher niedrig");
    expect(c.hints.some((h) => /trocken/.test(h.text))).toBe(true);
  });
  it("schrumpfende Schneedecke bei Plusgraden → Schneeschmelze", () => {
    const snow = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35];
    const c = assess("2023-05-14", [10.5, 47.1], win(Array(14).fill(1), { snow, temp: 6 }));
    expect(c.hints.some((h) => /Schneeschmelze im Gange/.test(h.text))).toBe(true);
    expect(c.tendency).toBe("eher hoch"); // Schmelze (+2) + Alpen-Frühjahr (+1)
  });
  it("Jahreszeit je Region", () => {
    expect(seasonHint([9.4, 61.7], "2019-06-10")?.text).toContain("vårflom");
    expect(seasonHint([10.5, 47.1], "2023-01-10")?.effect).toBe(-1);
    expect(seasonHint([-19, 63.8], "2023-07-10")?.text).toContain("Gletscherflüsse");
  });
  it("Aufnahmeart: Satellit vs. Befliegung", () => {
    expect(captureNote("Vantor", "Vivid")).toContain("Satellitenbild");
    expect(captureNote("Land Tirol - data.gv.at", "Land Tirol")).toContain("Befliegung");
  });
});

describe("Starkregen früher im Zeitraum", () => {
  it("Unwetter 9 Tage vorher wird erwähnt (Sanna, Aug. 2023)", () => {
    const h = weatherHints(win([15, 10, 40, 35, 25, 4, 1, 1, 0, 0, 0, 0, 0, 0]));
    expect(h.some((x) => /Starkregen \d+ Tage vor/.test(x.text))).toBe(true);
  });
});
