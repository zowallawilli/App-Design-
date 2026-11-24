import { describe, expect, it } from "vitest";
import { chainWays, type OsmWay } from "../src/osm";

const way = (id: number, nodes: number[], name = "Soča", waterway = "river"): OsmWay => ({
  id,
  nodes,
  coords: nodes.map((n) => [13 + n * 0.001, 46]),
  tags: { name, waterway },
});

describe("chainWays", () => {
  it("verkettet Wege in Fließrichtung, bevorzugt Hauptarm", () => {
    const ways = [
      way(1, [1, 2, 3]),
      way(2, [3, 4, 5]),
      way(3, [5, 6]),
      way(4, [3, 9, 5], "Nebenarm", "stream"), // Nebenarm
      way(5, [0, 1]),
    ];
    const line = chainWays(ways, 2);
    expect(line.map((c) => Math.round((c[0] - 13) * 1000))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("bricht bei Zyklen ab", () => {
    const ways = [way(1, [1, 2]), way(2, [2, 1])];
    expect(chainWays(ways, 1).length).toBe(3);
  });
});

describe("chainWays mit falsch digitalisierten Wegen", () => {
  it("hängt gleichnamige, umgekehrt gezeichnete Wege richtig an", () => {
    const ways = [way(1, [1, 2, 3]), way(2, [5, 4, 3]), way(3, [5, 6])];
    const line = chainWays(ways, 1);
    expect(line.map((c) => Math.round((c[0] - 13) * 1000))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("dreht keine fremden Gewässer um", () => {
    const ways = [way(1, [1, 2, 3]), way(2, [5, 4, 3], "Bach", "stream")];
    expect(chainWays(ways, 1)).toHaveLength(3);
  });
});
