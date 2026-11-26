import { describe, expect, it } from "vitest";
import { osmGrade, placeKind, placesOnLine, placesQuery, type OsmEl } from "../src/osmPlaces";
import type { LngLat } from "../src/geo";

const line: LngLat[] = [[10.0, 47.0], [10.02, 47.0]]; // ~1,5 km nach Osten

describe("OSM-Stellen", () => {
  it("liest Grade in verschiedenen Schreibweisen", () => {
    expect(osmGrade("3")).toBe("III");
    expect(osmGrade("4+")).toBe("IV+");
    expect(osmGrade("II-III")).toBe("II–III");
    expect(osmGrade("2/3")).toBe("II–III");
    expect(osmGrade("schwer")).toBeUndefined();
    expect(osmGrade(undefined)).toBeUndefined();
  });

  it("ordnet Tags einer Art zu", () => {
    expect(placeKind({ whitewater: "rapid" })).toBe("rapid");
    expect(placeKind({ whitewater: "put_in;egress" })).toBe("access");
    expect(placeKind({ whitewater: "portage_way" })).toBe("portage");
    expect(placeKind({ waterway: "weir" })).toBe("weir");
    expect(placeKind({ waterway: "waterfall" })).toBe("waterfall");
    expect(placeKind({ waterway: "river" })).toBeNull();
  });

  it("nimmt nur Stellen nahe der Strecke, mit Stationierung, ohne Dubletten", () => {
    const els: OsmEl[] = [
      { type: "node", id: 1, lat: 47.0002, lon: 10.01, tags: { whitewater: "rapid", "whitewater:rapid_grade": "3", "whitewater:rapid_name": "Schiefes Eck" } },
      { type: "node", id: 2, lat: 47.0003, lon: 10.0101, tags: { whitewater: "rapid" } }, // Dublette (< 25 m)
      { type: "way", id: 3, center: { lat: 47.0, lon: 10.015 }, tags: { waterway: "weir", name: "Wehr Landeck" } },
      { type: "node", id: 4, lat: 47.0012, lon: 10.005, tags: { whitewater: "put_in" } }, // 130 m neben der Linie, Zugang
      { type: "node", id: 5, lat: 47.0012, lon: 10.006, tags: { waterway: "waterfall" } }, // 130 m – Flussobjekt zu weit weg
      { type: "node", id: 6, lat: 47.0, lon: 10.008, tags: { waterway: "river" } },
    ];
    const r = placesOnLine(els, line);
    expect(r.map((x) => x.id)).toEqual(["node/4", "node/1", "way/3"]);
    expect(r[1]).toMatchObject({ kind: "rapid", grade: "III", name: "Schiefes Eck" });
    expect(r[1].d).toBeGreaterThan(700);
    expect(r[1].d).toBeLessThan(820);
  });

  it("baut eine Overpass-Abfrage mit Puffer um die Strecke", () => {
    const q = placesQuery(line);
    expect(q).toContain('nwr["whitewater"]');
    expect(q).toMatch(/\(46\.997\d+,9\.99\d+,47\.002\d+,10\.02\d+\)/);
  });
});
