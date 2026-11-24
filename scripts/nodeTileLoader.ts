// Tile-Loader für Node (Tests/Skripte): lädt Terrarium-PNGs und dekodiert sie mit pngjs.
import { PNG } from "pngjs";
import { decodeTerrarium, TERRARIUM_URL, type TileLoader } from "../src/dem";

export const nodeTileLoader: TileLoader = async (z, x, y) => {
  const url = TERRARIUM_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  return decodeTerrarium(png.data);
};
