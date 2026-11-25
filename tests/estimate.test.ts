import { describe, expect, it } from "vitest";
import { applyEstimate, estimateFromNeighbours, type EstStation } from "../src/estimate";
// @ts-expect-error – Hilfsskript ohne Typen
import { updateArchive, reduceTirol, KEEP_DAYS } from "../scripts/tirol-mirror.mjs";

/** Tiroler Pegel am 25.11.2026 (Ausschnitt aus dem Spiegel) */
const TIROL: EstStation[] = [{"id":"201152","name":"Ehrwald (Viadukt)","river":"Loisach","lat":47.40783,"lon":10.91181,"area":88.4,"km":99.69,"q":1.03},{"id":"201392","name":"Huben","river":"Ötztaler Ache","lat":47.04381,"lon":10.97182,"area":517.2,"km":27.9,"q":4.51},{"id":"201624","name":"Innsbruck Reichenau","river":"Sill","lat":47.2729,"lon":11.41153,"area":854.4,"km":0.879,"q":12.26},{"id":"201525","name":"Innsbruck","river":"Inn","lat":47.26219,"lon":11.38083,"area":5771.6,"km":298.576,"q":84.2},{"id":"201178","name":"Kajetansbrücke","river":"Inn","lat":46.95219,"lon":10.51187,"area":2162,"km":407.26,"q":null},{"id":"202036","name":"Landeck Bruggen","river":"Sanna","lat":47.14338,"lon":10.5628,"area":727,"km":0.126,"q":5.45},{"id":"201293","name":"Landeck Perjen","river":"Inn","lat":47.14698,"lon":10.57136,"area":3503.1,"km":373.628,"q":11.45},{"id":"202101","name":"Nassereith (Wiesenmühle)","river":"Gurglbach (Pigerbach)","lat":47.30163,"lon":10.84138,"area":78.3,"km":13.042,"q":0.67},{"id":"201160","name":"Schalklhof","river":"Schalklbach","lat":46.93683,"lon":10.4905,"area":107.8,"km":0.07,"q":0.61},{"id":"201434","name":"Tumpen","river":"Ötztaler Ache","lat":47.16312,"lon":10.91052,"area":785.5,"km":12.104,"q":5.96},{"id":"201350","name":"Vent","river":"Rofenache","lat":46.85716,"lon":10.91089,"area":98.1,"km":0.09,"q":0.47},{"id":"201053","name":"Vorderhornbach (Brücke)","river":"Hornbach","lat":47.36863,"lon":10.53796,"area":64,"km":1.089,"q":1.87},{"id":"201319","name":"Imst (Bahnhof)","river":"Inn","lat":47.2186,"lon":10.75742,"area":3842,"km":354.875,"q":null},{"id":"201459","name":"Magerbach","river":"Inn","lat":47.25929,"lon":10.87587,"area":5118.8,"km":342.066,"q":null},{"id":"230078","name":"Telfs (Fußgängersteg)","river":"Inn","lat":47.3018,"lon":11.07302,"area":5289.7,"km":325.732,"q":null}];
const st = (name: string) => TIROL.find((s) => s.name === name)!;
const value = (id: string) => TIROL.find((s) => s.id === id)?.q;

describe("Abfluss aus Nachbarpegeln", () => {
  it("Inn bei Imst: Perjen (unterhalb der Sanna, Restwasser) + Bruggen wird nicht doppelt gezählt", () => {
    const e = estimateFromNeighbours(st("Imst (Bahnhof)"), TIROL)!;
    const q = applyEstimate(e, value)!;
    // Landeck Bruggen (Sanna) liegt im Einzugsgebiet von Landeck Perjen → nie zusätzlich addiert
    expect(e.terms.map((t) => t.name)).not.toContain("Landeck Bruggen");
    expect(e.terms.map((t) => t.name)).not.toContain("Innsbruck Reichenau"); // Sill mündet unterhalb des Pegels Innsbruck
    // Perjen liefert nur Restwasser (Kraftwerk Imst leitet bei Runserau aus) → Schätzung von unterhalb
    expect(e.method).toBe("unterhalb");
    expect(e.note).toContain("Kraftwerksausleitung");
    expect(q).toBeGreaterThan(30);
    expect(q).toBeLessThan(80);
  });

  it("Magerbach: Schätzung liegt zwischen Imst und Innsbruck", () => {
    const e = estimateFromNeighbours(st("Magerbach"), TIROL)!;
    const q = applyEstimate(e, value)!;
    const qi = applyEstimate(estimateFromNeighbours(st("Imst (Bahnhof)"), TIROL)!, value)!;
    expect(q).toBeGreaterThan(qi);
    expect(q).toBeLessThan(st("Innsbruck").q!);
  });

  it("ohne Ausleitung: Summe der Pegel oberhalb (Hauptfluss + Zubringer)", () => {
    const up: EstStation = { id: "u", name: "Oben", river: "X", lat: 47, lon: 10, area: 400, km: 20, q: 10 };
    const trib: EstStation = { id: "t", name: "Bach", river: "Y", lat: 47.02, lon: 10.06, area: 100, km: 3, q: 3 };
    const target: EstStation = { id: "z", name: "Ziel", river: "X", lat: 47, lon: 10.1, area: 520, km: 10, q: null };
    const down: EstStation = { id: "d", name: "Unten", river: "X", lat: 47, lon: 10.2, area: 700, km: 0, q: 17 };
    const e = estimateFromNeighbours(target, [up, trib, target, down])!;
    expect(e.method).toBe("oberhalb");
    expect(e.label).toContain("Oben + Bach");
    expect(applyEstimate(e, (id) => [up, trib, down].find((s) => s.id === id)?.q)).toBeCloseTo(13 * 520 / 500, 5);
  });
});

describe("Tiroler Archiv", () => {
  const st0 = { id: "1", name: "P", q: 5, time: "2026-11-25T10:00:00.000Z", dayMean: 4.8, dayMeanDate: "2026-11-24" };
  it("Tagesmittel und eigenes Mittel, jeder 15-min-Wert nur einmal", () => {
    let a = updateArchive(null, st0, "2026-11-25");
    a = updateArchive(a, st0, "2026-11-25"); // gleicher Zeitstempel → nicht doppelt
    a = updateArchive(a, { ...st0, q: 7, time: "2026-11-25T10:30:00.000Z" }, "2026-11-25");
    expect(a.dm["2026-11-24"]).toBe(4.8);
    expect(a.s["2026-11-25"]).toEqual([6, 2]);
  });
  it("hält höchstens KEEP_DAYS Tage", () => {
    const a = updateArchive({ dm: { "2020-01-01": 1, "2026-11-01": 2 }, s: { "2020-01-01": [1, 48] } }, st0, "2026-11-25");
    expect(Object.keys(a.dm)).toEqual(["2026-11-01", "2026-11-24"]);
    expect(a.s["2020-01-01"]).toBeUndefined();
    expect(KEEP_DAYS).toBeLessThanOrEqual(400);
  });
  it("übernimmt Einzugsgebiet und Flusskilometer, Q-Tagesmittel mit Tag des Zeitstempels", () => {
    const r = reduceTirol([{ number: "9", name: "X", latlng: [47, 10], CATCHMENT_NATURAL_SIZE: 100, Flusskilometer: 5, altitude: 700,
      values: { Q: { "15m.Cmd.HD": { v: 3, dt: 1795619700000 }, "Day.Mean": { v: 2.5, dt: 1795474800000 } } } }]);
    expect(r.stations[0]).toMatchObject({ area: 100, km: 5, q: 3, dayMean: 2.5, dayMeanDate: "2026-11-24" });
  });
});
