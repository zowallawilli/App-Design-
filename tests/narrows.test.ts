import { describe, expect, it } from "vitest";
import { analyzeNarrows, isRiverPixel, mergeGorges, riseDistance, stripWidth, type NarrowFeature } from "../src/narrows";
import type { ProfilePoint } from "../src/analysis";
import { destination, haversine, type LngLat } from "../src/geo";

describe("Hilfsfunktionen", () => {
  it("stripWidth misst den zusammenhängenden Streifen um die Mitte, kleine Lücken werden überbrückt", () => {
    const c = (s: string) => [...s].map((ch) => ch === "#");
    expect(stripWidth(c("....#####...."), 5)).toBe(25);
    expect(stripWidth(c("...##.###...."), 5)).toBe(30); // Lücke von 1
    expect(stripWidth(c("##.........##"), 5)).toBeNull(); // nichts nahe der Mitte
  });
  it("riseDistance", () => {
    expect(riseDistance([101, 103, 110, 125], 100, 5, 10)).toBe(30);
    expect(riseDistance([101, 102], 100, 20, 10)).toBe(20); // nie erreicht → ganze Länge
  });
  it("isRiverPixel", () => {
    expect(isRiverPixel(0.2, 0.1)).toBe(true);
    expect(isRiverPixel(-0.3, 0.2)).toBe(true); // Kies
    expect(isRiverPixel(-0.5, 0.8)).toBe(false); // Wald
    expect(isRiverPixel(NaN, NaN)).toBe(false);
  });
});

// Synthetischer Fluss nach Osten, 4 km. Querachse y (m, Norden positiv):
//  km 0–4:   Flussbett 50 m breit (|y| ≤ 25), …
//  km 1,0–1,1: Engstelle 15 m
//  km 2,0–2,4: Schlucht – Wände steigen ab |y| > 10 m mit 2 m/m
//  km 3,0–3,3: Fluss im Satellitenbild unsichtbar, Hänge steil (Klamm)
const O: LngLat = [13, 46];
const toXY = (p: LngLat) => {
  const x = haversine(O, [p[0], O[1]]);
  const y = haversine([p[0], O[1]], p) * (p[1] >= O[1] ? 1 : -1);
  return { x, y };
};
const elevation = async (pts: LngLat[]) =>
  pts.map((p) => {
    const { x, y } = toXY(p);
    const base = 500 - x * 0.01;
    const gorge = (x > 2000 && x < 2400) || (x > 3000 && x < 3300);
    return base + (gorge ? Math.max(0, Math.abs(y) - 10) * 2 : Math.max(0, Math.abs(y) - 150) * 0.3);
  });
const satellite = async (pts: LngLat[]) => {
  const ndwi = new Float32Array(pts.length), ndvi = new Float32Array(pts.length);
  pts.forEach((p, i) => {
    const { x, y } = toXY(p);
    const half = x > 1000 && x < 1100 ? 7.5 : 25;
    const hidden = x > 3000 && x < 3300;
    const river = !hidden && Math.abs(y) <= half;
    ndwi[i] = river ? 0.3 : -0.5;
    ndvi[i] = river ? 0.05 : 0.8;
  });
  return { ndwi, ndvi, label: "Test" };
};
const profile: ProfilePoint[] = [];
for (let d = 0; d <= 4000; d += 25) {
  const p = destination(O, d, 90);
  profile.push({ d, p, raw: 500 - d * 0.01, floor: 500 - d * 0.01, z: 500 - d * 0.01, walls: 0 });
}

describe("analyzeNarrows", () => {
  it("findet Engstelle, Schlucht und verdeckte Klamm an den richtigen Stellen", async () => {
    const r = await analyzeNarrows(profile, { elevations: elevation, satellite, demStep: 5, gorgeWidth: 60, gorgeDepth: 30 });
    const at = (k: string) => r.features.filter((f) => f.kind === k);
    expect(at("engstelle")).toHaveLength(1);
    expect(at("engstelle")[0].d0).toBeGreaterThanOrEqual(950);
    expect(at("engstelle")[0].d1).toBeLessThanOrEqual(1150);
    // Schlucht (km 2,0–2,4) und Klamm (km 3,0–3,3) liegen < 1 km auseinander → eine Strecke
    const gorges = r.features.filter((f) => f.kind !== "engstelle");
    expect(gorges).toHaveLength(1);
    expect(gorges[0].kind).toBe("klamm");
    expect(gorges[0].d0).toBeGreaterThanOrEqual(1950);
    expect(gorges[0].d1).toBeLessThanOrEqual(3350);
    // typische Breite ~50 m
    const normal = r.sections.find((s) => s.d === 500)!;
    expect(normal.width).toBeGreaterThanOrEqual(45);
    expect(normal.width).toBeLessThanOrEqual(55);
  });

  it("ohne Satellit: nur Schlucht aus dem Höhenmodell", async () => {
    const r = await analyzeNarrows(profile, { elevations: elevation, demStep: 5, gorgeWidth: 60, gorgeDepth: 30 });
    expect(r.satellite).toBeUndefined();
    expect(r.features.map((f) => f.kind)).toEqual(["schlucht"]);
    expect(r.features[0].d0).toBeGreaterThanOrEqual(1950);
  });
});

describe("mergeGorges", () => {
  const f = (kind: NarrowFeature["kind"], d0: number, d1: number): NarrowFeature => ({ kind, d0, d1, center: O, title: kind, detail: "" });
  it("fasst nahe Schlucht-/Klamm-Meldungen zusammen, Engstellen bleiben einzeln", () => {
    const out = mergeGorges([f("schlucht", 0, 100), f("engstelle", 200, 220), f("klamm", 600, 700), f("schlucht", 3000, 3100)], profile);
    expect(out.map((x) => [x.kind, x.d0, x.d1])).toEqual([["klamm", 0, 700], ["engstelle", 200, 220], ["schlucht", 3000, 3100]]);
  });
});
