import { describe, expect, it } from "vitest";
import { analyzeRiver } from "../src/analysis";
import { toCsv, toGeoJson, toGpx } from "../src/export";
import { destination, type LngLat } from "../src/geo";

describe("export", async () => {
  const o: LngLat = [13, 46];
  const line = [o, destination(o, 2000, 90)];
  const a = await analyzeRiver(line, async (pts) => pts.map((p) => 500 - (p[0] - 13) * 1e5 * 0.03));
  it("GPX enthält Track mit Höhen", () => {
    const g = toGpx(a, "Test & Co");
    expect(g).toContain("<trkpt");
    expect(g).toContain("<ele>");
    expect(g).toContain("Test &amp; Co");
  });
  it("GPX hat Ein-/Ausstieg als Wegpunkte mit Höhe und ist gültiges XML-Gerüst", () => {
    const g = toGpx(a, "Fluss");
    expect(g).toMatch(/<wpt [^>]+>\s*<ele>[\d.]+<\/ele>\s*<name>Einstieg Fluss<\/name>/);
    expect(g).toContain("<name>Ausstieg Fluss</name>");
    expect((g.match(/<wpt /g) ?? []).length).toBe(2);
    expect((g.match(/<\/wpt>/g) ?? []).length).toBe(2);
    expect(g).not.toContain("\\n");
  });
  it("CSV hat Kopfzeile und eine Zeile je Abschnitt", () => {
    expect(toCsv(a).trim().split("\n")).toHaveLength(a.segments.length + 1);
  });
  it("GeoJSON ist gültig", () => {
    const j = JSON.parse(toGeoJson(a, "x"));
    expect(j.features.length).toBe(a.segments.length);
  });
});
