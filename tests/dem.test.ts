import { describe, expect, it } from "vitest";
import { compositeTileLoader, inNorwayBox, kartverketBreaker, kartverketUrl, terrariumAnyZoom, tileLngLatBounds, type TileLoader } from "../src/dem";

const flat = (v: number): TileLoader => async () => new Float32Array(256 * 256).fill(v);

describe("Kartverket-Anbindung", () => {
  it("baut eine WCS-Anfrage in EPSG:3857 mit auf cm gerundeten Koordinaten und ohne INTERPOLATION", () => {
    const u = kartverketUrl(13, 4313, 2297);
    expect(u).toContain("RESPONSE_CRS=EPSG:3857");
    expect(u).not.toContain("INTERPOLATION");
    const bbox = u.split("BBOX=")[1].split(",");
    expect(bbox).toHaveLength(4);
    bbox.forEach((v) => expect(v).toMatch(/^-?\d+\.\d{2}$/));
  });

  it("erkennt norwegische Kacheln", () => {
    expect(inNorwayBox(tileLngLatBounds(13, 4313, 2297))).toBe(true); // Sjoa
    expect(inNorwayBox(tileLngLatBounds(13, 4405, 2915))).toBe(false); // Soča
  });

  it("fällt außerhalb Norwegens und bei Störung auf das globale Modell zurück", async () => {
    let calls = 0;
    const failing = (async () => { calls++; return new Response("The service is unavailable.", { status: 503 }); }) as unknown as typeof fetch;
    kartverketBreaker.openUntil = 0;
    kartverketBreaker.failures = 0;
    const l = compositeTileLoader("auto", flat(42), failing);
    const t = await l(13, 4313, 2297);
    expect(t[0]).toBe(42);
    expect(calls).toBe(2); // ein Wiederholversuch
    const out = await compositeTileLoader("auto", flat(7), failing)(13, 4405, 2915);
    expect(out[0]).toBe(7);
    expect(calls).toBe(2); // außerhalb Norwegens keine Anfrage
  }, 10000);

  it("Schutzschalter: nach drei Fehlern keine weiteren Anfragen", async () => {
    let calls = 0;
    const failing = (async () => { calls++; throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    kartverketBreaker.openUntil = 0;
    kartverketBreaker.failures = 0;
    const l = compositeTileLoader("auto", flat(1), failing);
    for (let i = 0; i < 6; i++) await l(13, 4313 + i, 2297);
    expect(calls).toBe(3);
    kartverketBreaker.openUntil = 0;
  });

  it("rechnet Terrarium über Zoom 15 hinaus aus der Elternkachel hoch", async () => {
    const parent: TileLoader = async () => Float32Array.from({ length: 256 * 256 }, (_, i) => i % 256);
    const t = await terrariumAnyZoom(parent)(16, 1, 0); // rechte obere Viertelkachel
    expect(t[0]).toBeGreaterThan(127);
    expect(t[255]).toBeGreaterThan(250);
  });
});
