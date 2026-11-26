// Eigene Schwallstellen-Markierungen und gelernte Schwellen: im Browser (localStorage) gespeichert,
// als JSON exportier- und importierbar, damit nichts verloren geht.

import { haversine, type LngLat } from "./geo";
import { DEFAULT_PARAMS, GRADES, LABEL_KINDS, type Grade, type LabelKind, type RGBA, type TileDecoder, type WhitewaterLabel, type WhitewaterParams, type WwModel } from "./whitewater";

const KEY_LABELS = "packraft.wwLabels";
const KEY_PARAMS = "packraft.wwParams";
const KEY_MODEL = "packraft.wwModel";
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
export const loadModel = (): WwModel | null => validModel(read<unknown>(KEY_MODEL, null));
export const saveModel = (m: WwModel | null) => (m ? write(KEY_MODEL, m) : (() => { try { localStorage.removeItem(KEY_MODEL); } catch { /* egal */ } })());

export function exportJson(labels: WhitewaterLabel[], params: WhitewaterParams, model: WwModel | null = null): string {
  return JSON.stringify({ format: EXPORT_FORMAT, version: 2, exported: new Date().toISOString(), params, model, labels }, null, 1);
}

/** Liest eine exportierte Datei; wirft bei falschem Format. */
export function parseImport(text: string): { labels: WhitewaterLabel[]; params: WhitewaterParams | null; model: WwModel | null } {
  const j = JSON.parse(text) as { format?: string; labels?: unknown; params?: unknown; model?: unknown };
  if (j.format !== EXPORT_FORMAT) throw new Error("Keine Schwallstellen-Datei dieser App.");
  return { labels: validLabels(j.labels), params: validParams(j.params), model: validModel(j.model) };
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
    .map((x) => {
      const kind = LABEL_KINDS.find((k) => k.id === x.kind && k.schwall === x.schwall)?.id as LabelKind | undefined;
      const grade = x.schwall && (GRADES as readonly string[]).includes(x.grade as string) ? (x.grade as Grade) : undefined;
      const f = x.feat as Record<string, unknown> | undefined;
      const feat = f && typeof f.density === "number" && typeof f.smooth === "number" && Number.isFinite(f.density) && Number.isFinite(f.smooth)
        ? { density: f.density, smooth: f.smooth, width: typeof f.width === "number" && Number.isFinite(f.width) ? f.width : null } : undefined;
      return {
        p: [x.p[0], x.p[1]] as LngLat, schwall: x.schwall, kind, grade, show: x.show === true ? true : undefined,
        note: typeof x.note === "string" ? x.note.slice(0, 200) : undefined, date: typeof x.date === "string" ? x.date.slice(0, 10) : undefined,
        src: typeof x.src === "string" ? x.src.slice(0, 40) : undefined, feat,
      };
    });
}

function validModel(v: unknown): WwModel | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (!Array.isArray(o.w) || o.w.length !== 3 || !o.w.every(num) || !num(o.b)) return null;
  return { w: o.w as number[], b: o.b as number, pos: num(o.pos) ? (o.pos as number) : 0, neg: num(o.neg) ? (o.neg as number) : 0, acc: num(o.acc) ? (o.acc as number) : 0, accFixed: num(o.accFixed) ? (o.accFixed as number) : undefined, date: typeof o.date === "string" ? o.date.slice(0, 10) : "" };
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
