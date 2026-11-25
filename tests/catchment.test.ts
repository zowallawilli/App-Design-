import { describe, expect, it } from "vitest";
import { areaFromLength, catchmentFromRivers } from "../src/catchment";
import type { RiverLine } from "../src/vectorWater";

type P = [number, number];
const seg = (a: P, b: P, n = 20): P[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const river = (name: string, ...pts: P[]): RiverLine => ({ name, kind: "river", coords: pts.slice(1).flatMap((p, i) => seg(pts[i], p).slice(i ? 1 : 0)) });

describe("Einzugsgebiet oberhalb", () => {
  // Sanna-ähnlich: entsteht am Einstieg aus Rosanna + Trisanna, mündet am Ausstieg in den Inn
  const putIn: P = [10.49, 47.12], takeOut: P = [10.56, 47.14];
  const route = seg(putIn, takeOut, 30);
  const rivers: RiverLine[] = [
    river("Sanna", putIn, takeOut),
    river("Rosanna", [10.2, 47.13], putIn),
    river("Trisanna", [10.25, 46.97], [10.4, 47.05], putIn),
    river("Inn", [10.66, 47.07], takeOut, [10.75, 47.22]),
  ];
  it("Zubringer oberhalb zählen, der Fluss am Ausstieg nicht", () => {
    const c = catchmentFromRivers(route, rivers, [{ name: "Speicher Kops", p: [10.3, 47.0] }]);
    expect(c.river).toBe("Sanna");
    expect(c.tributaries.sort()).toEqual(["Rosanna", "Trisanna"]);
    expect(c.points.length).toBeGreaterThanOrEqual(3);
    expect(c.fallback).toBe(false);
  });

  it("folgt dem Fluss auch, wenn er im Bogen zurückkommt (Soča bei Bovec)", () => {
    // Fluss kommt von Norden, biegt zum Einstieg und fließt dann nach Osten zum Ausstieg
    const a: P = [13.5, 46.3], b: P = [13.56, 46.28];
    const soca = river("Soča", [13.75, 46.42], [13.55, 46.33], a, b);
    const c = catchmentFromRivers(seg(a, b, 30), [soca]);
    expect(c.upstreamKm).toBeGreaterThan(20);
  });

  it("ohne erkennbaren Fluss: Umkreis um den Einstieg", () => {
    const c = catchmentFromRivers(route, []);
    expect(c.fallback).toBe(true);
    expect(c.points).toHaveLength(5);
  });

  it("Fläche aus Flusslänge in plausibler Größenordnung", () => {
    expect(areaFromLength(40)).toBeGreaterThan(150);
    expect(areaFromLength(40)).toBeLessThan(600);
  });
});
