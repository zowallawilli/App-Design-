// Eigene Markierungen direkt ins GitHub-Repo hochladen (Ordner daten/markierungen/), damit sie für das
// Grundmodell ausgewertet werden können. Braucht einen persönlichen, fein eingeschränkten GitHub-Schlüssel
// (nur dieses Repo, nur „Contents: Read and write“). Der Schlüssel bleibt – wie der NVE-Schlüssel – nur im
// Browser (localStorage) und gelangt nie ins Repo.

export const UPLOAD_REPO = "zowallawilli/App-Design-";
export const UPLOAD_DIR = "daten/markierungen";
const KEY = "packraft.ghToken";

export function ghToken(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function setGhToken(t: string) {
  try { if (t.trim()) localStorage.setItem(KEY, t.trim()); else localStorage.removeItem(KEY); } catch { /* privater Modus */ }
}

/** UTF-8-Text → Base64 (für die GitHub-Contents-API) */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Dateiname mit Zeitstempel (UTC), z. B. markierungen-2026-11-26-1412.json */
export function uploadPath(now = new Date()): string {
  const s = now.toISOString();
  return `${UPLOAD_DIR}/markierungen-${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}.json`;
}

export async function uploadLabels(
  json: string, token: string, opts: { fetchFn?: typeof fetch; now?: Date; count?: number } = {},
): Promise<{ path: string; url: string }> {
  const f = opts.fetchFn ?? fetch;
  const path = uploadPath(opts.now);
  const r = await f(`https://api.github.com/repos/${UPLOAD_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Markierungen aus der App${opts.count !== undefined ? ` (${opts.count})` : ""}`, content: toBase64(json), branch: "main" }),
  });
  if (!r.ok) {
    const why =
      r.status === 401 ? "GitHub-Schlüssel ungültig oder abgelaufen"
      : r.status === 403 || r.status === 404 ? "der GitHub-Schlüssel hat keine Schreibrechte für dieses Repo (Contents: Read and write)"
      : `GitHub meldet Fehler ${r.status}`;
    throw new Error(why);
  }
  const j = (await r.json()) as { content?: { html_url?: string } };
  return { path, url: j.content?.html_url ?? `https://github.com/${UPLOAD_REPO}/blob/main/${path}` };
}
