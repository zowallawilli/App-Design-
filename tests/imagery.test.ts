import { describe, expect, it } from "vitest";
import { imageryAt } from "../src/imagery";

/** Esri-Metadaten: grob (bis Stufe 13) ein Winterbild, fein (bis Stufe 20) ein Sommerbild */
const fake = (async (url: string) => {
  const body = /\?f=json$/.test(url)
    ? { services: [{ name: "World_Imagery_Metadata_2024_r01" }] }
    : /\/MapServer\/(\d+)\/query/.test(url)
      ? {
          features: Number(/\/MapServer\/(\d+)\//.exec(url)![1]) <= 4
            ? [{ attributes: { SRC_DATE: 20240806, SRC_RES: 0.3, NICE_NAME: "Vivid", NICE_DESC: "Vantor", MinMapLevel: 14, MaxMapLevel: 20, DrawOrder: 5 } }]
            : [{ attributes: { SRC_DATE: 20210315, SRC_RES: 10, NICE_NAME: "Sentinel", NICE_DESC: "Esri", MinMapLevel: 0, MaxMapLevel: 13, DrawOrder: 9 } }],
        }
      : {};
  return new Response(JSON.stringify(body));
}) as unknown as typeof fetch;

describe("Bild-Metadaten", () => {
  it("Referenz = Bild der feinsten Stufe (stärkste Vergrößerung), nicht das grobe Übersichtsbild", async () => {
    expect((await imageryAt([14.8, 66.7], "max", fake))?.date).toBe("2024-08-06");
    expect((await imageryAt([14.8, 66.7], 12, fake))?.date).toBe("2021-03-15");
  });
});
