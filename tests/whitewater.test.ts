import { describe, expect, it } from "vitest";
import {
  ACROSS, ALONG, bendAt, DEFAULT_PARAMS, describeSpots, findSpots, fitParams, HALF_WIDTH, isWaterLike, isWhite, labelFeature,
  ORTHO_SOURCES, orthoSourceFor, whitewaterProfile, type Strip,
} from "../src/whitewater";
import { imageUsable, SENSITIVITY_DEFAULT, tunedParams, typicalWidth, widthFactor } from "../src/whitewater";
import { centerWhite, DEFAULT_BREAK, findBreaklines, SPRAY_MAX_TEXTURE, sprayTexture } from "../src/whitewater";
import { exportJson, mergeLabels, parseImport } from "../src/whitewaterStore";
import type { LngLat } from "../src/geo";

/** Gerader Fluss nach Osten, 20 m breit, ruhiges Wasser; optional körniges Weißwasser zwischen d0 und d1. */
function synthStrip(len: number, white?: [number, number], calmBright = false): Strip {
  const rows = Math.round(len / ALONG) + 1, cols = Math.round((2 * HALF_WIDTH) / ACROSS) + 1;
  const rgb = new Uint8Array(rows * cols * 3), valid = new Uint8Array(rows * cols).fill(1);
  const d = new Float64Array(rows), p: LngLat[] = [];
  for (let i = 0; i < rows; i++) {
    d[i] = i * ALONG;
    p.push([10 + (i * ALONG) / 75800, 47]);
    for (let c = 0; c < cols; c++) {
      const o = -HALF_WIDTH + c * ACROSS, k = (i * cols + c) * 3;
      let px: [number, number, number] = [60, 90, 40]; // Wald/Ufer
      if (Math.abs(o) <= 10) {
        px = calmBright ? [190, 205, 210] : [60, 110, 120];
        if (white && d[i] >= white[0] && d[i] <= white[1] && (i + c) % 2 === 0) px = [228, 232, 236];
      }
      rgb.set(px, k);
    }
  }
  return { rows, cols, rgb, valid, d, p };
}

describe("Pixelklassen", () => {
  it("erkennt Wasser, Weißwasser, Vegetation und Kies", () => {
    expect(isWaterLike(60, 110, 120)).toBe(true); // türkis
    expect(isWaterLike(60, 90, 40)).toBe(false); // Wald
    expect(isWaterLike(180, 170, 150)).toBe(false); // Kies (warm)
    expect(isWhite(228, 232, 236, 170)).toBe(true);
    expect(isWhite(228, 210, 160, 150)).toBe(false); // gelblich
    expect(isWhite(140, 150, 155, 150)).toBe(false); // zu dunkel
  });
});

describe("Weißwasserprofil und Schwallstellen", () => {
  it("findet körniges Weißwasser als Schwallstelle", () => {
    const strip = synthStrip(400, [150, 210]);
    const prof = whitewaterProfile(strip);
    const spots = findSpots(prof.bins, DEFAULT_PARAMS);
    expect(spots).toHaveLength(1);
    expect(spots[0].d0).toBeGreaterThanOrEqual(120);
    expect(spots[0].d1).toBeLessThanOrEqual(240);
    expect(spots[0].peakDensity).toBeGreaterThan(DEFAULT_PARAMS.spotDensity);
    const w = prof.bins.find((b) => b.d === 300)!.width!;
    expect(w).toBeGreaterThan(17);
    expect(w).toBeLessThan(23);
  });

  it("glatter, dichter Schaum quer über den Fluss (Querband/Walze) wird erkannt, lange helle Kiesbank nicht", () => {
    const paint = (strip: Strip, d0: number, d1: number, o0: number, o1: number) => {
      for (let i = 0; i < strip.rows; i++) for (let c = 0; c < strip.cols; c++) {
        const o = -HALF_WIDTH + c * ACROSS;
        if (strip.d[i] >= d0 && strip.d[i] <= d1 && o >= o0 && o <= o1) strip.rgb.set([226, 230, 233], (i * strip.cols + c) * 3);
      }
      return strip;
    };
    const band = paint(synthStrip(400), 190, 210, -10, 10);
    const spots = findSpots(whitewaterProfile(band).bins, DEFAULT_PARAMS);
    expect(spots).toHaveLength(1);
    expect(spots[0].d0).toBeLessThanOrEqual(210);
    expect(spots[0].d1).toBeGreaterThanOrEqual(190);
    // Kiesbank: 300 m lang am Rand, gleiche Farbe, aber flussauf/-ab kein Wasser in denselben Spalten
    expect(findSpots(whitewaterProfile(paint(synthStrip(400), 50, 350, 3, 10)).bins)).toHaveLength(0);
  });

  it("ruhiges Wasser – auch hell und glatt (Kalkgrund, Gletschertrübe) – ergibt keine Stelle", () => {
    expect(findSpots(whitewaterProfile(synthStrip(400)).bins)).toHaveLength(0);
    expect(findSpots(whitewaterProfile(synthStrip(400, undefined, true)).bins)).toHaveLength(0);
  });

  it("kennzeichnet Weißwasser an einer Abbruchkante", () => {
    const strip = synthStrip(400, [150, 210]);
    const prof = whitewaterProfile(strip);
    const [s] = describeSpots(findSpots(prof.bins), strip, prof.bins, { steps: [{ d0: 170, d1: 230 }], gradientAt: () => 45 });
    expect(s.hazard).toBe(true);
    expect(s.notes.join(" ")).toMatch(/Abbruchkante/);
    expect(s.notes.join(" ")).toMatch(/45 m\/km/);
  });
});

describe("Kurven", () => {
  it("misst eine 90°-Kurve", () => {
    const p: LngLat[] = [], d: number[] = [];
    for (let i = 0; i <= 200; i++) {
      d.push(i);
      p.push(i <= 100 ? [10 + i / 75800, 47] : [10 + 100 / 75800, 47 - (i - 100) / 111000]);
    }
    expect(bendAt({ d: Float64Array.from(d), p }, 100)).toBeGreaterThan(80);
    expect(bendAt({ d: Float64Array.from(d), p }, 30)).toBeLessThan(5);
  });
});

describe("Lernen aus Markierungen", () => {
  it("legt die Schwelle zwischen Schwall- und ruhige Markierungen", () => {
    const t = fitParams([{ f: 8, schwall: true }, { f: 7, schwall: true }, { f: 2, schwall: false }, { f: 3, schwall: false }]).spotDensity;
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(7);
  });
  it("senkt die Schwelle, wenn eine bekannte Stelle bisher übersehen wird", () => {
    expect(fitParams([{ f: 3.5, schwall: true }]).spotDensity).toBeLessThan(3.5);
  });
  it("Merkmal ist die höchste Dichte im Umkreis", () => {
    const prof = whitewaterProfile(synthStrip(400, [150, 210]));
    expect(labelFeature(prof.bins, 180)).toBeGreaterThan(5);
    expect(labelFeature(prof.bins, 350)).toBe(0);
  });
});

describe("Bildquellen", () => {
  it("wählt die offene Quelle nach Land", () => {
    expect(orthoSourceFor([[10.49, 47.12], [10.52, 47.13], [10.56, 47.14]])?.id).toBe("basemap-at");
    expect(orthoSourceFor([[13.50, 46.29], [13.53, 46.288], [13.55, 46.28]])?.id).toBe("gurs-dof2023");
    expect(orthoSourceFor([[9.17, 61.70], [9.24, 61.73], [9.30, 61.75]])).toBeNull(); // Sjoa: keine offene Quelle
  });
  it("NAIP für die USA (Colorado), nicht für Kanada oder Mexiko", () => {
    const naip = (p: LngLat) => orthoSourceFor([p, p, p])?.id;
    expect(naip([-106.06, 38.75])).toBe("naip");
    expect(naip([-123.1, 49.3])).toBeUndefined(); // Vancouver
    expect(naip([-99.1, 19.4])).toBeUndefined(); // Mexiko-Stadt
    const src = ORTHO_SOURCES.find((s) => s.id === "naip")!;
    expect(src.tileUrl(1, 2)).toMatch(/^https:\/\/imagery\.nationalmap\.gov\/.*exportImage\?bbox=.*size=256,256/);
  });

  it("rechnet GURS-Kacheln (EPSG:3794) richtig", () => {
    const s = ORTHO_SOURCES.find((x) => x.id === "gurs-dof2023")!;
    const [x, y] = s.toPixel([13.53, 46.287]);
    expect(Math.floor(x / 256)).toBe(81338);
    expect(Math.floor(y / 256)).toBe(71937);
  });
});

describe("Markierungen exportieren/importieren", () => {
  it("Rundreise und Zusammenführen", () => {
    const labels = [{ p: [10.5, 47.1] as LngLat, schwall: true }, { p: [10.6, 47.2] as LngLat, schwall: false }];
    const imp = parseImport(exportJson(labels, { ...DEFAULT_PARAMS, spotDensity: 4.2 }));
    expect(imp.labels).toHaveLength(2);
    expect(imp.params?.spotDensity).toBe(4.2);
    const merged = mergeLabels(labels, [{ p: [10.50001, 47.10001], schwall: false }]);
    expect(merged).toHaveLength(2);
    expect(merged[0].schwall).toBe(false);
    expect(() => parseImport(JSON.stringify({ format: "anders" }))).toThrow();
  });
});

/** Fluss mit Gischt ab `from` m (ganze Flussmitte weiß); `ramp` > 0 = allmählich zunehmend. */
function sprayStrip(len: number, from: number, ramp = 0): Strip {
  const s = synthStrip(len);
  for (let i = 0; i < s.rows; i++) {
    const f = ramp ? Math.max(0, Math.min(1, (s.d[i] - from) / ramp)) : s.d[i] >= from ? 1 : 0;
    for (let c = 0; c < s.cols; c++) {
      const o = -HALF_WIDTH + c * ACROSS;
      if (Math.abs(o) <= 10 && ((i * 7 + c * 13) % 100) / 100 < f) s.rgb.set([235, 238, 240], (i * s.cols + c) * 3);
    }
  }
  return s;
}

describe("Abbruchkanten (Gefahrenstellen)", () => {
  const fall = (dFall: number, h: number) => (d: number) => 500 - d * 0.01 - (d > dFall ? h : 0);
  it("Gischt setzt schlagartig ein + Höhenverlust → Abbruchkante", () => {
    const bl = findBreaklines(sprayStrip(600, 300), fall(295, 15));
    expect(bl).toHaveLength(1);
    expect(Math.abs(bl[0].d - 300)).toBeLessThan(20);
    expect(bl[0].drop).toBeGreaterThan(14);
    expect(bl[0].confidence).toBe("deutlich");
  });
  it("gleiche Kante ohne Höhenverlust (Schwall) → keine Gefahrenstelle", () => {
    expect(findBreaklines(sprayStrip(600, 300), fall(295, 0))).toHaveLength(0);
  });
  it("Höhenverlust ohne Kante im Bild (Höhenmodell-Artefakt) → keine Gefahrenstelle", () => {
    expect(findBreaklines(synthStrip(600), fall(295, 30))).toHaveLength(0);
  });
  it("körnige helle Fläche (Kiesbank am Schattenrand) ist keine Kante, auch mit Höhenverlust", () => {
    const s = synthStrip(600);
    for (let i = 0; i < s.rows; i++) for (let c = 0; c < s.cols; c++) {
      const o = -HALF_WIDTH + c * ACROSS;
      if (Math.abs(o) <= 10 && s.d[i] >= 300) { const v = (i * 7 + c * 13) % 5 === 0 ? 120 : 200 + ((i * 3 + c * 5) % 4) * 12; s.rgb.set([v + 3, v + 2, v], (i * s.cols + c) * 3); }
    }
    expect(sprayTexture(s, 300, 330)).toBeGreaterThan(SPRAY_MAX_TEXTURE);
    expect(findBreaklines(s, fall(295, 15))).toHaveLength(0);
    expect(sprayTexture(sprayStrip(600, 300), 300, 330)).toBeLessThan(SPRAY_MAX_TEXTURE);
  });
  it("allmählich zunehmendes Weißwasser ist keine Kante", () => {
    expect(findBreaklines(sprayStrip(600, 200, 250), fall(295, 15))).toHaveLength(0);
  });
  it("Weißanteil der Flussmitte", () => {
    const w = centerWhite(sprayStrip(400, 200));
    expect(w[100]).toBe(0);
    expect(w[300]).toBeGreaterThan(0.5);
    expect(DEFAULT_BREAK.minDrop).toBe(8);
  });
});

describe("Empfindlichkeit und Flussbreite", () => {
  it("Standardstufe bei Bezugsbreite = Standardschwellen; Regler und Breite wirken in die erwartete Richtung", () => {
    expect(tunedParams(DEFAULT_PARAMS, SENSITIVITY_DEFAULT, 25)).toEqual(DEFAULT_PARAMS);
    expect(tunedParams(DEFAULT_PARAMS, 1, 25).spotDensity).toBeCloseTo(DEFAULT_PARAMS.spotDensity * 2, 6);
    expect(tunedParams(DEFAULT_PARAMS, 9, 25).spotDensity).toBeCloseTo(DEFAULT_PARAMS.spotDensity / 2, 6);
    expect(tunedParams(DEFAULT_PARAMS, 9, 25).strongDensity).toBe(DEFAULT_PARAMS.strongDensity); // Gefahrenstellen unabhängig vom Regler
    expect(widthFactor(100)).toBe(1.6);
    expect(widthFactor(5)).toBe(0.8);
    expect(widthFactor(null)).toBe(1);
  });
  it("Regler steuert die Zahl der Stellen", () => {
    const prof = whitewaterProfile(synthStrip(400, [150, 210]));
    const w = typicalWidth(prof.bins);
    expect(w).toBeGreaterThan(15);
    expect(findSpots(prof.bins, tunedParams(DEFAULT_PARAMS, 9, w))).toHaveLength(1);
    expect(findSpots(prof.bins, tunedParams(DEFAULT_PARAMS, 1, w)).length).toBeLessThanOrEqual(1);
  });
  it("leeres Bild (außerhalb des Mosaiks) ist nicht auswertbar", () => {
    const blank = synthStrip(300);
    blank.rgb.fill(255);
    expect(imageUsable(whitewaterProfile(blank).bins)).toBe(false);
    expect(imageUsable(whitewaterProfile(synthStrip(300)).bins)).toBe(true);
  });
});

describe("Eigene Markierungen und lernendes Modell", () => {
  it("Modell trennt Schwall von Kiesbank/ruhig und braucht je 5 Beispiele", async () => {
    const { trainModel, modelProb, modelThreshold, MODEL_MIN } = await import("../src/whitewater");
    const pos = Array.from({ length: 8 }, (_, i) => ({ f: { density: 7 + i, smooth: 0.25 + i * 0.02, width: 20 }, schwall: true }));
    const neg = Array.from({ length: 8 }, (_, i) => ({ f: { density: 0.5 + i * 0.4, smooth: 0.03 + i * 0.01, width: 20 }, schwall: false }));
    expect(trainModel([...pos.slice(0, MODEL_MIN - 1), ...neg])).toBeNull();
    const m = trainModel([...pos, ...neg])!;
    expect(m.acc).toBeGreaterThan(0.8);
    expect(modelProb(m, { density: 10, smooth: 0.3, width: 20 })).toBeGreaterThan(0.7);
    expect(modelProb(m, { density: 1, smooth: 0.05, width: 20 })).toBeLessThan(0.3);
    expect(modelThreshold(5)).toBeCloseTo(0.5, 6);
    expect(modelThreshold(1)).toBeGreaterThan(0.8);
    expect(modelThreshold(9)).toBeLessThan(0.2);
  });

  it("„kein Schwall“ blendet erkannte Stelle aus, eigener Schwall wird ergänzt oder bestätigt – nichts doppelt", async () => {
    const { applyLabels } = await import("../src/whitewater");
    const spot = (d0: number, d1: number) => ({ d0, d1, dPeak: (d0 + d1) / 2, center: [10, 47] as LngLat, peakFrac: 0.3, meanFrac: 0.2, peakDensity: 8, area: 300, width: 20, strong: true, notes: [] as string[] });
    const L = (d: number, schwall: boolean, kind: "schwall" | "kiesbank" = schwall ? "schwall" : "kiesbank", show = true) => ({ label: { p: [10, 47] as LngLat, schwall, kind, grade: schwall ? ("III" as const) : undefined, show }, d, p: [10, 47] as LngLat });
    const out = applyLabels([spot(100, 150), spot(400, 450)], [L(120, false), L(430, true), L(800, true)]);
    expect(out).toHaveLength(2); // 100–150 ausgeblendet, 400–450 bestätigt, 800 neu
    expect(out[0].own?.grade).toBe("III");
    expect(out[0].notes[0]).toMatch(/von dir markiert: Stromschnelle · WW III/);
    expect(out[1].d0).toBe(785);
    expect(out[1].area).toBe(0);
    // Markierungen nur zum Lernen (ohne Häkchen „anzeigen“) ändern die Anzeige nicht
    const learnOnly = applyLabels([spot(100, 150)], [L(120, false, "kiesbank", false), L(800, true, "schwall", false)]);
    expect(learnOnly).toHaveLength(1);
    expect(learnOnly[0].own).toBeUndefined();
  });

  it("Modell nur verwenden, wenn es die feste Schwelle schlägt; alte Modelle ohne Vergleich nicht", async () => {
    const { modelUsable, trainModel } = await import("../src/whitewater");
    expect(modelUsable({ w: [1, 1, 1], b: 0, pos: 20, neg: 14, acc: 0.62, date: "" })).toBe(false); // wie im Browser des Nutzers
    expect(modelUsable({ w: [1, 1, 1], b: 0, pos: 20, neg: 14, acc: 0.6, accFixed: 0.7, date: "" })).toBe(false);
    expect(modelUsable({ w: [1, 1, 1], b: 0, pos: 20, neg: 14, acc: 0.85, accFixed: 0.7, date: "" })).toBe(true);
    const m = trainModel(Array.from({ length: 12 }, (_, i) => ({ f: { density: i < 6 ? 9 + i : 1 + i * 0.1, smooth: i < 6 ? 0.3 : 0.05, width: 20 }, schwall: i < 6 })))!;
    expect(m.accFixed).toBeGreaterThan(0.9);
  });

  it("Export/Import erhält Art, Grad, Merkmale und Modell; alte Dateien bleiben lesbar", () => {
    const labels = [{ p: [10, 47] as LngLat, schwall: true, kind: "walze" as const, grade: "IV" as const, show: true, note: "Rücklauf", date: "2026-11-26", src: "basemap-at", feat: { density: 9, smooth: 0.3, width: 18 } }];
    const model = { w: [1, 2, 3], b: -1, pos: 5, neg: 5, acc: 0.9, date: "2026-11-26" };
    const imp = parseImport(exportJson(labels, DEFAULT_PARAMS, model));
    expect(imp.labels[0]).toMatchObject({ kind: "walze", grade: "IV", show: true, feat: { density: 9 } });
    expect(imp.model?.w).toEqual([1, 2, 3]);
    const old = parseImport(JSON.stringify({ format: "packraft-schwallstellen", version: 1, labels: [{ p: [10, 47], schwall: false }] }));
    expect(old.labels[0]).toMatchObject({ schwall: false });
    expect(old.model).toBeNull();
    // ungültige Kombination (Grad bei „kein Schwall“, Art passt nicht) wird bereinigt
    const bad = parseImport(JSON.stringify({ format: "packraft-schwallstellen", labels: [{ p: [10, 47], schwall: false, kind: "walze", grade: "V" }] }));
    expect(bad.labels[0].kind).toBeUndefined();
    expect(bad.labels[0].grade).toBeUndefined();
  });
});
