import { describe, expect, it } from "vitest";
import { analyzeRiver, classify, monotoneDecreasing, type ElevationFn } from "../src/analysis";
import { destination, haversine, type LngLat } from "../src/geo";

// Synthetisches Tal: Fluss nach Osten entlang 46° N. Höhe fällt flussabwärts,
// quer zum Fluss steigen die Hänge mit `wallSlope` (m pro m) an.
const origin: LngLat = [13, 46];
function valley(profile: (x: number) => number, wallSlope = 0.05): ElevationFn {
  return async (pts) =>
    pts.map((p) => {
      const x = haversine(origin, [p[0], origin[1]]);
      const y = haversine([p[0], origin[1]], p);
      return profile(x) + y * wallSlope;
    });
}
const straight = (km: number): LngLat[] => [origin, destination(origin, km * 1000, 90)];

describe("monotoneDecreasing", () => {
  it("lässt fallende Reihen unverändert", () => {
    expect(monotoneDecreasing([5, 4, 3, 3, 1])).toEqual([5, 4, 3, 3, 1]);
  });
  it("mittelt Verletzungen", () => {
    expect(monotoneDecreasing([5, 3, 4, 1])).toEqual([5, 3.5, 3.5, 1]);
  });
});

describe("classify", () => {
  it("ordnet Gefälle Klassen zu", () => {
    expect(classify(1).id).toBe("flat");
    expect(classify(10).id).toBe("marked");
    expect(classify(45).id).toBe("verysteep");
    expect(classify(100).id).toBe("extreme");
  });
});

describe("analyzeRiver", () => {
  it("misst konstantes Gefälle korrekt", async () => {
    const a = await analyzeRiver(straight(5), valley((x) => 500 - x * 0.01));
    expect(a.length).toBeCloseTo(5000, -1);
    expect(a.meanGradient).toBeCloseTo(10, 1);
    a.segments.forEach((s) => expect(s.gradient).toBeCloseTo(10, 1));
    expect(a.hotspots).toHaveLength(0);
    expect(a.reversed).toBe(false);
  });

  it("findet eine Steilstufe als Hotspot", async () => {
    // 3 km mit 5 m/km, dazwischen 300 m mit 80 m/km bei km 1,5
    const prof = (x: number) => 400 - x * 0.005 - Math.min(Math.max(x - 1500, 0), 300) * 0.075;
    const a = await analyzeRiver(straight(3), valley(prof));
    expect(a.hotspots.length).toBe(1);
    const h = a.hotspots[0];
    expect(h.d0).toBeGreaterThan(1200);
    expect(h.d1).toBeLessThan(2000);
    expect(h.maxGradient).toBeGreaterThan(60);
  });

  it("dreht eine flussaufwärts gezeichnete Linie um", async () => {
    const line = straight(2).reverse();
    const a = await analyzeRiver(line, valley((x) => 300 - x * 0.02));
    expect(a.reversed).toBe(true);
    expect(a.zStart).toBeGreaterThan(a.zEnd);
    expect(a.meanGradient).toBeCloseTo(20, 0);
  });

  it("ignoriert Ausreißer (Brücke) durch monotone Glättung", async () => {
    const a = await analyzeRiver(straight(2), valley((x) => (Math.abs(x - 1000) < 30 ? 330 : 300 - x * 0.005)));
    expect(a.hotspots).toHaveLength(0);
    expect(a.meanGradient).toBeCloseTo(5, 0);
  });

  it("erkennt Talengen an steilen Hängen", async () => {
    const flat = await analyzeRiver(straight(2), valley((x) => 300 - x * 0.005, 0.05));
    expect(flat.confinedLength).toBe(0);
    const gorge = await analyzeRiver(straight(2), valley((x) => 300 - x * 0.005, 0.6));
    expect(gorge.confinedLength).toBeCloseTo(gorge.length, -2);
  });
});

import { findSteps } from "../src/analysis";
describe("findSteps", () => {
  it("findet eine 20-m-Stufe, aber kein gleichmäßiges Gefälle", () => {
    const d = Array.from({ length: 81 }, (_, i) => i * 25); // 2 km
    const pts = d.map((x) => [13 + x * 1e-5, 46] as [number, number]);
    const even = d.map((x) => 300 - x * 0.02); // 20 m/km, keine Stufe
    expect(findSteps(d, even, pts, 25)).toHaveLength(0);
    const fall = d.map((x) => 300 - x * 0.005 - (x >= 1000 ? 20 : 0)); // 20-m-Fall bei km 1
    const st = findSteps(d, fall, pts, 25);
    expect(st).toHaveLength(1);
    expect(st[0].d0).toBeLessThanOrEqual(1000);
    expect(st[0].d1).toBeGreaterThanOrEqual(1000);
    expect(st[0].drop).toBeGreaterThan(19);
  });
});
