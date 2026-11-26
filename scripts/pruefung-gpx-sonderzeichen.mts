// Prüfhilfe: GPX mit Sonderzeichen im Flussnamen gegen das GPX-1.1-Schema prüfen.
// Aufruf: npx tsx scripts/pruefung-gpx-sonderzeichen.mts && xmllint --noout --schema tests/e2e/fixtures/gpx.xsd tests/e2e/out/pruefung/export/sonder-*.gpx
import { writeFileSync, mkdirSync } from "node:fs";
import { analyzeRiver } from "../src/analysis";
import { toGpx, toGeoJson } from "../src/export";
import { destination, type LngLat } from "../src/geo";
const o: LngLat = [79.1, 43.36];
const line = [o, destination(o, 3000, 45)];
const a = await analyzeRiver(line, async (pts) => pts.map((p) => 900 - (p[0] - 79.1) * 1e5 * 0.04));
mkdirSync("tests/e2e/out/pruefung/export", { recursive: true });
const names = ["Şarın River", "Soča · Srpenica – Trnovo", "Fluss & Bach <Test> \"Zitat\" 'x'", "Jökulsá á Fjöllum"];
names.forEach((n, i) => {
  writeFileSync(`tests/e2e/out/pruefung/export/sonder-${i}.gpx`, toGpx(a, n, undefined, [], [{ d: 100, center: o, kind: "x", title: "Wehr & <Stufe>", text: "a\"b" }], { steep: true, split: true, kmMarks: true }));
  JSON.parse(toGeoJson(a, n));
});
console.log("ok", names.length);
