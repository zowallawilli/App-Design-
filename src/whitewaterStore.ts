// Eigene Schwallstellen-Markierungen und gelernte Schwellen: im Browser (localStorage) gespeichert,
// als JSON exportier- und importierbar, damit nichts verloren geht.

import { haversine, type LngLat } from "./geo";
import { DEFAULT_PARAMS, type RGBA, type TileDecoder, type WhitewaterLabel, type WhitewaterParams } from "./whitewater";

const KEY_LABELS = "packraft.wwLabels";
const KEY_PARAMS = "packraft.wwParams";
export const EXPORT_FORMAT = "packraft-schwallstellen";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* privater Modus o. Ä. – dann nur für diese Sitzung */
  }
}

export const loadLabels = (): WhitewaterLabel[] => validLabels(read<unknown>(KEY_LABELS, []));
export const saveLabels = (l: WhitewaterLabel[]) => write(KEY_LABELS, l);
export const loadParams = (): WhitewaterParams => validParams(read<unknown>(KEY_PARAMS, null)) ?? { ...DEFAULT_PARAMS };
export const saveParams = (p: WhitewaterParams) => write(KEY_PARAMS, p);

export function exportJson(labels: WhitewaterLabel[], params: WhitewaterParams): string {
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, exported: new Date().toISOString(), params, labels }, null, 1);
}

/** Liest eine exportierte Datei; wirft bei falschem Format. */
export function parseImport(text: string): { labels: WhitewaterLabel[]; params: WhitewaterParams | null } {
  const j = JSON.parse(text) as { format?: string; labels?: unknown; params?: unknown };
  if (j.format !== EXPORT_FORMAT) throw new Error("Keine Schwallstellen-Datei dieser App.");
  return { labels: validLabels(j.labels), params: validParams(j.params) };
}

/** Zusammenführen; Markierungen im Umkreis von 5 m gelten als dieselbe (neuere gewinnt). */
export function mergeLabels(a: WhitewaterLabel[], b: WhitewaterLabel[]): WhitewaterLabel[] {
  const out = [...a];
  for (const l of b) {
    const i = out.findIndex((x) => haversine(x.p, l.p) < 5);
    if (i >= 0) out[i] = l;
    else out.push(l);
  }
  return out;
}

function validLabels(v: unknown): WhitewaterLabel[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is WhitewaterLabel => !!x && Array.isArray(x.p) && x.p.length === 2 && x.p.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) && typeof x.schwall === "boolean")
    .map((x) => ({ p: [x.p[0], x.p[1]] as LngLat, schwall: x.schwall, note: typeof x.note === "string" ? x.note.slice(0, 200) : undefined, date: typeof x.date === "string" ? x.date.slice(0, 10) : undefined }));
}

function validParams(v: unknown): WhitewaterParams | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (k: keyof WhitewaterParams, lo: number, hi: number) => (typeof o[k] === "number" && (o[k] as number) >= lo && (o[k] as number) <= hi ? (o[k] as number) : DEFAULT_PARAMS[k]);
  return { spotDensity: num("spotDensity", 0.5, 20), strongDensity: num("strongDensity", 1, 40), minFrac: num("minFrac", 0, 1), minArea: num("minArea", 0, 5000) };
}

/** Kachelbild im Browser dekodieren (createImageBitmap + Canvas). */
export const browserDecoder: TileDecoder = async (buf: ArrayBuffer): Promise<RGBA> => {
  const bmp = await createImageBitmap(new Blob([buf]));
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
};
