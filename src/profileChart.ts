// Längsprofil als SVG mit Hover-Kopplung zur Karte.

import type { Analysis } from "./analysis";
import type { NarrowKind, NarrowsResult } from "./narrows";

const BAND: Record<NarrowKind, string> = { engstelle: "#ff9f1c", schlucht: "#8e44ad", klamm: "#555555" };

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function niceStep(range: number, target: number) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/** Bildabschnitt (Luftbild B1, B2 …) für die Leiste unter dem Profil */
export interface ProfileStretch { d0: number; d1: number; color: string; label: string; title: string }

export interface ProfileOptions {
  /** Klick ins Profil: zu dieser Stationierung springen */
  onSelect?: (d: number) => void;
  /** Bildabschnitte als Leiste unter dem Profil (Datum, Wetter-Tendenz) */
  stretches?: ProfileStretch[];
  onStretch?: (k: number) => void;
}

export function renderProfile(
  container: HTMLElement,
  a: Analysis,
  narrows: NarrowsResult | undefined,
  onHover: (d: number | null) => void,
  whitewater: { d0: number; d1: number; strong: boolean; hazard?: boolean }[] = [],
  opts: ProfileOptions = {},
): { highlight: (d: number | null) => void } {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = container.clientHeight || 220;
  const stretches = opts.stretches ?? [];
  const STRIP = stretches.length ? 18 : 0;
  const m = { l: 48, r: 12, t: 12, b: 34 + STRIP };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "profile-svg", role: "img", "aria-label": "Längsprofil" }, container);

  const zs = a.profile.flatMap((p) => [p.z, p.floor]);
  let zMin = Math.min(...zs), zMax = Math.max(...zs);
  const pad = Math.max(5, (zMax - zMin) * 0.06);
  zMin -= pad; zMax += pad;
  const x = (d: number) => m.l + (d / a.length) * iw;
  const y = (z: number) => m.t + (1 - (z - zMin) / (zMax - zMin)) * ih;

  // Gitter & Achsen
  const g = el("g", { class: "axes" }, svg);
  const zStep = niceStep(zMax - zMin, 4);
  for (let z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(z), y2: y(z), class: "grid" }, g);
    el("text", { x: m.l - 6, y: y(z) + 4, "text-anchor": "end" }, g).textContent = `${Math.round(z)}`;
  }
  const dStep = niceStep(a.length / 1000, 6) * 1000;
  for (let d = 0; d <= a.length + 1; d += dStep) {
    el("text", { x: x(d), y: H - m.b + STRIP + 16, "text-anchor": "middle" }, g).textContent = `${(d / 1000).toFixed(dStep < 1000 ? 1 : 0)}`;
  }
  el("text", { x: W - m.r, y: H - 4, "text-anchor": "end", class: "axis-label" }, g).textContent = "km ab Einstieg";
  el("text", { x: 4, y: m.t + 2, "dominant-baseline": "hanging", class: "axis-label" }, g).textContent = "m ü. M.";

  // Engstellen/Schluchten als Bänder am unteren Rand
  for (const f of narrows?.features ?? []) {
    el("rect", { x: x(f.d0), y: m.t + ih - 10, width: Math.max(3, x(f.d1) - x(f.d0)), height: 10, fill: BAND[f.kind], class: "narrow-mark" }, svg);
    el("rect", { x: x(f.d0), y: m.t, width: Math.max(3, x(f.d1) - x(f.d0)), height: ih, fill: BAND[f.kind], class: "narrow-band" }, svg);
  }


  // Schwallstellen (Weißwasser im Luftbild) als Marken am oberen Rand
  for (const w of whitewater) {
    el("rect", { x: x(w.d0), y: m.t, width: Math.max(3, x(w.d1) - x(w.d0)), height: ih, fill: "#00b4d8", opacity: w.strong ? 0.28 : 0.16 }, svg);
    el("rect", { x: x(w.d0), y: m.t, width: Math.max(3, x(w.d1) - x(w.d0)), height: 8, fill: w.hazard ? "#d62828" : "#0077b6", class: "ww-mark" }, svg);
  }


  // Abschnittsflächen nach Gefälleklasse
  for (const s of a.segments) {
    const pts = a.profile.filter((p) => p.d >= s.d0 - 1e-6 && p.d <= s.d1 + 1e-6);
    if (pts.length < 2) continue;
    const top = pts.map((p) => `${x(p.d)},${y(p.z)}`).join(" ");
    el("polygon", { points: `${x(pts[0].d)},${m.t + ih} ${top} ${x(pts[pts.length - 1].d)},${m.t + ih}`, fill: s.cls.color, class: "seg-area" }, svg);
  }

  // Rohdaten und geglättetes Profil
  el("polyline", { points: a.profile.map((p) => `${x(p.d)},${y(p.floor)}`).join(" "), class: "raw-line" }, svg);
  el("polyline", { points: a.profile.map((p) => `${x(p.d)},${y(p.z)}`).join(" "), class: "z-line" }, svg);

  // Bildabschnitte (Aufnahmedatum + Wetter-Tendenz) als Leiste direkt unter dem Profil
  const stripG = el("g", { class: "img-strip" }, svg);
  stretches.forEach((st, k) => {
    const g2 = el("g", { class: "img-stretch", "data-k": k, tabindex: 0, role: "button" }, stripG);
    el("title", {}, g2).textContent = st.title;
    const x0 = x(st.d0), w = Math.max(3, x(st.d1) - x0 - 1);
    el("rect", { x: x0, y: m.t + ih + 3, width: w, height: STRIP - 4, rx: 3, fill: st.color }, g2);
    // Text nur, soweit er in den Abschnitt passt (ca. 6 px je Zeichen)
    const room = Math.floor((w - 6) / 6);
    if (room >= 2) {
      const txt = st.label.length <= room ? st.label : st.label.slice(0, room - 1) + "…";
      el("text", { x: x0 + 4, y: m.t + ih + 3 + (STRIP - 4) / 2, "dominant-baseline": "central", class: "img-stretch-label" }, g2).textContent = txt;
    }
    const go = () => opts.onStretch?.(k);
    g2.addEventListener("click", go);
    g2.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") go(); });
  });

  // Hover
  const cursor = el("line", { y1: m.t, y2: m.t + ih, class: "cursor", visibility: "hidden" }, svg);
  const tip = el("text", { y: m.t + 14, class: "tip", visibility: "hidden" }, svg);
  const highlight = (d: number | null) => {
    if (d === null) {
      cursor.setAttribute("visibility", "hidden");
      tip.setAttribute("visibility", "hidden");
      return;
    }
    const seg = a.segments.find((s) => d >= s.d0 && d <= s.d1) ?? a.segments[a.segments.length - 1];
    const p = a.profile.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
    const cx = x(d);
    cursor.setAttribute("x1", String(cx));
    cursor.setAttribute("x2", String(cx));
    cursor.setAttribute("visibility", "visible");
    const right = cx > m.l + iw * 0.6;
    tip.setAttribute("x", String(right ? cx - 6 : cx + 6));
    tip.setAttribute("text-anchor", right ? "end" : "start");
    const sec = narrows?.sections.reduce((b, q) => (Math.abs(q.d - d) < Math.abs(b.d - d) ? q : b));
    const width = sec?.width != null ? ` · Breite ~${sec.width} m` : narrows?.satellite ? " · Fluss im Bild nicht sichtbar" : "";
    tip.textContent = `km ${(d / 1000).toFixed(2)} · ${Math.round(p.z)} m · ${seg.gradient.toFixed(1)} m/km${width}`;
    tip.setAttribute("visibility", "visible");
  };
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", class: "profile-hit" }, svg);
  el("title", {}, hit).textContent = "Klick: Karte springt zu dieser Stelle";
  const dAt = (ev: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(a.length, (((ev.clientX - r.left) * (W / r.width) - m.l) / iw) * a.length));
  };
  hit.addEventListener("pointermove", (ev) => {
    const d = dAt(ev);
    highlight(d);
    onHover(d);
  });
  hit.addEventListener("click", (ev) => {
    const d = dAt(ev);
    highlight(d);
    opts.onSelect?.(d);
  });
  hit.addEventListener("pointerleave", () => {
    highlight(null);
    onHover(null);
  });
  return { highlight };
}

/** Steigungsklassen für Wege zu Fuß (Betrag der Steigung in %, über ~100 m gemittelt) */
export const HIKE_GRADES: { max: number; color: string; label: string }[] = [
  { max: 10, color: "#66bd63", label: "< 10 %" },
  { max: 20, color: "#fee08b", label: "10–20 %" },
  { max: 30, color: "#fdae61", label: "20–30 %" },
  { max: 45, color: "#f46d43", label: "30–45 %" },
  { max: Infinity, color: "#a50026", label: "> 45 %" },
];
export const hikeGradeColor = (pct: number) => (HIKE_GRADES.find((g) => Math.abs(pct) < g.max) ?? HIKE_GRADES[HIKE_GRADES.length - 1]).color;

/**
 * Höhenprofil eines Verbindungswegs: Fläche je ~100-m-Abschnitt nach Steigung eingefärbt, Hover/Klick wie beim Fluss.
 * `dist` (m ab Start) und `elev` (m) aus dem Höhenmodell; leicht geglättet (Rasterrauschen).
 */
export function renderHikeProfile(
  container: HTMLElement,
  dist: number[],
  elev: number[],
  onHover: (d: number | null) => void,
  onSelect?: (d: number) => void,
): { highlight: (d: number | null) => void } {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = container.clientHeight || 220;
  const m = { l: 48, r: 12, t: 22, b: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "profile-svg", role: "img", "aria-label": "Höhenprofil Verbindungsweg" }, container);
  const L = dist[dist.length - 1] || 1;
  // gleitender Mittelwert über ±40 m gegen Treppenstufen des Rasters
  const z = elev.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i; j >= 0 && dist[i] - dist[j] <= 40; j--) { s += elev[j]; n++; }
    for (let j = i + 1; j < elev.length && dist[j] - dist[i] <= 40; j++) { s += elev[j]; n++; }
    return s / n;
  });
  let zMin = Math.min(...z), zMax = Math.max(...z);
  const pad = Math.max(10, (zMax - zMin) * 0.08);
  zMin -= pad; zMax += pad;
  const x = (d: number) => m.l + (d / L) * iw;
  const y = (v: number) => m.t + (1 - (v - zMin) / (zMax - zMin)) * ih;

  const g = el("g", { class: "axes" }, svg);
  const zStep = niceStep(zMax - zMin, 4);
  for (let v = Math.ceil(zMin / zStep) * zStep; v <= zMax; v += zStep) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }, g);
    el("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, g).textContent = `${Math.round(v)}`;
  }
  const dStep = niceStep(L / 1000, 6) * 1000;
  for (let d = 0; d <= L + 1; d += dStep) el("text", { x: x(d), y: H - m.b + 16, "text-anchor": "middle" }, g).textContent = `${(d / 1000).toFixed(dStep < 1000 ? 1 : 0)}`;
  el("text", { x: W - m.r, y: H - 4, "text-anchor": "end", class: "axis-label" }, g).textContent = "km ab Start (zu Fuß)";
  el("text", { x: 4, y: m.t - 8, "dominant-baseline": "hanging", class: "axis-label" }, g).textContent = "m ü. M.";

  // Abschnitte ~100 m: Steigung und Farbe
  const chunks: { i0: number; i1: number; pct: number }[] = [];
  let i0 = 0;
  for (let i = 1; i < dist.length; i++)
    if (dist[i] - dist[i0] >= 100 || i === dist.length - 1) {
      const run = dist[i] - dist[i0];
      chunks.push({ i0, i1: i, pct: run > 0 ? ((z[i] - z[i0]) / run) * 100 : 0 });
      i0 = i;
    }
  for (const c of chunks) {
    const top: string[] = [];
    for (let i = c.i0; i <= c.i1; i++) top.push(`${x(dist[i])},${y(z[i])}`);
    el("polygon", { points: `${x(dist[c.i0])},${m.t + ih} ${top.join(" ")} ${x(dist[c.i1])},${m.t + ih}`, fill: hikeGradeColor(c.pct), class: "seg-area hike-area" }, svg);
  }
  el("polyline", { points: z.map((v, i) => `${x(dist[i])},${y(v)}`).join(" "), class: "z-line" }, svg);

  // Legende oben
  let lx = m.l + 70;
  for (const gr of HIKE_GRADES) {
    el("rect", { x: lx, y: 4, width: 10, height: 10, rx: 2, fill: gr.color }, svg);
    el("text", { x: lx + 13, y: 13, class: "axis-label" }, svg).textContent = gr.label;
    lx += 62;
  }

  const cursor = el("line", { y1: m.t, y2: m.t + ih, class: "cursor", visibility: "hidden" }, svg);
  const tip = el("text", { y: m.t + 14, class: "tip", visibility: "hidden" }, svg);
  const idxAt = (d: number) => { let b = 0; for (let i = 0; i < dist.length; i++) if (Math.abs(dist[i] - d) < Math.abs(dist[b] - d)) b = i; return b; };
  const highlight = (d: number | null) => {
    if (d === null) { cursor.setAttribute("visibility", "hidden"); tip.setAttribute("visibility", "hidden"); return; }
    const i = idxAt(d);
    const c = chunks.find((q) => i >= q.i0 && i <= q.i1) ?? chunks[chunks.length - 1];
    const cx = x(d);
    cursor.setAttribute("x1", String(cx));
    cursor.setAttribute("x2", String(cx));
    cursor.setAttribute("visibility", "visible");
    const right = cx > m.l + iw * 0.6;
    tip.setAttribute("x", String(right ? cx - 6 : cx + 6));
    tip.setAttribute("text-anchor", right ? "end" : "start");
    tip.textContent = `km ${(d / 1000).toFixed(2)} · ${Math.round(z[i])} m · ${c ? `${c.pct >= 0 ? "+" : ""}${Math.round(c.pct)} %` : ""}`;
    tip.setAttribute("visibility", "visible");
  };
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", class: "profile-hit" }, svg);
  el("title", {}, hit).textContent = "Klick: Karte springt zu dieser Stelle";
  const dAt = (ev: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(L, (((ev.clientX - r.left) * (W / r.width) - m.l) / iw) * L));
  };
  hit.addEventListener("pointermove", (ev) => { const d = dAt(ev); highlight(d); onHover(d); });
  hit.addEventListener("click", (ev) => { const d = dAt(ev); highlight(d); onSelect?.(d); });
  hit.addEventListener("pointerleave", () => { highlight(null); onHover(null); });
  return { highlight };
}
