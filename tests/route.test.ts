import { describe, expect, it } from "vitest";
import { buildCost, leastCostPath, traceRiver } from "../src/route";
import { lngLatToPixel, type TileLoader } from "../src/dem";
import type { Grid } from "../src/flow";
import { haversine, type LngLat } from "../src/geo";

const Z = 15;
const pixToLngLat = (px: number, py: number): LngLat => {
  const n = 256 * 2 ** Z;
  return [(px / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI];
};
// Ursprung: Pixel im Soča-Gebiet
const [OX, OY] = lngLatToPixel([13.55, 46.33], Z).map(Math.floor);

/** Fluss läuft als Sinuswelle von Nord nach Süd: x = A·sin(y/λ) */
const riverX = (y: number) => 300 + 120 * Math.sin(y / 60);

/** Tal: Talboden folgt einer GERADEN Linie (x = 300) – wie ein verschobenes Höhenmodell –, fällt nach Süden. */
const valleyLoader: TileLoader = async (_z, tx, ty) => {
  const out = new Float32Array(256 * 256);
  for (let r = 0; r < 256; r++)
    for (let c = 0; c < 256; c++) {
      const px = tx * 256 + c - OX, py = ty * 256 + r - OY;
      out[r * 256 + c] = 1000 - py * 0.05 + Math.abs(px - 300) * 0.3;
    }
  return out;
};

/** Sentinel-Stub: Wasser genau auf der Sinuskurve (±3 Pixel). */
const sineWater = async (g: Grid) => {
  const ndwi = new Float32Array(g.w * g.h).fill(-0.4);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const py = g.y0 + y - OY, px = g.x0 + x - OX;
      if (Math.abs(px - riverX(py)) <= 3) ndwi[y * g.w + x] = 0.3;
    }
  return { ndwi, label: "Test" };
};

describe("leastCostPath", () => {
  it("findet den günstigsten Weg um ein Hindernis", () => {
    const w = 20, h = 20;
    const g: Grid = { z: Z, x0: 0, y0: 0, w, h, elev: new Float32Array(w * h) };
    const cost = new Float32Array(w * h).fill(1);
    for (let y = 0; y < 15; y++) cost[y * w + 10] = 1000; // Wand mit Lücke unten
    const path = leastCostPath(g, cost, 2 * w + 2, 2 * w + 17)!;
    expect(path[0]).toBe(2 * w + 2);
    expect(path[path.length - 1]).toBe(2 * w + 17);
    expect(path.some((c) => c === 15 * w + 10 || Math.floor(c / w) >= 15)).toBe(true);
  });

  it("buildCost: Satellitensignal senkt Kosten und Vertrauen ins Höhenmodell", () => {
    const g: Grid = { z: Z, x0: 0, y0: 0, w: 2, h: 1, elev: new Float32Array(2) };
    const { cost, demTrust } = buildCost(g, {
      hand: Float32Array.from([20, 20]),
      water: Float32Array.from([1, 0.05]),
      osm: Float32Array.from([1, 1]),
    });
    expect(cost[1]).toBeLessThan(cost[0] / 50);
    expect(demTrust[1]).toBeLessThan(0.001);
  });
});

describe("traceRiver", () => {
  const putIn = pixToLngLat(OX + riverX(40) + 0.5, OY + 40.5);
  const takeOut = pixToLngLat(OX + riverX(700) + 0.5, OY + 700.5);
  const meanOffset = (line: LngLat[]) => {
    let s = 0;
    for (const p of line) {
      const [px, py] = lngLatToPixel(p, Z);
      s += Math.abs(px - OX - riverX(py - OY));
    }
    return s / line.length;
  };

  it("folgt ohne Satellit dem Talboden des Höhenmodells", async () => {
    const r = await traceRiver(putIn, takeOut, { loader: valleyLoader, maxZoom: Z });
    expect(r.sources).toEqual([expect.stringMatching(/^Höhenmodell/)]);
    expect(haversine(r.line[0], putIn)).toBeLessThan(150);
    expect(haversine(r.line[r.line.length - 1], takeOut)).toBeLessThan(150);
  });

  it("folgt mit Satellit den Mäandern statt dem geraden Talboden", async () => {
    const dem = await traceRiver(putIn, takeOut, { loader: valleyLoader, maxZoom: Z });
    const sat = await traceRiver(putIn, takeOut, { loader: valleyLoader, maxZoom: Z, water: sineWater });
    expect(sat.sources[0]).toBe("Sentinel-2 (Test)");
    expect(meanOffset(sat.line)).toBeLessThan(6);
    expect(meanOffset(dem.line)).toBeGreaterThan(30);
    expect(sat.shareWater).toBeGreaterThan(0.8);
  });

  it("bevorzugt OSM-Gewässerlinien", async () => {
    const osmLine: LngLat[] = [];
    for (let y = 40; y <= 700; y += 5) osmLine.push(pixToLngLat(OX + riverX(y) + 0.5, OY + y + 0.5));
    const r = await traceRiver(putIn, takeOut, { loader: valleyLoader, maxZoom: Z, waterways: async () => [{ name: "Test", coords: osmLine }] });
    expect(r.sources).toContain("OpenStreetMap");
    expect(r.shareOsm).toBeGreaterThan(0.8);
    expect(meanOffset(r.line)).toBeLessThan(4);
  });

  it("gibt die Linie in Klickreihenfolge zurück, auch wenn flussaufwärts geklickt wurde", async () => {
    const r = await traceRiver(takeOut, putIn, { loader: valleyLoader, maxZoom: Z, water: sineWater });
    expect(r.reversed).toBe(true);
    expect(haversine(r.line[0], takeOut)).toBeLessThan(150);
  });
});
