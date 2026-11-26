import { describe, expect, it } from "vitest";
import { ancestorCrop, availableIn, fallbackLevels } from "../src/esriTiles";

describe("Esri-Kacheln ohne Platzhalter", () => {
  it("liest die Tilemap-Antwort (Block und Einzelwert)", () => {
    const r = { data: [1, 0, 0, 1], location: { left: 10, top: 20, width: 2, height: 2 } };
    expect(availableIn(r, 10, 20)).toBe(true);
    expect(availableIn(r, 11, 20)).toBe(false);
    expect(availableIn(r, 10, 21)).toBe(false);
    expect(availableIn({ data: [0], location: { left: 0, top: 0, width: 1, height: 1 } }, 5, 5)).toBe(false);
    expect(availableIn(null, 1, 1)).toBe(true);
  });
  it("Ausschnitt der Vorfahren-Kachel", () => {
    expect(ancestorCrop(18, 188653, 95970, 1)).toEqual({ z: 17, x: 94326, y: 47985, sx: 128, sy: 0, size: 128 });
    expect(ancestorCrop(19, 7, 5, 2)).toMatchObject({ z: 17, x: 1, y: 1, sx: 192, sy: 64, size: 64 });
  });
  it("weicht auf die feinste vorhandene Stufe aus (Charyn: nur bis 17)", async () => {
    const fake = (async (url: string) => {
      const z = Number(/tilemap\/(\d+)\//.exec(url)![1]);
      return new Response(JSON.stringify({ data: [z <= 17 ? 1 : 0] }));
    }) as typeof fetch;
    expect(await fallbackLevels(19, 377306, 191941, fake)).toBe(2);
    expect(await fallbackLevels(17, 94326, 47985, fake)).toBe(0);
  });
});
