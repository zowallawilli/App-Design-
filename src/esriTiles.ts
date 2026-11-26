// Esri World Imagery ohne graue „Map data not yet available“-Kacheln.
//
// Esri gibt manche Regionen nur bis zu einer bestimmten Kachelstufe heraus (Charyn Canyon, KZ:
// 0,34-m-Bild, aber nur bis Stufe 17). Für feinere Stufen liefert der Dienst ein graues Platzhalterbild.
// Über den dokumentierten Tilemap-Endpunkt des Kacheldienstes prüft die App, ob eine Kachel existiert,
// und vergrößert sonst den passenden Ausschnitt der feinsten vorhandenen Kachel.

export const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
/** Tilemap-Blöcke von 32 × 32 Kacheln (eine Abfrage deckt 1024 Kacheln ab) */
const BLOCK = 32;
/** Ab dieser Stufe wird geprüft (darunter ist die Welt vollständig abgedeckt) */
const CHECK_FROM = 15;
/** höchstens so viele Stufen nach oben ausweichen (Vergrößerung bis 32×) */
const MAX_UP = 5;

export interface TilemapResponse {
  data: number[];
  location?: { left: number; top: number; width: number; height: number };
  valid?: boolean;
}

/** Ist Kachel x/y laut Tilemap-Antwort vorhanden? Unbekannt → true (lieber laden als weglassen). */
export function availableIn(r: TilemapResponse | null, x: number, y: number): boolean {
  if (!r || !Array.isArray(r.data) || !r.data.length) return true;
  if (r.data.length === 1) return r.data[0] !== 0;
  const loc = r.location;
  if (!loc) return true;
  const ix = x - loc.left, iy = y - loc.top;
  if (ix < 0 || iy < 0 || ix >= loc.width || iy >= loc.height) return true;
  return r.data[iy * loc.width + ix] !== 0;
}

/** Ausschnitt einer Vorfahren-Kachel (Stufe z − k), der Kachel z/x/y entspricht (in Pixeln bei 256 px). */
export function ancestorCrop(z: number, x: number, y: number, k: number) {
  const f = 2 ** k;
  const size = 256 / f;
  return { z: z - k, x: Math.floor(x / f), y: Math.floor(y / f), sx: (x % f) * size, sy: (y % f) * size, size };
}

const blocks = new Map<string, Promise<TilemapResponse | null>>();

function tilemap(z: number, x: number, y: number, fetchFn: typeof fetch): Promise<TilemapResponse | null> {
  const left = Math.floor(x / BLOCK) * BLOCK, top = Math.floor(y / BLOCK) * BLOCK;
  const key = `${z}/${top}/${left}`;
  let p = blocks.get(key);
  if (!p) {
    p = fetchFn(`${ESRI_IMAGERY}/tilemap/${z}/${top}/${left}/${BLOCK}/${BLOCK}?f=json`)
      .then((r) => (r.ok ? (r.json() as Promise<TilemapResponse>) : null))
      .catch(() => null);
    blocks.set(key, p);
  }
  return p;
}

export async function tileExists(z: number, x: number, y: number, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (z < CHECK_FROM) return true;
  return availableIn(await tilemap(z, x, y, fetchFn), x, y);
}

/** Wie viele Stufen muss Kachel z/x/y nach oben ausweichen? 0 = vorhanden. */
export async function fallbackLevels(z: number, x: number, y: number, fetchFn: typeof fetch = fetch): Promise<number> {
  for (let k = 0; k <= MAX_UP && z - k >= CHECK_FROM - 1; k++) {
    const c = ancestorCrop(z, x, y, k);
    if (await tileExists(c.z, c.x, c.y, fetchFn)) return k;
  }
  return 0;
}

const tileUrl = (z: number, x: number, y: number) => `${ESRI_IMAGERY}/tile/${z}/${y}/${x}`;

/** Kachel für MapLibre (addProtocol „esri://{z}/{y}/{x}“) laden – bei Bedarf aus gröberer Stufe vergrößert. */
export async function loadEsriTile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const m = /(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) throw new Error(`Kachel-URL unbekannt: ${url}`);
  const [z, y, x] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const k = await fallbackLevels(z, x, y).catch(() => 0);
  const canScale = typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
  if (k === 0 || !canScale) {
    const r = await fetch(tileUrl(z, x, y), { signal });
    if (!r.ok) throw new Error(`Esri-Kachel ${r.status}`);
    return r.arrayBuffer();
  }
  const c = ancestorCrop(z, x, y, k);
  const r = await fetch(tileUrl(c.z, c.x, c.y), { signal });
  if (!r.ok) throw new Error(`Esri-Kachel ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), c.sx, c.sy, c.size, c.size, { resizeWidth: 256, resizeHeight: 256, resizeQuality: "high" });
  const cv = new OffscreenCanvas(256, 256);
  cv.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return (await cv.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer();
}
