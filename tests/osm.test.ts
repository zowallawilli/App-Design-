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

import { overpass, OVERPASS_URLS } from "../src/osm";

describe("overpass – gestaffelte Anfragen", () => {
  const ok = (id: number) => new Response(JSON.stringify({ elements: [{ type: "way", id }] }), { status: 200 });

  it("fragt nach Verzögerung den nächsten Server, wenn der erste hängt", async () => {
    const calls: string[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      calls.push(url);
      if (url === OVERPASS_URLS[0])
        return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("abort"), { name: "AbortError" }))));
      return Promise.resolve(ok(2));
    }) as unknown as typeof fetch;
    const t = Date.now();
    const els = await overpass("q-haengt", fetchFn, 50);
    expect(els[0].id).toBe(2);
    expect(calls).toEqual([OVERPASS_URLS[0], OVERPASS_URLS[1]]);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("wechselt bei Fehler sofort und meldet, wenn alle scheitern", async () => {
    let n = 0;
    const failing = (() => { n++; return Promise.resolve(new Response("busy", { status: 429 })); }) as unknown as typeof fetch;
    await expect(overpass("q-fehler", failing, 10_000)).rejects.toThrow(/nicht erreichbar/);
    expect(n).toBe(OVERPASS_URLS.length);
  });

  it("speichert Ergebnisse zwischen", async () => {
    let n = 0;
    const f = (() => { n++; return Promise.resolve(ok(7)); }) as unknown as typeof fetch;
    await overpass("q-cache", f);
    await overpass("q-cache", f);
    expect(n).toBe(1);
  });
});
