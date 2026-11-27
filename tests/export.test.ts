import { describe, expect, it } from "vitest";
import { analyzeRiver } from "../src/analysis";
import { garminColor, stretches, toCsv, toGeoJson, toGpx } from "../src/export";
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
    const g = toGpx(a, "Fluss", undefined, [], [], { steep: false });
    expect(g).toMatch(/<wpt [^>]+>\s*<ele>[\d.]+<\/ele>\s*<name>Einstieg Fluss<\/name>/);
    expect(g).toContain("<name>Ausstieg Fluss</name>");
    expect((g.match(/<wpt /g) ?? []).length).toBe(2);
    expect((g.match(/<\/wpt>/g) ?? []).length).toBe(2);
    expect(g).not.toContain("\\n");
  });
  it("eigene und OSM-Stellen erscheinen als Wegpunkte und im GeoJSON", () => {
    const pl = [
      { d: 500, center: destination(o, 500, 90), title: "Umtragen km 0.50", text: "Eigene Stelle: Umtragen – links", sym: "Trail Head", type: "Eigene Stelle", source: "eigene" as const, kind: "umtragen" },
      { d: 1200, center: destination(o, 1200, 90), title: "Wehr km 1.20 (OSM)", text: "Wehr – aus OpenStreetMap, nicht geprüft", sym: "Danger Area", type: "OSM, nicht geprüft", source: "osm" as const, kind: "weir" },
    ];
    const g = toGpx(a, "Fluss", undefined, [], [], { steep: false }, pl);
    expect((g.match(/<wpt /g) ?? []).length).toBe(4);
    expect(g).toContain("<name>Wehr km 1.20 (OSM)</name>");
    expect(g).toContain("<type>OSM, nicht geprüft</type>");
    const j = JSON.parse(toGeoJson(a, "x", undefined, [], [], pl));
    expect(j.features.filter((f: { properties: { source?: string } }) => f.properties.source).map((f: { properties: { kind: string } }) => f.properties.kind)).toEqual(["umtragen", "weir"]);
  });
  it("Tour-GPX: eigene Stellen als Wegpunkte, kein höchster Punkt, keine Pfeil-Sonderzeichen", async () => {
    const { toTourGpx } = await import("../src/export");
    const g = toTourGpx(
      [
        { name: "1 Fluss", type: "Packrafting", pts: a.profile.map((q) => ({ p: q.p, z: q.z })) },
        { name: "2 Weg A → B", type: "Wandern", pts: a.profile.slice(0, 5).map((q) => ({ p: q.p, z: q.z })), desc: "1,2 km, ↑ 100 m" },
      ],
      [{ p: o, z: 500, name: "Lagerplatz", desc: "Eigene Stelle: Lagerplatz – Kiesbank", sym: "Campground", type: "Eigene Stelle" }, { p: o, name: "Notiz", desc: "ohne Höhe", sym: "Flag, Blue", type: "Eigene Stelle" }],
    );
    expect(g).toContain("<name>Lagerplatz</name>");
    expect(g).toContain("<sym>Campground</sym>");
    expect(g).not.toMatch(/Höchster Punkt|Summit/);
    expect(g).not.toMatch(/[→↑↓]/);
    expect(g).toContain("2 Weg A nach B");
    expect((g.match(/<wpt /g) ?? []).length).toBe(4); // Ein-/Ausstieg Fluss + 2 eigene Stellen
  });
  it("CSV hat Kopfzeile und eine Zeile je Abschnitt", () => {
    expect(toCsv(a).trim().split("\n")).toHaveLength(a.segments.length + 1);
  });
  it("GeoJSON ist gültig", () => {
    const j = JSON.parse(toGeoJson(a, "x"));
    expect(j.features.length).toBe(a.segments.length);
  });
  it("GPX ohne steile Abschnitte: nur ein Track", () => {
    // Testprofil hat überall ~30 m/km? Schwelle so hoch, dass nichts steil ist
    const g = toGpx(a, "Fluss", undefined, [], [], { steepFrom: 1000 });
    expect((g.match(/<trk>/g) ?? []).length).toBe(1);
    expect(g).toContain("<gpxx:DisplayColor>");
  });
});

describe("GPX: steile Abschnitte und Teilung nach Gefälle", async () => {
  const o: LngLat = [13, 46];
  const line = [o, destination(o, 3000, 90)];
  // 0–1 km flach (2 m/km), 1–2 km steil (40 m/km), 2–3 km flach
  const z = (p: LngLat) => {
    const x = (p[0] - 13) * 1e5 * 0.7; // ~m nach Osten
    return 500 - Math.min(x, 1000) * 0.002 - Math.max(0, Math.min(x, 2000) - 1000) * 0.04 - Math.max(0, x - 2000) * 0.002;
  };
  const a = await analyzeRiver(line, async (pts) => pts.map(z));
  it("fasst steile Abschnitte zusammen", () => {
    const st = stretches(a, { minGradient: 15 });
    expect(st.length).toBe(1);
    expect(st[0].d0).toBeGreaterThan(500);
    expect(st[0].d1).toBeLessThan(2600);
  });
  it("exportiert Steilstrecke als eigenen Track + Wegpunkt", () => {
    const g = toGpx(a, "Fluss");
    expect((g.match(/<trk>/g) ?? []).length).toBe(2);
    expect(g).toMatch(/<name>Steil km [\d,]+–[\d,]+ · \d+ m\/km<\/name>/);
    expect(g).toContain("<type>Steilstrecke</type>");
  });
  it("teilt die ganze Strecke nach Gefälleklassen", () => {
    const g = toGpx(a, "Fluss", undefined, [], [], { split: true, kmMarks: true });
    expect((g.match(/<trk>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(g).toContain("<name>km 1</name>");
  });
  it("Garmin-Farben benannt", () => {
    expect(garminColor("#b2182b")).toMatch(/Red/);
    expect(garminColor("#2b83ba")).toMatch(/Blue|Cyan/);
  });
});
