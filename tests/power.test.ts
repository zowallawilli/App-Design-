import { describe, expect, it } from "vitest";
import { powerClassIndex, RATED_CLASSES, rateAnalysis, streamPower, waveVelocity } from "../src/power";
import { classify, type Analysis } from "../src/analysis";

describe("Wucht-Bewertung", () => {
  it("Strömungsleistung und Klassen an Referenzflüssen", () => {
    expect(Math.round(streamPower(12.7, 2.9))).toBe(361); // Nahe: WW I
    expect(RATED_CLASSES[powerClassIndex(streamPower(12.7, 2.9))].label).toBe("WW I");
    expect(RATED_CLASSES[powerClassIndex(streamPower(137, 3.9))].label).toBe("WW II–III"); // Markarfljót Sommer
    expect(powerClassIndex(100)).toBe(0); // Zahmwasser
  });

  it("kombiniert: die schwierigere Einstufung gewinnt", () => {
    const seg = (g: number) => ({ index: 0, d0: 0, d1: 1000, z0: 0, z1: 0, gradient: g, cls: classify(g), confined: false, coords: [] });
    const a = { segments: [seg(3.9), seg(20)], classShare: [] } as unknown as Analysis;
    const r = rateAnalysis(a, "combined", 137); // viel Wasser
    expect(r.segments[0].cls.id).toBe("steep"); // flach, aber Wucht → WW II–III
    expect(rateAnalysis(a, "combined", 0.5).segments[1].cls.id).toBe("steep"); // wenig Wasser: Gefälle zählt
    expect(rateAnalysis(a, "gradient", 137)).toBe(a);
  });

  it("Wellenabstand → Fließgeschwindigkeit", () => {
    expect(waveVelocity(4).toFixed(2)).toBe("2.50"); // 4 m Wellen ≈ 2,5 m/s
    expect(waveVelocity(10).toFixed(2)).toBe("3.95");
  });
});
