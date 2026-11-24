import { describe, expect, it } from "vitest";
import { destination, haversine, lineLength, locateOnLine, resample, sliceLine, type LngLat } from "../src/geo";

describe("geo", () => {
  it("haversine: 1° Breite ≈ 111,2 km", () => {
    expect(haversine([10, 46], [10, 47]) / 1000).toBeCloseTo(111.2, 0);
  });

  it("destination ist Umkehrung von haversine", () => {
    const p: LngLat = [13.6, 46.3];
    const q = destination(p, 250, 73);
    expect(haversine(p, q)).toBeCloseTo(250, 3);
  });

  it("resample liefert gleichmäßige Stützpunkte inkl. Endpunkt", () => {
    const line: LngLat[] = [[13, 46], [13.01, 46], [13.01, 46.01]];
    const s = resample(line, 50);
    expect(s[0].p).toEqual(line[0]);
    expect(s[s.length - 1].d).toBeCloseTo(lineLength(line), 6);
    const steps = s.slice(1).map((x, i) => x.d - s[i].d);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-6);
  });

  it("locateOnLine und sliceLine", () => {
    const line: LngLat[] = [[13, 46], [13.02, 46]];
    const total = lineLength(line);
    const loc = locateOnLine(line, [13.01, 46.001]);
    expect(loc.d / total).toBeCloseTo(0.5, 2);
    expect(loc.offset).toBeCloseTo(111, -1);
    const part = sliceLine(line, total * 0.25, total * 0.75);
    expect(lineLength(part) / total).toBeCloseTo(0.5, 5);
  });
});
