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
