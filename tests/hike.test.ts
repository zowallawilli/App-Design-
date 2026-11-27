import { describe, expect, it } from "vitest";
import { climb, dinHours, hikeRoutes, rasterLines, tobler } from "../src/hike";
import { lngLatToPixel } from "../src/dem";
import type { Grid } from "../src/flow";

/** künstliches Gelände: zwei Täler (links/rechts), dazwischen ein Grat mit Sattel bei y = 85 */
function terrain(): Grid {
  const z = 12, w = 120, h = 120;
  const [px, py] = lngLatToPixel([10, 47], z);
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ridge = Math.max(0, 1 - Math.abs(x - 60) / 30); // 0 im Tal, 1 am Grat
      const top = Math.abs(y - 85) < 6 ? 500 : 1300; // Sattel 500 m, sonst 1300 m über Tal
      elev[y * w + x] = 800 + ridge * top;
    }
  return { z, x0: Math.floor(px), y0: Math.floor(py), w, h, elev };
}

describe("Verbindungswege", () => {
  it("Gehzeit nach DIN 33466 und Tobler", () => {
    expect(dinHours(8000, 0, 0)).toBeCloseTo(2, 5);
    expect(dinHours(4000, 600, 0)).toBeCloseTo(2 + 0.5, 5); // 2 h Aufstieg + halbe Stunde Strecke
    expect(tobler(-0.05)).toBeCloseTo(6, 5);
    expect(tobler(0.3)).toBeLessThan(tobler(0));
  });
  it("Auf-/Abstieg ohne Höhenmodell-Rauschen", () => {
    expect(climb([100, 102, 99, 101, 150, 148, 120])).toEqual({ ascent: 50, descent: 30 });
  });
  it("findet den Sattel zwischen zwei Tälern (Fluss → Fluss) und eine Alternative", () => {
    const g = terrain();
    const kind = new Uint8Array(g.w * g.h);
    const col = (x: number) => Int32Array.from({ length: g.h - 10 }, (_, i) => (i + 5) * g.w + x);
    const res = hikeRoutes(g, kind, col(10), col(110), 1);
    expect(res.length).toBeGreaterThanOrEqual(1);
    const best = res[0];
    const passY = Math.floor((lngLatToPixel(best.pass, g.z)[1] - g.y0));
    expect(Math.abs(passY - 85)).toBeLessThan(8);
    expect(best.maxElev).toBeLessThan(1400);
    expect(best.ascent).toBeGreaterThan(400);
    expect(best.hours).toBeGreaterThan(0);
    if (res[1]) expect(res[1].costHours).toBeGreaterThanOrEqual(best.costHours * 0.999);
  });
  it("bevorzugt einen Weg, auch wenn er etwas länger ist", () => {
    const g = terrain();
    g.elev.fill(500);
    const kind = new Uint8Array(g.w * g.h);
    // gerader Weg in einem Bogen (Zeile 20), Start/Ziel in Zeile 60
    const a = (x: number, y: number) => {
      const [lon, lat] = [x, y].map(Number);
      return [lon, lat];
    };
    void a;
    for (let x = 10; x <= 110; x++) kind[30 * g.w + x] = 1;
    for (let y = 30; y <= 60; y++) { kind[y * g.w + 10] = 1; kind[y * g.w + 110] = 1; }
    const res = hikeRoutes(g, kind, Int32Array.of(60 * g.w + 10), Int32Array.of(60 * g.w + 110), 0);
    expect(res[0].offTrail).toBeLessThan(0.2);
    void rasterLines;
  });
});

describe("Verbindungswege: Flüsse und Steilhänge", async () => {
  const { dilate, hikeRoutes: routes, steepFactor } = await import("../src/hike");
  it("quert einen Fluss lieber über die Brücke (Weg) als direkt", () => {
    const g = terrain();
    g.elev.fill(500);
    const kind = new Uint8Array(g.w * g.h);
    for (let y = 0; y < g.h; y++) kind[y * g.w + 60] = 2; // Fluss senkrecht
    dilate(g, kind, 2, 1);
    for (let x = 50; x <= 70; x++) kind[90 * g.w + x] = 1; // Brücke in Zeile 90
    const r = routes(g, kind, Int32Array.of(20 * g.w + 40), Int32Array.of(20 * g.w + 80), 0)[0];
    const crossY = r.line.map((p) => Math.floor(lngLatToPixel(p, g.z)[1] - g.y0)).find((_, i) => Math.abs(Math.floor(lngLatToPixel(r.line[i], g.z)[0] - g.x0) - 60) < 1);
    expect(crossY).toBe(90);
  });
  it("Steilhang ab ~33° gesperrt, dazwischen teurer", () => {
    expect(steepFactor(0.2)).toBe(1);
    expect(steepFactor(0.5)).toBeGreaterThan(2);
    expect(steepFactor(0.7)).toBe(Infinity);
  });
  it("umgeht einen steilen Hang statt ihn zu queren", () => {
    const g = terrain();
    // Hang 45° quer zur direkten Linie, flach außen herum (x > 100)
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) g.elev[y * g.w + x] = 500 + (x < 100 ? Math.max(0, 20 - Math.abs(y - 60)) * 26 : 0);
    const kind = new Uint8Array(g.w * g.h);
    const r = routes(g, kind, Int32Array.of(10 * g.w + 50), Int32Array.of(110 * g.w + 50), 0)[0];
    expect(r.maxElev).toBeLessThan(600); // nicht über den Rücken (bis ~1000 m)
    expect(r.steep).toBeFalsy();
  });
});
