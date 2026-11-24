import { describe, expect, it } from "vitest";
import { flowDirections, traceDownstream, type Grid } from "../src/flow";
import { haversine, type LngLat } from "../src/geo";

// Raster mit V-Tal, das von Nord nach Süd fällt; in der Mitte eine künstliche Senke.
function vValley(w = 64, h = 64): Grid {
  const elev = new Float32Array(w * h);
  const mid = w / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) elev[y * w + x] = 1000 - y * 5 + Math.abs(x + 0.5 - mid) * 20;
  elev[30 * w + 32] = 700; // Senke im Talboden
  return { z: 12, x0: 256 * 2200, y0: 256 * 1460, w, h, elev };
}

function pxToLngLat(g: Grid, cx: number, cy: number): LngLat {
  const n = 256 * 2 ** g.z;
  const px = g.x0 + cx + 0.5, py = g.y0 + cy + 0.5;
  return [(px / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI];
}

describe("flow", () => {
  it("folgt dem Talboden bis zum Ziel, auch über Senken hinweg", () => {
    const g = vValley();
    const dir = flowDirections(g);
    const from = pxToLngLat(g, 20, 2); // am Hang gestartet
    const to = pxToLngLat(g, 32, 60);
    const { line, missM } = traceDownstream(g, dir, from, to);
    expect(missM).toBeLessThan(60);
    // Endpunkt nahe Ziel, Linie verläuft im Talboden (Spalte 32)
    expect(haversine(line[line.length - 1], to)).toBeLessThan(80);
    const valleyLon = pxToLngLat(g, 32, 30)[0];
    const mid = line[Math.floor(line.length / 2)];
    expect(Math.abs(mid[0] - valleyLon)).toBeLessThan(0.00035); // ≤ 1 Pixel
  });
});
